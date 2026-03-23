async fn run_migrations(pool: &PgPool) {
    if let Err(err) = sqlx::migrate!("./migrations").run(pool).await {
        error!("migration failed: {}", err);
        panic!("migration failed");
    }
}

async fn seed_default_data(pool: &PgPool) {
    let org_id = Uuid::parse_str(DEFAULT_ORG_ID).unwrap();
    let project_id = Uuid::parse_str("00000000-0000-0000-0000-000000000010").unwrap();
    let admin_id = Uuid::parse_str("00000000-0000-0000-0000-000000000100").unwrap();
    let legacy_member_id = Uuid::parse_str("00000000-0000-0000-0000-000000000101").unwrap();
    let now = Utc::now();

    let _ = sqlx::query(
        "insert into organizations (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing",
    )
    .bind(org_id)
    .bind("Default Organization")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "insert into users (id, email, display_name, created_at) values ($1, $2, $3, $4)
         on conflict (id) do update set email = excluded.email, display_name = excluded.display_name",
    )
    .bind(admin_id)
    .bind("admin@example.com")
    .bind("Administrator")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query("insert into projects (id, organization_id, owner_user_id, name, description, created_at) values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing")
        .bind(project_id)
        .bind(org_id)
        .bind(admin_id)
        .bind("Sample Project")
        .bind(Some("Realtime Typst collaboration project"))
        .bind(now)
        .execute(pool)
        .await;

    let _ = sqlx::query(
        "insert into org_admins (organization_id, user_id, granted_at) values ($1, $2, $3)
         on conflict (organization_id, user_id) do nothing",
    )
    .bind(org_id)
    .bind(admin_id)
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "insert into organization_memberships (organization_id, user_id, joined_at)
         values ($1, $2, $3)
         on conflict (organization_id, user_id) do nothing",
    )
    .bind(org_id)
    .bind(admin_id)
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "insert into project_settings (project_id, entry_file_path, updated_at) values ($1, $2, $3)
         on conflict (project_id) do nothing",
    )
    .bind(project_id)
    .bind("main.typ")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query("insert into project_roles (project_id, user_id, role, granted_at) values ($1, $2, $3, $4) on conflict (project_id, user_id) do update set role = excluded.role")
        .bind(project_id)
        .bind(admin_id)
        .bind("Owner")
        .bind(now)
        .execute(pool)
        .await;

    let _ = sqlx::query("insert into git_sync_states (project_id, branch, has_conflicts, status) values ($1, $2, $3, $4) on conflict (project_id) do nothing")
        .bind(project_id)
        .bind("main")
        .bind(false)
        .bind("clean")
        .execute(pool)
        .await;

    let _ = sqlx::query(
        "insert into git_repositories (project_id, remote_url, local_path, default_branch, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id) do nothing",
    )
    .bind(project_id)
    .bind(Option::<String>::None)
    .bind(project_git_repo_path(project_id).to_string_lossy().to_string())
    .bind("main")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query("insert into documents (id, project_id, path, content, updated_at) values ($1, $2, $3, $4, $5) on conflict (project_id, path) do nothing")
        .bind(Uuid::parse_str("00000000-0000-0000-0000-000000000201").unwrap())
        .bind(project_id)
        .bind("main.typ")
        .bind("= Sample Document\n\nHello from Typst collaboration.\n")
        .bind(now)
        .execute(pool)
        .await;

    let admin_exists = sqlx::query("select 1 from local_accounts where user_id = $1")
        .bind(admin_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .is_some();
    if !admin_exists {
        let plain = format!("adm_{}", random_token(16));
        if let Ok(hash) = hash_password(&plain) {
            let _ = sqlx::query(
                "insert into local_accounts (user_id, password_hash, created_at, updated_at)
                 values ($1, $2, $3, $4)",
            )
            .bind(admin_id)
            .bind(hash)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await;
            tracing::warn!(
                "INITIAL ADMIN ACCOUNT: email=admin@example.com password={} (shown once, rotate immediately)",
                plain
            );
        }
    }

    // Clean up legacy seeded non-admin account from earlier builds.
    let _ = sqlx::query("delete from project_roles where user_id = $1")
        .bind(legacy_member_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("delete from org_admins where user_id = $1")
        .bind(legacy_member_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("delete from organization_memberships where user_id = $1")
        .bind(legacy_member_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("delete from local_accounts where user_id = $1")
        .bind(legacy_member_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("delete from users where id = $1 and email = 'member@example.com'")
        .bind(legacy_member_id)
        .execute(pool)
        .await;
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "core-api",
    })
}

async fn auth_config(State(state): State<AppState>) -> Json<AuthConfigResponse> {
    let settings = load_auth_settings(&state.db, &state.oidc)
        .await
        .unwrap_or_else(|_| defaults_from_env(&state.oidc));
    Json(AuthConfigResponse {
        allow_local_login: settings.allow_local_login,
        allow_local_registration: settings.allow_local_registration,
        allow_oidc: settings.allow_oidc,
        site_name: settings.site_name,
        issuer: settings.oidc_issuer,
        client_id: settings.oidc_client_id,
        redirect_uri: settings.oidc_redirect_uri,
        groups_claim: settings.oidc_groups_claim,
    })
}

async fn local_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LocalLoginInput>,
) -> axum::response::Response {
    let settings = match load_auth_settings(&state.db, &state.oidc).await {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "auth settings unavailable",
            )
                .into_response()
        }
    };
    if !settings.allow_local_login {
        return (StatusCode::FORBIDDEN, "local login disabled").into_response();
    }
    let email = input.email.trim().to_lowercase();
    if email.is_empty() || input.password.is_empty() {
        return (StatusCode::BAD_REQUEST, "email/password required").into_response();
    }
    let row = sqlx::query(
        "select u.id, la.password_hash
         from users u
         join local_accounts la on la.user_id = u.id
         where lower(u.email) = $1",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    };
    let user_id: Uuid = row.get("id");
    let password_hash: String = row.get("password_hash");
    let parsed = match PasswordHash::new(&password_hash) {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "password hash corrupted").into_response()
        }
    };
    if Argon2::default()
        .verify_password(input.password.as_bytes(), &parsed)
        .is_err()
    {
        return (StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    }
    issue_session_response(&state.db, &headers, user_id).await
}

