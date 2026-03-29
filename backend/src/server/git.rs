#[derive(Clone)]
enum MergeFileValue {
    Text(String),
    Binary {
        bytes: Vec<u8>,
        content_type: String,
    },
}

fn merge_file_equal(a: &MergeFileValue, b: &MergeFileValue) -> bool {
    match (a, b) {
        (MergeFileValue::Text(x), MergeFileValue::Text(y)) => x == y,
        (
            MergeFileValue::Binary {
                bytes: xb,
                content_type: xc,
            },
            MergeFileValue::Binary {
                bytes: yb,
                content_type: yc,
            },
        ) => xb == yb && xc == yc,
        _ => false,
    }
}

#[derive(Clone)]
struct PushReject {
    reason: String,
}

fn pkt_line(payload: &str) -> Vec<u8> {
    let total_len = payload.len() + 4;
    format!("{total_len:04x}{payload}").into_bytes()
}

fn pkt_line_bytes(payload: &[u8]) -> Vec<u8> {
    let total_len = payload.len() + 4;
    let mut out = format!("{total_len:04x}").into_bytes();
    out.extend_from_slice(payload);
    out
}

fn git_receive_pack_reject_body(ref_name: &str, reason: &str, hints: &[String]) -> Vec<u8> {
    let mut report = Vec::new();
    report.extend(pkt_line("unpack ok\n"));
    report.extend(pkt_line(&format!("ng {ref_name} {reason}\n")));
    report.extend_from_slice(b"0000");

    let mut out = Vec::new();
    for line in hints {
        let mut payload = Vec::with_capacity(1 + line.len());
        payload.push(2u8);
        payload.extend(line.as_bytes());
        out.extend(pkt_line_bytes(&payload));
    }
    let mut report_band = Vec::with_capacity(report.len() + 1);
    report_band.push(1u8);
    report_band.extend(report);
    out.extend(pkt_line_bytes(&report_band));
    out.extend_from_slice(b"0000");
    out
}

fn merge_index_entry_from_text(
    repo: &Repository,
    path: &str,
    content: &str,
) -> Result<IndexEntry, String> {
    let oid = repo.blob(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        file_size: u32::try_from(content.len()).unwrap_or(u32::MAX),
        id: oid,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    })
}

fn three_way_merge_text(
    repo: &Repository,
    path: &str,
    base: &str,
    pushed: &str,
    online: &str,
) -> Result<Option<String>, String> {
    let ancestor = merge_index_entry_from_text(repo, path, base)?;
    let ours = merge_index_entry_from_text(repo, path, pushed)?;
    let theirs = merge_index_entry_from_text(repo, path, online)?;
    let mut opts = MergeFileOptions::new();
    opts.ancestor_label("base")
        .our_label("pushed")
        .their_label("online");
    let merged = repo
        .merge_file_from_index(&ancestor, &ours, &theirs, Some(&mut opts))
        .map_err(|e| e.to_string())?;
    if !merged.is_automergeable() {
        return Ok(None);
    }
    let text = std::str::from_utf8(merged.content())
        .map_err(|_| "merged text content is not utf-8".to_string())?
        .to_string();
    Ok(Some(text))
}

async fn state_to_merge_map(
    state: &AppState,
    source: &RevisionStateData,
) -> Result<HashMap<String, MergeFileValue>, StatusCode> {
    let mut out = HashMap::new();
    for (path, content) in source.documents.iter() {
        out.insert(path.clone(), MergeFileValue::Text(content.clone()));
    }
    for (path, asset) in source.assets.iter() {
        let bytes = stored_asset_bytes(state, asset).await?;
        out.insert(
            path.clone(),
            MergeFileValue::Binary {
                bytes,
                content_type: asset.content_type.clone(),
            },
        );
    }
    Ok(out)
}

