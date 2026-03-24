async fn git_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitSyncState>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    git_status_by_project(&state.db, project_id).await
}

async fn get_git_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitRemoteConfig>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "select project_id, remote_url, local_path, default_branch from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };

    Ok(Json(GitRemoteConfig {
        project_id: row.get("project_id"),
        remote_url: row.get("remote_url"),
        local_path: row.get("local_path"),
        default_branch: row.get("default_branch"),
    }))
}

async fn git_repo_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitRepoLink>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
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
    Ok(Json(GitRepoLink {
        project_id,
        repo_url: format!("{scheme}://{host}/v1/git/repo/{project_id}"),
    }))
}

async fn upsert_git_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertGitRemoteConfigInput>,
) -> Result<Json<GitRemoteConfig>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let default_branch = input.default_branch.unwrap_or_else(|| "main".to_string());
    let row = sqlx::query(
        "insert into git_repositories (project_id, remote_url, local_path, default_branch, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id) do update set remote_url = excluded.remote_url, default_branch = excluded.default_branch, updated_at = excluded.updated_at
         returning project_id, remote_url, local_path, default_branch",
    )
    .bind(project_id)
    .bind(input.remote_url)
    .bind(project_git_repo_path(project_id).to_string_lossy().to_string())
    .bind(default_branch)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = sqlx::query("update git_sync_states set branch = $2 where project_id = $1")
        .bind(project_id)
        .bind(row.get::<String, _>("default_branch"))
        .execute(&state.db)
        .await;

    write_audit(
        &state.db,
        Some(actor),
        "git.config.upsert",
        serde_json::json!({"project_id": project_id}),
    )
    .await;

    Ok(Json(GitRemoteConfig {
        project_id: row.get("project_id"),
        remote_url: row.get("remote_url"),
        local_path: row.get("local_path"),
        default_branch: row.get("default_branch"),
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

async fn git_pull(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<SyncRequest>,
) -> Result<Json<GitSyncState>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::GitSync).await?;
    let _git_lock = acquire_git_project_lock(&state, project_id).await;
    let config = load_git_config(&state.db, project_id).await?;
    ensure_git_repo_initialized(&config.local_path, &config.default_branch)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    ensure_git_branch_checked_out(&config.local_path, &config.default_branch)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(remote_url) = &config.remote_url {
        let _ = run_git(&config.local_path, &["remote", "remove", "origin"]);
        run_git(&config.local_path, &["remote", "add", "origin", remote_url])
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if let Err(err) = run_git(
            &config.local_path,
            &["fetch", "origin", &config.default_branch],
        ) {
            update_git_sync_state(
                &state.db,
                project_id,
                "pull_failed",
                true,
                Some(Utc::now()),
                None,
            )
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            write_audit(
                &state.db,
                Some(actor),
                "git.pull.failed",
                serde_json::json!({"project_id": project_id, "error": err}),
            )
            .await;
            return Err(StatusCode::CONFLICT);
        }
        if let Err(err) = run_git(
            &config.local_path,
            &["pull", "--rebase", "origin", &config.default_branch],
        ) {
            update_git_sync_state(
                &state.db,
                project_id,
                "pull_conflict",
                true,
                Some(Utc::now()),
                None,
            )
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            write_audit(
                &state.db,
                Some(actor),
                "git.pull.conflict",
                serde_json::json!({"project_id": project_id, "error": err}),
            )
            .await;
            return Err(StatusCode::CONFLICT);
        }
        sync_repo_documents_to_project(&state, project_id, &config.local_path)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    } else {
        return Err(StatusCode::BAD_REQUEST);
    }

    update_git_sync_state(
        &state.db,
        project_id,
        "pulled",
        false,
        Some(Utc::now()),
        None,
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = create_git_bundle_artifact(&state, project_id, &config.local_path, "pull").await;

    write_audit(
        &state.db,
        input.actor_user_id.or(Some(actor)),
        "git.pull",
        serde_json::json!({ "project_id": project_id }),
    )
    .await;

    git_status_by_project(&state.db, project_id).await
}

async fn git_push(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<SyncRequest>,
) -> Result<Json<GitSyncState>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::GitSync).await?;
    let _git_lock = acquire_git_project_lock(&state, project_id).await;
    let config = load_git_config(&state.db, project_id).await?;
    ensure_git_repo_initialized(&config.local_path, &config.default_branch)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    ensure_git_branch_checked_out(&config.local_path, &config.default_branch)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sync_project_documents_to_repo(&state, project_id, &config.local_path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = run_git(&config.local_path, &["add", "."]);
    let _ = run_git(
        &config.local_path,
        &[
            "-c",
            "user.name=Typst Collaboration Server",
            "-c",
            "user.email=noreply@typst-collab.local",
            "commit",
            "-m",
            "Sync from Typst collaboration workspace",
        ],
    );
    if let Some(remote_url) = &config.remote_url {
        let _ = run_git(&config.local_path, &["remote", "remove", "origin"]);
        run_git(&config.local_path, &["remote", "add", "origin", remote_url])
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if let Err(err) = run_git(
            &config.local_path,
            &["push", "origin", &format!("HEAD:{}", config.default_branch)],
        ) {
            update_git_sync_state(
                &state.db,
                project_id,
                "push_failed",
                true,
                None,
                Some(Utc::now()),
            )
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            write_audit(
                &state.db,
                Some(actor),
                "git.push.failed",
                serde_json::json!({"project_id": project_id, "error": err}),
            )
            .await;
            return Err(StatusCode::CONFLICT);
        }
    } else {
        return Err(StatusCode::BAD_REQUEST);
    }

    update_git_sync_state(
        &state.db,
        project_id,
        "pushed",
        false,
        None,
        Some(Utc::now()),
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = create_git_bundle_artifact(&state, project_id, &config.local_path, "push").await;

    write_audit(
        &state.db,
        input.actor_user_id.or(Some(actor)),
        "git.push",
        serde_json::json!({ "project_id": project_id }),
    )
    .await;

    git_status_by_project(&state.db, project_id).await
}

async fn git_http_backend(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    Path((project_id, rest)): Path<(Uuid, String)>,
    body: Bytes,
) -> impl IntoResponse {
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
    let need = if can_push {
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

    if flush_pending_server_commit(&state, project_id, None)
        .await
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to flush server updates",
        )
            .into_response();
    }

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

    let query = uri.query().unwrap_or_default();
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

    let (status, response_headers, response_body) = parse_cgi_http_backend_output(&output.stdout);
    let mut post_sync_error: Option<String> = None;
    if can_push && status.is_success() {
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
                let _ = create_git_bundle_artifact(&state, project_id, &config.local_path, "receive_pack")
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
                post_sync_error = Some(err);
            }
        }
    }

    if let Some(err) = post_sync_error {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Push accepted but server import failed: {err}"),
        )
            .into_response();
    }

    let mut builder = axum::http::Response::builder().status(status);
    for (k, v) in response_headers {
        builder = builder.header(k, v);
    }
    builder
        .body(Body::from(response_body))
        .unwrap_or_else(|_| axum::http::Response::new(Body::from("backend response error")))
}