async fn local_register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LocalRegisterInput>,
) -> axum::response::Response {
    let settings = match load_auth_settings(&state.db, &state.oidc).await {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "auth settings unavailable",
            )
                .into_response()
        }
    };
    if !settings.allow_local_registration {
        return (StatusCode::FORBIDDEN, "local registration disabled").into_response();
    }
    let email = input.email.trim().to_lowercase();
    if email.is_empty() || input.password.len() < 8 {
        return (StatusCode::BAD_REQUEST, "invalid email/password").into_response();
    }
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| email.split('@').next().unwrap_or("user"));
    let user_id = Uuid::new_v4();
    let now = Utc::now();
    let hash = match hash_password(&input.password) {
        Ok(v) => v,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "hashing failed").into_response(),
    };
    let user_insert = sqlx::query(
        "insert into users (id, email, display_name, created_at)
         values ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(&email)
    .bind(display_name)
    .bind(now)
    .execute(&state.db)
    .await;
    if user_insert.is_err() {
        return (StatusCode::CONFLICT, "account already exists").into_response();
    }
    if sqlx::query(
        "insert into local_accounts (user_id, password_hash, created_at, updated_at)
         values ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(hash)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "account creation failed").into_response();
    }

    if let Ok(org_row) = sqlx::query("select id from organizations order by created_at asc limit 1")
        .fetch_optional(&state.db)
        .await
    {
        if let Some(org) = org_row {
            let org_id: Uuid = org.get("id");
            let _ = sqlx::query(
                "insert into organization_memberships (organization_id, user_id, joined_at)
                 values ($1, $2, $3)
                 on conflict (organization_id, user_id) do nothing",
            )
            .bind(org_id)
            .bind(user_id)
            .bind(now)
            .execute(&state.db)
            .await;
            let _ = sqlx::query(
                "insert into org_admins (organization_id, user_id, granted_at)
                 select $1, $2, $3
                 where not exists (select 1 from org_admins where organization_id = $1)",
            )
            .bind(org_id)
            .bind(user_id)
            .bind(now)
            .execute(&state.db)
            .await;
        }
    }

    write_audit(
        &state.db,
        Some(user_id),
        "auth.local.register",
        serde_json::json!({"email": email}),
    )
    .await;
    issue_session_response(&state.db, &headers, user_id).await
}

