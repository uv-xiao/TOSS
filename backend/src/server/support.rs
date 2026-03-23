#[derive(Serialize)]
struct ApiErrorResponse {
    error: String,
}

fn error_response(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    let payload = ApiErrorResponse {
        error: message.into(),
    };
    (status, Json(payload)).into_response()
}

fn extract_groups_from_id_token(raw_id_token: String, claim_name: &str) -> Vec<String> {
    let mut groups = Vec::new();
    let claims = decode_jwt_claims(&raw_id_token);
    let Some(claims) = claims else {
        return groups;
    };
    let claim_value = claims.get(claim_name);
    match claim_value {
        Some(serde_json::Value::Array(values)) => {
            for value in values {
                if let Some(group) = value.as_str() {
                    let g = group.trim();
                    if !g.is_empty() {
                        groups.push(g.to_string());
                    }
                }
            }
        }
        Some(serde_json::Value::String(group)) => {
            let g = group.trim();
            if !g.is_empty() {
                groups.push(g.to_string());
            }
        }
        _ => {}
    }
    groups.sort();
    groups.dedup();
    groups
}

fn decode_jwt_claims(raw_token: &str) -> Option<serde_json::Value> {
    let mut parts = raw_token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let bytes = base64::Engine::decode(&URL_SAFE_NO_PAD, payload).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()
}

async fn sync_user_oidc_groups(
    db: &PgPool,
    user_id: Uuid,
    groups: &[String],
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    sqlx::query("delete from user_oidc_groups where user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?;
    for group_name in groups {
        sqlx::query(
            "insert into user_oidc_groups (user_id, group_name, synced_at)
             values ($1, $2, $3)",
        )
        .bind(user_id)
        .bind(group_name)
        .bind(now)
        .execute(db)
        .await?;
    }
    Ok(())
}

fn role_rank(role: &str) -> i32 {
    match role {
        "Owner" => 5,
        "Teacher" => 4,
        "TA" => 3,
        "Student" => 2,
        "Viewer" => 1,
        _ => 0,
    }
}

fn access_type_from_role(role: &str) -> &'static str {
    match role {
        "Viewer" => "read",
        "Student" | "TA" | "Teacher" => "write",
        "Owner" => "manage",
        _ => "read",
    }
}