fn merge_online_over_pushed(
    repo: &Repository,
    base: &HashMap<String, MergeFileValue>,
    pushed: &HashMap<String, MergeFileValue>,
    online: &HashMap<String, MergeFileValue>,
) -> Result<HashMap<String, MergeFileValue>, Vec<String>> {
    let mut keys: HashSet<String> = HashSet::new();
    keys.extend(base.keys().cloned());
    keys.extend(pushed.keys().cloned());
    keys.extend(online.keys().cloned());

    let mut merged = HashMap::new();
    let mut conflicts = Vec::new();

    for key in keys {
        let base_v = base.get(&key);
        let pushed_v = pushed.get(&key);
        let online_v = online.get(&key);

        let online_changed = match (base_v, online_v) {
            (Some(a), Some(b)) => !merge_file_equal(a, b),
            (None, None) => false,
            _ => true,
        };
        let pushed_changed = match (base_v, pushed_v) {
            (Some(a), Some(b)) => !merge_file_equal(a, b),
            (None, None) => false,
            _ => true,
        };

        let merged_value = if !online_changed {
            pushed_v.cloned()
        } else if !pushed_changed {
            online_v.cloned()
        } else {
            match (base_v, pushed_v, online_v) {
                (
                    Some(MergeFileValue::Text(base_text)),
                    Some(MergeFileValue::Text(pushed_text)),
                    Some(MergeFileValue::Text(online_text)),
                ) => match three_way_merge_text(repo, &key, base_text, pushed_text, online_text) {
                    Ok(Some(merged_text)) => Some(MergeFileValue::Text(merged_text)),
                    Ok(None) => {
                        conflicts.push(key.clone());
                        None
                    }
                    Err(_) => {
                        conflicts.push(key.clone());
                        None
                    }
                },
                (_, Some(a), Some(b)) if merge_file_equal(a, b) => Some(a.clone()),
                (_, None, None) => None,
                _ => {
                    conflicts.push(key.clone());
                    None
                }
            }
        };

        if let Some(value) = merged_value {
            merged.insert(key, value);
        }
    }

    if conflicts.is_empty() {
        Ok(merged)
    } else {
        conflicts.sort();
        Err(conflicts)
    }
}