async fn oidc_login(State(state): State<AppState>) -> axum::response::Response {
    let cookie_secure = env::var("COOKIE_SECURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let settings = match load_auth_settings(&state.db, &state.oidc).await {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "auth settings unavailable",
            )
                .into_response()
        }
    };
    if !settings.allow_oidc {
        return (StatusCode::FORBIDDEN, "OIDC disabled").into_response();
    }
    let issuer_raw = settings.oidc_issuer.unwrap_or_default();
    let client_id_raw = settings.oidc_client_id.unwrap_or_default();
    let client_secret_raw = settings.oidc_client_secret.unwrap_or_default();
    let redirect_uri_raw = settings.oidc_redirect_uri.unwrap_or_default();
    if issuer_raw.is_empty() || client_id_raw.is_empty() || redirect_uri_raw.is_empty() {
        return (StatusCode::BAD_REQUEST, "OIDC not configured").into_response();
    }
    let issuer = match discovery_issuer(&issuer_raw) {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid OIDC issuer").into_response(),
    };
    let http_client = match reqwest::Client::builder().redirect(Policy::none()).build() {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC HTTP client failure").into_response(),
    };
    let provider_metadata = match CoreProviderMetadata::discover_async(issuer, &http_client).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC discovery failed").into_response(),
    };
    let redirect_uri = match RedirectUrl::new(redirect_uri_raw) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid redirect URI").into_response(),
    };
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(client_id_raw.clone()),
        Some(ClientSecret::new(client_secret_raw.clone())),
    )
    .set_redirect_uri(redirect_uri);

    if client_id_raw.is_empty() {
        return (StatusCode::BAD_GATEWAY, "OIDC discovery failed").into_response();
    }
    let state_token = random_token(32);
    let nonce_token = random_token(32);
    let now = Utc::now();
    let _ = sqlx::query(
        "insert into oidc_states (state, nonce, created_at) values ($1, $2, $3)
         on conflict (state) do update set nonce = excluded.nonce, created_at = excluded.created_at",
    )
    .bind(&state_token)
    .bind(&nonce_token)
    .bind(now)
    .execute(&state.db)
    .await;

    let (authorize_url, csrf, _nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            move || CsrfToken::new(state_token.clone()),
            move || Nonce::new(nonce_token.clone()),
        )
        .add_scope(Scope::new("openid".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .add_scope(Scope::new("email".to_string()))
        .url();
    let cookie = Cookie::build(("typst_oidc_state", csrf.secret().to_string()))
        .path("/")
        .http_only(true)
        .secure(cookie_secure)
        .same_site(SameSite::Lax)
        .build();
    let mut jar = CookieJar::new();
    jar = jar.add(cookie);
    (jar, Redirect::to(authorize_url.as_ref())).into_response()
}

async fn oidc_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(query): Query<OidcCallbackQuery>,
) -> axum::response::Response {
    let cookie_secure = env::var("COOKIE_SECURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let settings = match load_auth_settings(&state.db, &state.oidc).await {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "auth settings unavailable",
            )
                .into_response()
        }
    };
    if !settings.allow_oidc {
        return (StatusCode::FORBIDDEN, "OIDC disabled").into_response();
    }
    let issuer_raw = settings.oidc_issuer.unwrap_or_default();
    let client_id_raw = settings.oidc_client_id.unwrap_or_default();
    let client_secret_raw = settings.oidc_client_secret.unwrap_or_default();
    let redirect_uri_raw = settings.oidc_redirect_uri.unwrap_or_default();
    if issuer_raw.is_empty() || client_id_raw.is_empty() || redirect_uri_raw.is_empty() {
        return (StatusCode::BAD_REQUEST, "OIDC not configured").into_response();
    }
    let callback_state = query.state.clone().unwrap_or_default();
    let cookie_state = jar
        .get("typst_oidc_state")
        .map(|c| c.value().to_string())
        .unwrap_or_default();
    if callback_state.is_empty() || callback_state != cookie_state {
        return (StatusCode::UNAUTHORIZED, "Invalid OIDC state").into_response();
    }

    let row = sqlx::query("select nonce from oidc_states where state = $1")
        .bind(&callback_state)
        .fetch_optional(&state.db)
        .await;
    let nonce = match row {
        Ok(Some(r)) => r.get::<String, _>("nonce"),
        _ => return (StatusCode::UNAUTHORIZED, "OIDC state not found").into_response(),
    };

    let issuer = match discovery_issuer(&issuer_raw) {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid OIDC issuer").into_response(),
    };
    let http_client = match reqwest::Client::builder().redirect(Policy::none()).build() {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC HTTP client failure").into_response(),
    };
    let provider_metadata = match CoreProviderMetadata::discover_async(issuer, &http_client).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC provider unavailable").into_response(),
    };
    let redirect_uri = match RedirectUrl::new(redirect_uri_raw) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid redirect URI").into_response(),
    };
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(client_id_raw.clone()),
        Some(ClientSecret::new(client_secret_raw)),
    )
    .set_redirect_uri(redirect_uri);
    if client_id_raw.is_empty() {
        return (StatusCode::BAD_GATEWAY, "OIDC provider unavailable").into_response();
    };
    let token_result = match client.exchange_code(AuthorizationCode::new(query.code.clone())) {
        Ok(token_request) => token_request.request_async(&http_client).await,
        Err(_) => return (StatusCode::UNAUTHORIZED, "Invalid authorization code").into_response(),
    };
    let tokens = match token_result {
        Ok(t) => t,
        Err(_) => return (StatusCode::UNAUTHORIZED, "OIDC token exchange failed").into_response(),
    };
    let id_token = match tokens.id_token() {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, "OIDC id_token missing").into_response(),
    };
    let id_token_verifier = client.id_token_verifier();
    let claims: CoreIdTokenClaims = match id_token.claims(&id_token_verifier, &Nonce::new(nonce)) {
        Ok(c) => c.clone(),
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                "OIDC id_token verification failed",
            )
                .into_response()
        }
    };
    let issuer = claims.issuer().url().to_string();
    let subject = claims.subject().as_str().to_string();
    let email = if let Some(e) = claims.email() {
        e.to_string()
    } else {
        format!("{}@oidc.local", subject)
    };
    let display_name = if let Some(username) = claims.preferred_username() {
        username.to_string()
    } else {
        "OIDC User".to_string()
    };
    let oidc_groups =
        extract_groups_from_id_token(id_token.to_string(), &settings.oidc_groups_claim);

    let user_row = sqlx::query(
        "insert into users (id, email, display_name, created_at, oidc_subject, oidc_issuer)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (oidc_subject) do update set email = excluded.email, display_name = excluded.display_name, oidc_issuer = excluded.oidc_issuer
         returning id",
    )
    .bind(Uuid::new_v4())
    .bind(email.clone())
    .bind(display_name.clone())
    .bind(Utc::now())
    .bind(subject)
    .bind(issuer)
    .fetch_one(&state.db)
    .await;
    let user_id = match user_row {
        Ok(r) => r.get::<Uuid, _>("id"),
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to upsert user").into_response()
        }
    };
    if let Ok(org_row) = sqlx::query("select id from organizations order by created_at asc limit 1")
        .fetch_optional(&state.db)
        .await
    {
        if let Some(org) = org_row {
            let org_id: Uuid = org.get("id");
            let _ = sqlx::query(
                "insert into organization_memberships (organization_id, user_id, joined_at)
                 values ($1, $2, $3)
                 on conflict (organization_id, user_id) do nothing",
            )
            .bind(org_id)
            .bind(user_id)
            .bind(Utc::now())
            .execute(&state.db)
            .await;
        }
    }
    let _ = sync_user_oidc_groups(&state.db, user_id, &oidc_groups).await;
    let _ = apply_project_group_roles(&state.db, user_id, &oidc_groups).await;

    let token = random_token(48);
    let issued_at = Utc::now();
    let expires_at = issued_at + chrono::Duration::hours(12);
    let _ = sqlx::query(
        "insert into auth_sessions (session_token, user_id, issued_at, expires_at, user_agent, ip_address)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&token)
    .bind(user_id)
    .bind(issued_at)
    .bind(expires_at)
    .bind(
        headers
            .get(header::USER_AGENT)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("unknown"),
    )
    .bind(
        headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("unknown"),
    )
    .execute(&state.db)
    .await;

    let _ = sqlx::query("delete from oidc_states where state = $1")
        .bind(&callback_state)
        .execute(&state.db)
        .await;

    let source = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("unknown");

    write_audit(
        &state.db,
        Some(user_id),
        "auth.oidc.callback",
        serde_json::json!({"state": query.state, "source": source, "email": email, "groups": oidc_groups}),
    )
    .await;

    let session_cookie = Cookie::build(("typst_session", token.clone()))
        .path("/")
        .http_only(true)
        .secure(cookie_secure)
        .same_site(SameSite::Lax)
        .build();
    let mut jar = jar.remove(Cookie::from("typst_oidc_state"));
    jar = jar.add(session_cookie);
    (
        jar,
        Json(SessionResponse {
            session_token: token,
            user_id,
        }),
    )
        .into_response()
}