async fn apply_project_group_roles(
    db: &PgPool,
    user_id: Uuid,
    groups: &[String],
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        "select p.id as project_id, m.group_name, m.role
         from projects p
         join org_oidc_group_role_mappings m on m.organization_id = p.organization_id",
    )
    .fetch_all(db)
    .await?;
    let group_set: HashSet<String> = groups.iter().cloned().collect();
    let mut mapped_projects: HashSet<Uuid> = HashSet::new();
    let mut desired: HashMap<Uuid, String> = HashMap::new();
    for row in rows {
        let group_name: String = row.get("group_name");
        let project_id: Uuid = row.get("project_id");
        mapped_projects.insert(project_id);
        if !group_set.contains(&group_name) {
            continue;
        }
        let role: String = row.get("role");
        let entry = desired.entry(project_id).or_insert_with(|| role.clone());
        if role_rank(&role) > role_rank(entry) {
            *entry = role;
        }
    }

    let current_rows = sqlx::query("select project_id, role from project_roles where user_id = $1")
        .bind(user_id)
        .fetch_all(db)
        .await?;
    let mut current_roles: HashMap<Uuid, String> = HashMap::new();
    for row in current_rows {
        current_roles.insert(row.get("project_id"), row.get("role"));
    }

    for project_id in mapped_projects {
        if let Some(mapped_role) = desired.get(&project_id) {
            let should_write = match current_roles.get(&project_id) {
                Some(existing_role) => existing_role != mapped_role,
                None => true,
            };
            if should_write {
                sqlx::query(
                    "insert into project_roles (project_id, user_id, role, granted_at)
                     values ($1, $2, $3, $4)
                     on conflict (project_id, user_id) do update
                     set role = excluded.role, granted_at = excluded.granted_at",
                )
                .bind(project_id)
                .bind(user_id)
                .bind(mapped_role)
                .bind(Utc::now())
                .execute(db)
                .await?;
            }
        } else {
            sqlx::query(
                "delete from project_roles
                 where project_id = $1 and user_id = $2",
            )
            .bind(project_id)
            .bind(user_id)
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

async fn write_audit(
    db: &PgPool,
    actor_user_id: Option<Uuid>,
    event_type: &str,
    payload: serde_json::Value,
) {
    let _ = sqlx::query(
        "insert into audit_events (id, actor_user_id, event_type, payload, created_at) values ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(actor_user_id)
    .bind(event_type)
    .bind(payload)
    .bind(Utc::now())
    .execute(db)
    .await;
}

struct LoadedGitConfig {
    remote_url: Option<String>,
    local_path: String,
    default_branch: String,
}

async fn load_git_config(db: &PgPool, project_id: Uuid) -> Result<LoadedGitConfig, StatusCode> {
    let row = sqlx::query(
        "select remote_url, local_path, default_branch from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    Ok(LoadedGitConfig {
        remote_url: row.get("remote_url"),
        local_path: row.get("local_path"),
        default_branch: row.get("default_branch"),
    })
}

async fn update_git_sync_state(
    db: &PgPool,
    project_id: Uuid,
    status: &str,
    has_conflicts: bool,
    last_pull_at: Option<DateTime<Utc>>,
    last_push_at: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update git_sync_states
         set status = $2,
             has_conflicts = $3,
             last_pull_at = coalesce($4, last_pull_at),
             last_push_at = coalesce($5, last_push_at)
         where project_id = $1",
    )
    .bind(project_id)
    .bind(status)
    .bind(has_conflicts)
    .bind(last_pull_at)
    .bind(last_push_at)
    .execute(db)
    .await?;
    Ok(())
}

async fn create_git_bundle_artifact(
    state: &AppState,
    project_id: Uuid,
    repo_path: &str,
    event_type: &str,
) -> Result<(), String> {
    let Some(storage) = state.storage.clone() else {
        return Ok(());
    };
    let temp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let bundle_path = temp.path().to_string_lossy().to_string();
    run_git(repo_path, &["bundle", "create", &bundle_path, "--all"])?;
    let bytes = std::fs::read(&bundle_path).map_err(|e| e.to_string())?;
    let artifact_id = Uuid::new_v4();
    let object_key = format!("projects/{project_id}/git-bundles/{artifact_id}.bundle");
    put_object(
        &storage,
        &object_key,
        "application/x-git-bundle",
        bytes.clone(),
    )
    .await?;
    let _ = sqlx::query(
        "insert into git_bundle_artifacts (id, project_id, event_type, object_key, size_bytes, created_at)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(artifact_id)
    .bind(project_id)
    .bind(event_type)
    .bind(object_key)
    .bind(bytes.len() as i64)
    .bind(Utc::now())
    .execute(&state.db)
    .await;
    Ok(())
}

async fn sync_project_documents_to_repo(
    db: &PgPool,
    project_id: Uuid,
    repo_path: &str,
) -> Result<(), String> {
    let rows = sqlx::query("select path, content from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    for row in rows {
        let doc_path: String = row.get("path");
        let content: String = row.get("content");
        let target = sanitize_repo_relative_path(repo_path, &doc_path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn sync_repo_documents_to_project(
    db: &PgPool,
    project_id: Uuid,
    repo_path: &str,
) -> Result<(), String> {
    let repo_files = collect_repo_files(repo_path)?;
    let db_rows = sqlx::query("select id, path from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;

    let mut current: HashMap<String, Uuid> = HashMap::new();
    for row in db_rows {
        current.insert(row.get("path"), row.get("id"));
    }

    let now = Utc::now();
    let repo_paths: HashSet<String> = repo_files.keys().cloned().collect();
    for (path, content) in repo_files {
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, $3, $4, $5)
             on conflict (project_id, path) do update set content = excluded.content, updated_at = excluded.updated_at",
        )
        .bind(Uuid::new_v4())
        .bind(project_id)
        .bind(path)
        .bind(content)
        .bind(now)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    }

    for (path, doc_id) in current {
        if !repo_paths.contains(&path) {
            sqlx::query("delete from documents where project_id = $1 and id = $2")
                .bind(project_id)
                .bind(doc_id)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn lookup_user_display_name(db: &PgPool, user_id: Uuid) -> Option<String> {
    let row = sqlx::query("select display_name from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()??;
    Some(row.get("display_name"))
}

async fn lookup_user_email(db: &PgPool, user_id: Uuid) -> Option<String> {
    let row = sqlx::query("select email from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()??;
    Some(row.get("email"))
}

async fn load_revision_authors(
    db: &PgPool,
    revision_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<RevisionAuthor>>, sqlx::Error> {
    let mut out: HashMap<Uuid, Vec<RevisionAuthor>> = HashMap::new();
    if revision_ids.is_empty() {
        return Ok(out);
    }
    let rows = sqlx::query(
        "select ra.revision_id, u.id as user_id, u.display_name, u.email
         from revision_authors ra
         join users u on u.id = ra.user_id
         where ra.revision_id = any($1::uuid[])
         order by ra.revision_id, u.display_name asc",
    )
    .bind(revision_ids)
    .fetch_all(db)
    .await?;
    for row in rows {
        let revision_id: Uuid = row.get("revision_id");
        out.entry(revision_id).or_default().push(RevisionAuthor {
            user_id: row.get("user_id"),
            display_name: row.get("display_name"),
            email: row.get("email"),
        });
    }
    Ok(out)
}

async fn snapshot_revision_documents(
    db: &PgPool,
    project_id: Uuid,
    revision_id: Uuid,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query("select path, content from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await?;
    for row in rows {
        sqlx::query(
            "insert into revision_documents (revision_id, path, content)
             values ($1, $2, $3)
             on conflict (revision_id, path) do update set content = excluded.content",
        )
        .bind(revision_id)
        .bind(row.get::<String, _>("path"))
        .bind(row.get::<String, _>("content"))
        .execute(db)
        .await?;
    }
    Ok(())
}

async fn mark_project_dirty(db: &PgPool, project_id: Uuid, actor_user_id: Option<Uuid>) {
    let _ = sqlx::query(
        "insert into git_repositories (project_id, remote_url, local_path, default_branch, pending_sync, updated_at)
         values ($1, $2, $3, 'main', true, $4)
         on conflict (project_id) do update set pending_sync = true, updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(Option::<String>::None)
    .bind(project_git_repo_path(project_id).to_string_lossy().to_string())
    .bind(Utc::now())
    .execute(db)
    .await;
    if let Some(user_id) = actor_user_id {
        let _ = sqlx::query(
            "insert into git_pending_authors (project_id, user_id, touched_at)
             values ($1, $2, $3)
             on conflict (project_id, user_id) do update set touched_at = excluded.touched_at",
        )
        .bind(project_id)
        .bind(user_id)
        .bind(Utc::now())
        .execute(db)
        .await;
    }
    let interval_sec = env::var("AUTO_REVISION_INTERVAL_SECONDS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 10)
        .unwrap_or(30);
    let recent_created_at = sqlx::query(
        "select created_at from revisions where project_id = $1 order by created_at desc limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .map(|row| row.get::<DateTime<Utc>, _>("created_at"));
    let should_create = if let Some(created_at) = recent_created_at.as_ref() {
        Utc::now().signed_duration_since(created_at.clone())
            >= chrono::Duration::seconds(interval_sec)
    } else {
        true
    };
    if should_create {
        let revision_id = Uuid::new_v4();
        let now = Utc::now();
        let _ = sqlx::query(
            "insert into revisions (id, project_id, actor_user_id, summary, created_at)
             values ($1, $2, $3, $4, $5)",
        )
        .bind(revision_id)
        .bind(project_id)
        .bind(actor_user_id)
        .bind("Automatic snapshot")
        .bind(now)
        .execute(db)
        .await;
        let _ = snapshot_revision_documents(db, project_id, revision_id).await;
        let authors = if let Some(previous_revision_time) = recent_created_at.as_ref() {
            sqlx::query(
                "select user_id from git_pending_authors
                 where project_id = $1 and touched_at >= $2",
            )
            .bind(project_id)
            .bind(previous_revision_time.clone())
            .fetch_all(db)
            .await
            .ok()
            .unwrap_or_default()
        } else {
            sqlx::query("select user_id from git_pending_authors where project_id = $1")
                .bind(project_id)
                .fetch_all(db)
                .await
                .ok()
                .unwrap_or_default()
        };
        for row in authors {
            let user_id: Uuid = row.get("user_id");
            let _ = sqlx::query(
                "insert into revision_authors (revision_id, user_id)
                 values ($1, $2)
                 on conflict (revision_id, user_id) do nothing",
            )
            .bind(revision_id)
            .bind(user_id)
            .execute(db)
            .await;
        }
        if let Some(user_id) = actor_user_id {
            let _ = sqlx::query(
                "insert into revision_authors (revision_id, user_id)
                 values ($1, $2)
                 on conflict (revision_id, user_id) do nothing",
            )
            .bind(revision_id)
            .bind(user_id)
            .execute(db)
            .await;
        }
    }
}

async fn flush_pending_server_commit(
    db: &PgPool,
    project_id: Uuid,
    force_author: Option<Uuid>,
) -> Result<(), String> {
    let row = sqlx::query(
        "select local_path, default_branch, pending_sync from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Ok(());
    };
    let pending_sync: bool = row.get("pending_sync");
    if !pending_sync {
        return Ok(());
    }
    let local_path: String = row.get("local_path");
    let default_branch: String = row.get("default_branch");
    ensure_git_repo_initialized(&local_path, &default_branch)?;
    ensure_git_branch_checked_out(&local_path, &default_branch)?;
    sync_project_documents_to_repo(db, project_id, &local_path).await?;
    let _ = run_git(&local_path, &["add", "."]);

    let clean = run_git(&local_path, &["status", "--porcelain"]).unwrap_or_default();
    if clean.trim().is_empty() {
        let _ = sqlx::query(
            "update git_repositories set pending_sync = false, last_server_sync_at = $2 where project_id = $1",
        )
        .bind(project_id)
        .bind(Utc::now())
        .execute(db)
        .await;
        let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
            .bind(project_id)
            .execute(db)
            .await;
        return Ok(());
    }

    let author_rows = sqlx::query(
        "select u.display_name, u.email, u.id
         from git_pending_authors g
         join users u on u.id = g.user_id
         where g.project_id = $1
         order by g.touched_at asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    let mut trailers = Vec::new();
    for row in author_rows {
        let name: String = row.get("display_name");
        let email: String = row.get("email");
        trailers.push(format!("Co-authored-by: {} <{}>", name, email));
    }
    if trailers.is_empty() {
        if let Some(user_id) = force_author {
            let u = sqlx::query("select display_name, email from users where id = $1")
                .bind(user_id)
                .fetch_optional(db)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(row) = u {
                trailers.push(format!(
                    "Co-authored-by: {} <{}>",
                    row.get::<String, _>("display_name"),
                    row.get::<String, _>("email")
                ));
            }
        }
    }

    let message = if trailers.is_empty() {
        "Recent updates on Typst server".to_string()
    } else {
        format!("Recent updates on Typst server\n\n{}", trailers.join("\n"))
    };
    let _ = run_git(
        &local_path,
        &[
            "-c",
            "user.name=Typst Server",
            "-c",
            "user.email=noreply@typst-server.local",
            "commit",
            "-m",
            &message,
        ],
    )?;
    let _ = sqlx::query(
        "update git_repositories set pending_sync = false, last_server_sync_at = $2 where project_id = $1",
    )
    .bind(project_id)
    .bind(Utc::now())
    .execute(db)
    .await;
    let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
        .bind(project_id)
        .execute(db)
        .await;
    Ok(())
}

fn parse_cgi_http_backend_output(raw: &[u8]) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n"));
    let Some(idx) = split else {
        return (StatusCode::OK, vec![], raw.to_vec());
    };
    let (head, body) = if raw.get(idx..idx + 4) == Some(b"\r\n\r\n") {
        (&raw[..idx], raw[idx + 4..].to_vec())
    } else {
        (&raw[..idx], raw[idx + 2..].to_vec())
    };
    let mut status = StatusCode::OK;
    let mut headers = Vec::new();
    for line in String::from_utf8_lossy(head).lines() {
        if let Some(rest) = line.strip_prefix("Status:") {
            let code = rest.trim().split_whitespace().next().unwrap_or("200");
            if let Ok(c) = code.parse::<u16>() {
                status = StatusCode::from_u16(c).unwrap_or(StatusCode::OK);
            }
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    (status, headers, body)
}

async fn git_http_user(db: &PgPool, headers: &HeaderMap) -> Option<Uuid> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let basic = auth.strip_prefix("Basic ")?;
    let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, basic).ok()?;
    let creds = String::from_utf8(decoded).ok()?;
    let (_, token) = creds.split_once(':')?;
    let hash = token_sha256(token);
    let row = sqlx::query(
        "select user_id from personal_access_tokens
         where token_hash = $1
           and revoked_at is null
           and (expires_at is null or expires_at > now())",
    )
    .bind(hash)
    .fetch_optional(db)
    .await
    .ok()??;
    let user_id: Uuid = row.get("user_id");
    let _ =
        sqlx::query("update personal_access_tokens set last_used_at = $2 where token_hash = $1")
            .bind(token_sha256(token))
            .bind(Utc::now())
            .execute(db)
            .await;
    Some(user_id)
}

fn random_token(length: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), length)
}

fn token_sha256(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let bytes = hasher.finalize();
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}