fn materialize_merge_map_to_dir(
    root: &std::path::Path,
    merged: &HashMap<String, MergeFileValue>,
) -> Result<(), String> {
    for (path, value) in merged.iter() {
        let target = root.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match value {
            MergeFileValue::Text(content) => {
                std::fs::write(&target, content.as_bytes()).map_err(|e| e.to_string())?;
            }
            MergeFileValue::Binary { bytes, .. } => {
                std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

async fn pending_author_trailers(
    db: &PgPool,
    project_id: Uuid,
    force_author: Option<Uuid>,
) -> Result<Vec<String>, String> {
    let mut trailers = Vec::new();
    let author_rows = sqlx::query(
        "select u.display_name, u.email
         from git_pending_authors g
         join users u on u.id = g.user_id
         where g.project_id = $1
         order by g.touched_at asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    for row in author_rows {
        trailers.push(format!(
            "Co-authored-by: {} <{}>",
            row.get::<String, _>("display_name"),
            row.get::<String, _>("email")
        ));
    }
    if trailers.is_empty() {
        if let Some(user_id) = force_author {
            if let Some(row) = sqlx::query("select display_name, email from users where id = $1")
                .bind(user_id)
                .fetch_optional(db)
                .await
                .map_err(|e| e.to_string())?
            {
                trailers.push(format!(
                    "Co-authored-by: {} <{}>",
                    row.get::<String, _>("display_name"),
                    row.get::<String, _>("email")
                ));
            }
        }
    }
    Ok(trailers)
}

async fn git_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitSyncState>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    git_status_by_project(&state.db, project_id).await
}

async fn git_repo_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitRepoLink>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1:8080");
    let scheme = if headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("http")
        == "https"
    {
        "https"
    } else {
        "http"
    };
    let username_hint = sqlx::query("select username from users where id = $1")
        .bind(actor)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|row| row.get::<String, _>("username"))
        .unwrap_or_else(|| format!("user-{}", actor.simple()));
    Ok(Json(GitRepoLink {
        project_id,
        repo_url: format!("{scheme}://{username_hint}@{host}/v1/git/repo/{project_id}"),
    }))
}

async fn git_status_by_project(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Json<GitSyncState>, StatusCode> {
    let row = sqlx::query(
        "select project_id, branch, last_pull_at, last_push_at, has_conflicts, status from git_sync_states where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    match row {
        Some(row) => Ok(Json(GitSyncState {
            project_id: row.get("project_id"),
            branch: row.get("branch"),
            last_pull_at: row.get("last_pull_at"),
            last_push_at: row.get("last_push_at"),
            has_conflicts: row.get("has_conflicts"),
            status: row.get("status"),
        })),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn git_http_backend(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    Path((project_id, rest)): Path<(Uuid, String)>,
    body: Bytes,
) -> impl IntoResponse {
    let query = uri.query().unwrap_or_default();
    let advertises_receive_pack =
        rest.ends_with("info/refs") && query.contains("service=git-receive-pack");
    let advertises_upload_pack =
        rest.ends_with("info/refs") && query.contains("service=git-upload-pack");
    let actor = match git_http_user(&state.db, &headers).await {
        Some(user_id) => user_id,
        None => {
            let mut resp = (StatusCode::UNAUTHORIZED, "Git auth required").into_response();
            resp.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                header::HeaderValue::from_static("Basic realm=\"Typst Git\""),
            );
            return resp;
        }
    };
    let can_push = rest.ends_with("git-receive-pack");
    let is_push_flow = can_push || advertises_receive_pack;
    let is_pull_flow = rest.ends_with("git-upload-pack") || advertises_upload_pack;
    let need = if is_push_flow {
        AccessNeed::GitSync
    } else {
        AccessNeed::Read
    };
    if ensure_project_role_for_user(&state.db, actor, project_id, need)
        .await
        .is_err()
    {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    let _git_lock = acquire_git_project_lock(&state, project_id).await;

    let Ok(config) = load_git_config(&state.db, project_id).await else {
        return (StatusCode::NOT_FOUND, "Git repository config missing").into_response();
    };
    if ensure_git_repo_initialized(&config.local_path, &config.default_branch).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to initialize repo",
        )
            .into_response();
    }
    if ensure_git_branch_checked_out(&config.local_path, &config.default_branch).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to checkout project branch",
        )
            .into_response();
    }
    let head_before = git_head_oid(&config.local_path).ok().flatten();
    let had_pending_sync = sqlx::query(
        "select pending_sync from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .map(|row| row.get::<bool, _>("pending_sync"))
    .unwrap_or(false);
    if is_pull_flow && had_pending_sync {
        if let Err(err) = flush_pending_server_commit(&state, project_id, Some(actor)).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to prepare pending online updates: {err}"),
            )
                .into_response();
        }
    }

    let path_info = if rest.is_empty() {
        format!("/{}/.git", project_id)
    } else {
        format!("/{}/.git/{}", project_id, rest)
    };
    let mut command = Command::new("git");
    command.arg("http-backend");
    command.env(
        "GIT_PROJECT_ROOT",
        git_storage_root().to_string_lossy().to_string(),
    );
    command.env("GIT_HTTP_EXPORT_ALL", "1");
    command.env("REQUEST_METHOD", method.as_str());
    command.env("PATH_INFO", path_info);
    command.env("QUERY_STRING", query);
    command.env(
        "CONTENT_TYPE",
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or(""),
    );
    command.env("CONTENT_LENGTH", body.len().to_string());
    command.env("REMOTE_USER", actor.to_string());
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let Ok(mut child) = command.spawn() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to spawn git http-backend",
        )
            .into_response();
    };
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(&body);
    }
    let Ok(output) = child.wait_with_output() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "git http-backend failed").into_response();
    };
    if !output.status.success() && output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("git http-backend exited with failure: {stderr}"),
        )
            .into_response();
    }

    let (status, response_headers, response_body) = parse_cgi_http_backend_output(&output.stdout);
    let mut post_sync_error: Option<PushReject> = None;
    if can_push && status.is_success() {
        let head_after = git_head_oid(&config.local_path).ok().flatten();
        if let (Some(old_head), Some(new_head)) = (head_before, head_after) {
            if !git_ancestor(&config.local_path, old_head, new_head).unwrap_or(false) {
                let _ = git_hard_reset_to(&config.local_path, old_head);
                post_sync_error = Some(PushReject {
                    reason: "forced push prohibited".to_string(),
                });
            }
        }

        if post_sync_error.is_none() && had_pending_sync {
            let merge_result: Result<HashMap<String, MergeFileValue>, String> = async {
                let old_head = head_before.ok_or_else(|| "missing old head".to_string())?;
                let new_head = head_after.ok_or_else(|| "missing new head".to_string())?;
                let (base_state, pushed_state) = {
                    let repo = Repository::open(&config.local_path).map_err(|e| e.to_string())?;
                    let base_commit = repo.find_commit(old_head).map_err(|e| e.to_string())?;
                    let pushed_commit = repo.find_commit(new_head).map_err(|e| e.to_string())?;
                    let base_state = load_git_state_from_commit(&repo, &base_commit)?;
                    let pushed_state = load_git_state_from_commit(&repo, &pushed_commit)?;
                    (base_state, pushed_state)
                };
                let online_state = load_project_state(&state.db, project_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let base_map = state_to_merge_map(&state, &base_state)
                    .await
                    .map_err(|_| "failed to load base state bytes".to_string())?;
                let pushed_map = state_to_merge_map(&state, &pushed_state)
                    .await
                    .map_err(|_| "failed to load pushed state bytes".to_string())?;
                let online_map = state_to_merge_map(&state, &online_state)
                    .await
                    .map_err(|_| "failed to load online state bytes".to_string())?;
                let repo = Repository::open(&config.local_path).map_err(|e| e.to_string())?;
                merge_online_over_pushed(&repo, &base_map, &pushed_map, &online_map).map_err(
                    |conflicts| {
                        format!(
                            "server has uncommitted updates that conflict with pushed commits: {}",
                            conflicts.into_iter().take(8).collect::<Vec<_>>().join(", ")
                        )
                    },
                )
            }
            .await;

            match merge_result {
                Ok(merged_map) => {
                    let temp_dir = match tempfile::tempdir() {
                        Ok(dir) => dir,
                        Err(err) => {
                            return (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                format!("failed to create merge temp dir: {err}"),
                            )
                                .into_response();
                        }
                    };
                    if let Err(err) = materialize_merge_map_to_dir(temp_dir.path(), &merged_map) {
                        post_sync_error = Some(PushReject { reason: err });
                    } else if let Err(err) = sync_repo_documents_to_project(
                        &state,
                        project_id,
                        &temp_dir.path().to_string_lossy(),
                    )
                    .await
                    {
                        post_sync_error = Some(PushReject { reason: err });
                    } else if let Err(err) =
                        sync_project_documents_to_repo(&state, project_id, &config.local_path).await
                    {
                        post_sync_error = Some(PushReject { reason: err });
                    } else {
                        let is_clean = git_worktree_is_clean(&config.local_path).unwrap_or(false);
                        let _ = sqlx::query(
                            "update git_repositories
                             set pending_sync = $2, last_server_sync_at = $3
                             where project_id = $1",
                        )
                        .bind(project_id)
                        .bind(!is_clean)
                        .bind(Utc::now())
                        .execute(&state.db)
                        .await;
                        if is_clean {
                            let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
                                .bind(project_id)
                                .execute(&state.db)
                                .await;
                        }
                        write_audit(
                            &state.db,
                            Some(actor),
                            "git.receive_pack.accepted.merged_online_delta",
                            serde_json::json!({"project_id": project_id}),
                        )
                        .await;
                    }
                }
                Err(conflict_reason) => {
                    if let Some(old_head) = head_before {
                        let _ = git_hard_reset_to(&config.local_path, old_head);
                    }
                    let _ = sync_project_documents_to_repo(&state, project_id, &config.local_path).await;
                    let trailers = pending_author_trailers(&state.db, project_id, Some(actor))
                        .await
                        .unwrap_or_default();
                    let actor_name = lookup_user_display_name(&state.db, actor)
                        .await
                        .unwrap_or_else(|| "Typst Server".to_string());
                    let actor_email = lookup_user_email(&state.db, actor)
                        .await
                        .unwrap_or_else(|| "noreply@typst-server.local".to_string());
                    let message = if trailers.is_empty() {
                        "Online updates".to_string()
                    } else {
                        format!("Online updates\n\n{}", trailers.join("\n"))
                    };
                    let _ = git_commit_staged_if_changed(
                        &config.local_path,
                        &message,
                        &actor_name,
                        &actor_email,
                    );
                    let _ = sqlx::query(
                        "update git_repositories set pending_sync = false, last_server_sync_at = $2 where project_id = $1",
                    )
                    .bind(project_id)
                    .bind(Utc::now())
                    .execute(&state.db)
                    .await;
                    let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
                        .bind(project_id)
                        .execute(&state.db)
                        .await;
                    post_sync_error = Some(PushReject {
                        reason: format!(
                            "fetch first: server has newer online updates ({conflict_reason})"
                        ),
                    });
                }
            }
        }

        if post_sync_error.is_none() && !had_pending_sync {
            match sync_repo_documents_to_project(&state, project_id, &config.local_path).await {
                Ok(()) => {
                    let _ = sqlx::query(
                        "update git_repositories set pending_sync = false, last_server_sync_at = $2 where project_id = $1",
                    )
                    .bind(project_id)
                    .bind(Utc::now())
                    .execute(&state.db)
                    .await;
                    let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
                        .bind(project_id)
                        .execute(&state.db)
                        .await;
                    write_audit(
                        &state.db,
                        Some(actor),
                        "git.receive_pack.accepted",
                        serde_json::json!({"project_id": project_id}),
                    )
                    .await;
                    let _ = create_git_bundle_artifact(
                        &state,
                        project_id,
                        &config.local_path,
                        "receive_pack",
                    )
                    .await;
                }
                Err(err) => {
                    let _ = update_git_sync_state(
                        &state.db,
                        project_id,
                        "receive_pack_import_failed",
                        true,
                        None,
                        Some(Utc::now()),
                    )
                    .await;
                    write_audit(
                        &state.db,
                        Some(actor),
                        "git.receive_pack.import_failed",
                        serde_json::json!({
                            "project_id": project_id,
                            "error": err
                        }),
                    )
                    .await;
                    post_sync_error = Some(PushReject { reason: err });
                }
            }
        }
    }

    if let Some(reject) = post_sync_error {
        if can_push {
            let ref_name = format!("refs/heads/{}", config.default_branch);
            let hint_lines = if reject.reason == "forced push prohibited" {
                vec![
                    "error: forced push prohibited\n".to_string(),
                    "\n".to_string(),
                    "hint: You can't git push --force to this Typst project. Rebase or merge on top of current head.\n".to_string(),
                ]
            } else if reject.reason.starts_with("fetch first:") {
                vec![
                    "error: push rejected because server has newer online updates\n".to_string(),
                    "hint: Pull latest changes, rebase/merge your local commit, then push again.\n".to_string(),
                ]
            } else {
                vec![format!("error: {}\n", reject.reason)]
            };
            let body = git_receive_pack_reject_body(&ref_name, &reject.reason, &hint_lines);
            let mut builder = axum::http::Response::builder().status(StatusCode::OK);
            builder = builder.header(
                header::CONTENT_TYPE,
                "application/x-git-receive-pack-result",
            );
            builder = builder.header("Cache-Control", "no-cache");
            return builder
                .body(Body::from(body))
                .unwrap_or_else(|_| {
                    axum::http::Response::new(Body::from("backend response error"))
                });
        }
        return (StatusCode::CONFLICT, format!("Push rejected: {}", reject.reason)).into_response();
    }

    let mut builder = axum::http::Response::builder().status(status);
    for (k, v) in response_headers {
        builder = builder.header(k, v);
    }
    builder
        .body(Body::from(response_body))
        .unwrap_or_else(|_| axum::http::Response::new(Body::from("backend response error")))
}