async fn auth_me(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> impl IntoResponse {
    let user_id = match authenticated_user_id(&state.db, &headers, &jar).await {
        Ok(id) => id,
        Err(_) => return (StatusCode::UNAUTHORIZED, "No session").into_response(),
    };
    let row = sqlx::query(
        "select id, email, display_name
         from users
         where id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::UNAUTHORIZED, "User not found").into_response();
    };
    Json(AuthMeResponse {
        user_id: row.get("id"),
        email: row.get("email"),
        display_name: row.get("display_name"),
        session_expires_at: Utc::now() + chrono::Duration::hours(12),
    })
    .into_response()
}

async fn auth_logout(State(state): State<AppState>, jar: CookieJar) -> impl IntoResponse {
    if let Some(token) = jar.get("typst_session").map(|c| c.value().to_string()) {
        let _ = sqlx::query("delete from auth_sessions where session_token = $1")
            .bind(token)
            .execute(&state.db)
            .await;
    }
    let jar = jar.remove(Cookie::from("typst_session"));
    (jar, StatusCode::NO_CONTENT).into_response()
}

async fn issue_session_response(
    db: &PgPool,
    headers: &HeaderMap,
    user_id: Uuid,
) -> axum::response::Response {
    let cookie_secure = env::var("COOKIE_SECURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let token = random_token(48);
    let issued_at = Utc::now();
    let expires_at = issued_at + chrono::Duration::hours(12);
    let insert = sqlx::query(
        "insert into auth_sessions (session_token, user_id, issued_at, expires_at, user_agent, ip_address)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&token)
    .bind(user_id)
    .bind(issued_at)
    .bind(expires_at)
    .bind(
        headers
            .get(header::USER_AGENT)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("unknown"),
    )
    .bind(
        headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("unknown"),
    )
    .execute(db)
    .await;
    if insert.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "failed to issue session").into_response();
    }
    let session_cookie = Cookie::build(("typst_session", token.clone()))
        .path("/")
        .http_only(true)
        .secure(cookie_secure)
        .same_site(SameSite::Lax)
        .build();
    let mut jar = CookieJar::new();
    jar = jar.add(session_cookie);
    (
        jar,
        Json(SessionResponse {
            session_token: token,
            user_id,
        }),
    )
        .into_response()
}

fn hash_password(raw: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(raw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn defaults_from_env(oidc: &OidcSettings) -> AuthSettings {
    let env_site_name = env::var("SITE_NAME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Typst Collaboration".to_string());
    AuthSettings {
        allow_local_login: true,
        allow_local_registration: true,
        allow_oidc: true,
        site_name: env_site_name,
        oidc_issuer: if oidc.issuer.trim().is_empty() {
            None
        } else {
            Some(oidc.issuer.clone())
        },
        oidc_client_id: if oidc.client_id.trim().is_empty() {
            None
        } else {
            Some(oidc.client_id.clone())
        },
        oidc_client_secret: if oidc.client_secret.trim().is_empty() {
            None
        } else {
            Some(oidc.client_secret.clone())
        },
        oidc_redirect_uri: if oidc.redirect_uri.trim().is_empty() {
            None
        } else {
            Some(oidc.redirect_uri.clone())
        },
        oidc_groups_claim: if oidc.groups_claim.trim().is_empty() {
            "groups".to_string()
        } else {
            oidc.groups_claim.clone()
        },
        updated_at: Utc::now(),
    }
}

fn discovery_issuer(input: &str) -> Result<IssuerUrl, ()> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(());
    }
    if let Some(prefix) = trimmed.strip_suffix("/.well-known/openid-configuration") {
        return IssuerUrl::new(prefix.to_string()).map_err(|_| ());
    }
    IssuerUrl::new(trimmed.to_string()).map_err(|_| ())
}

async fn load_auth_settings(
    db: &PgPool,
    defaults: &OidcSettings,
) -> Result<AuthSettings, StatusCode> {
    let row = sqlx::query(
        "select allow_local_login, allow_local_registration, allow_oidc, site_name,
                oidc_issuer, oidc_client_id, oidc_client_secret, oidc_redirect_uri, oidc_groups_claim, updated_at
         from auth_settings where id = 1",
    )
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(r) = row {
        return Ok(AuthSettings {
            allow_local_login: r.get("allow_local_login"),
            allow_local_registration: r.get("allow_local_registration"),
            allow_oidc: r.get("allow_oidc"),
            site_name: r.get("site_name"),
            oidc_issuer: r.get("oidc_issuer"),
            oidc_client_id: r.get("oidc_client_id"),
            oidc_client_secret: r.get("oidc_client_secret"),
            oidc_redirect_uri: r.get("oidc_redirect_uri"),
            oidc_groups_claim: r.get("oidc_groups_claim"),
            updated_at: r.get("updated_at"),
        });
    }
    Ok(defaults_from_env(defaults))
}

async fn realtime_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RealtimeAuthResponse>, StatusCode> {
    let user_id = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    Ok(Json(RealtimeAuthResponse { user_id }))
}

async fn list_personal_access_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<PersonalAccessTokenListResponse>, StatusCode> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let rows = sqlx::query(
        "select id, label, token_prefix, created_at, expires_at, last_used_at, revoked_at
         from personal_access_tokens
         where user_id = $1
         order by created_at desc",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tokens = rows
        .into_iter()
        .map(|r| PersonalAccessTokenInfo {
            id: r.get("id"),
            label: r.get("label"),
            token_prefix: r.get("token_prefix"),
            created_at: r.get("created_at"),
            expires_at: r.get("expires_at"),
            last_used_at: r.get("last_used_at"),
            revoked_at: r.get("revoked_at"),
        })
        .collect();
    Ok(Json(PersonalAccessTokenListResponse { tokens }))
}

async fn create_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(input): Json<CreatePatInput>,
) -> Result<Json<CreatePatResponse>, StatusCode> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let label = input.label.trim();
    if label.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let expires_at = if let Some(raw) = input.expires_at {
        Some(
            DateTime::parse_from_rfc3339(&raw)
                .map_err(|_| StatusCode::BAD_REQUEST)?
                .with_timezone(&Utc),
        )
    } else {
        None
    };
    let token_id = Uuid::new_v4();
    let created_at = Utc::now();
    let plain = format!("tpat_{}", random_token(40));
    let token_prefix = plain.chars().take(12).collect::<String>();
    let token_hash = token_sha256(&plain);
    sqlx::query(
        "insert into personal_access_tokens (id, user_id, label, token_prefix, token_hash, created_at, expires_at, last_used_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7, null, null)",
    )
    .bind(token_id)
    .bind(user_id)
    .bind(label)
    .bind(&token_prefix)
    .bind(token_hash)
    .bind(created_at)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(user_id),
        "security.token.create",
        serde_json::json!({"token_id": token_id, "label": label}),
    )
    .await;

    Ok(Json(CreatePatResponse {
        id: token_id,
        label: label.to_string(),
        token: plain,
        token_prefix,
        created_at,
        expires_at,
    }))
}

async fn revoke_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(token_id): Path<Uuid>,
) -> Result<StatusCode, StatusCode> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let res = sqlx::query(
        "update personal_access_tokens
         set revoked_at = $3
         where id = $1 and user_id = $2 and revoked_at is null",
    )
    .bind(token_id)
    .bind(user_id)
    .bind(Utc::now())
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if res.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(user_id),
        "security.token.revoke",
        serde_json::json!({"token_id": token_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

