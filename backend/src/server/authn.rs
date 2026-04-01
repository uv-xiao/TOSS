use super::*;

pub(super) async fn run_migrations(pool: &PgPool) {
    if let Err(err) = sqlx::migrate!("./migrations").run(pool).await {
        error!("migration failed: {}", err);
        panic!("migration failed");
    }
}

pub(super) async fn seed_default_data(pool: &PgPool) {
    let admin_id = Uuid::parse_str("00000000-0000-0000-0000-000000000100").unwrap();
    let site_admin_org_id = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
    let legacy_member_id = Uuid::parse_str("00000000-0000-0000-0000-000000000101").unwrap();
    let now = Utc::now();

    let _ = sqlx::query(
        "insert into users (id, email, username, display_name, created_at) values ($1, $2, $3, $4, $5)
         on conflict (id) do update set email = excluded.email, username = excluded.username, display_name = excluded.display_name",
    )
    .bind(admin_id)
    .bind("admin@example.com")
    .bind("admin")
    .bind("Administrator")
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

    let _ = sqlx::query("insert into organizations (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing")
        .bind(site_admin_org_id)
        .bind("Site Admins")
        .bind(now)
        .execute(pool)
        .await;
    let _ = sqlx::query(
        "insert into organization_memberships (organization_id, user_id, joined_at, role)
         values ($1, $2, $3, 'owner')
         on conflict (organization_id, user_id) do update set role = 'owner'",
    )
    .bind(site_admin_org_id)
    .bind(admin_id)
    .bind(now)
    .execute(pool)
    .await;

    // Clean up legacy seeded non-admin account from earlier builds.
    let _ = sqlx::query("delete from project_roles where user_id = $1")
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

pub(super) async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "core-api",
    })
}

pub(super) async fn auth_config(State(state): State<AppState>) -> Json<AuthConfigResponse> {
    let settings = load_auth_settings(&state.db, &state.oidc)
        .await
        .unwrap_or_else(|_| defaults_from_env(&state.oidc));
    Json(AuthConfigResponse {
        allow_local_login: settings.allow_local_login,
        allow_local_registration: settings.allow_local_registration,
        allow_oidc: settings.allow_oidc,
        anonymous_mode: settings.anonymous_mode,
        site_name: settings.site_name,
        announcement: settings.announcement,
        issuer: settings.oidc_issuer,
        client_id: settings.oidc_client_id,
        redirect_uri: settings.oidc_redirect_uri,
        groups_claim: settings.oidc_groups_claim,
    })
}

pub(super) async fn local_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LocalLoginInput>,
) -> axum::response::Response {
    let settings = match load_auth_settings(&state.db, &state.oidc).await {
        Ok(s) => s,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Authentication settings are unavailable",
            )
        }
    };
    if !settings.allow_local_login {
        return error_response(
            StatusCode::FORBIDDEN,
            "Local account login is disabled by the administrator",
        );
    }
    let email = input.email.trim().to_lowercase();
    if email.is_empty() || input.password.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Email and password are required");
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
        return error_response(StatusCode::UNAUTHORIZED, "Incorrect email or password");
    };
    let user_id: Uuid = row.get("id");
    let password_hash: String = row.get("password_hash");
    let parsed = match PasswordHash::new(&password_hash) {
        Ok(p) => p,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Account password data is corrupted",
            )
        }
    };
    if Argon2::default()
        .verify_password(input.password.as_bytes(), &parsed)
        .is_err()
    {
        return error_response(StatusCode::UNAUTHORIZED, "Incorrect email or password");
    }
    issue_session_response(&state.db, &headers, user_id).await
}

pub(super) async fn local_register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LocalRegisterInput>,
) -> axum::response::Response {
    let settings = match load_auth_settings(&state.db, &state.oidc).await {
        Ok(s) => s,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Authentication settings are unavailable",
            )
        }
    };
    if !settings.allow_local_registration {
        return error_response(
            StatusCode::FORBIDDEN,
            "Self-registration is disabled by the administrator",
        );
    }
    let email = input.email.trim().to_lowercase();
    if email.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Email is required");
    }
    if !is_valid_email(&email) {
        return error_response(StatusCode::BAD_REQUEST, "Email format is invalid");
    }
    let username = normalize_username(&input.username);
    if username.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Username is required");
    }
    if !is_valid_username(&username) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Username must be 3-32 chars, start/end with letters or numbers, and use only letters, numbers, ., _, -",
        );
    }
    if input.password.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Password is required");
    }
    if input.password.len() < 8 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Password must be at least 8 characters long",
        );
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
        Err(_) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Password hashing failed")
        }
    };
    let user_insert = sqlx::query(
        "insert into users (id, email, username, display_name, created_at)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(user_id)
    .bind(&email)
    .bind(&username)
    .bind(display_name)
    .bind(now)
    .execute(&state.db)
    .await;
    if let Err(err) = user_insert {
        if is_unique_violation(&err, "users_email_key") {
            return error_response(
                StatusCode::CONFLICT,
                "An account with this email already exists",
            );
        }
        if is_unique_violation(&err, "users_username_key") {
            return error_response(StatusCode::CONFLICT, "This username is already taken");
        }
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create the account",
        );
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
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create the account",
        );
    }

    write_audit(
        &state.db,
        Some(user_id),
        "auth.local.register",
        serde_json::json!({"email": email, "username": username}),
    )
    .await;
    issue_session_response(&state.db, &headers, user_id).await
}

pub(super) async fn oidc_login(State(state): State<AppState>) -> axum::response::Response {
    let cookie_secure = env::var("COOKIE_SECURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let settings = match load_auth_settings(&state.db, &state.oidc).await {
        Ok(v) => v,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Authentication settings are unavailable",
            )
        }
    };
    if !settings.allow_oidc {
        return error_response(
            StatusCode::FORBIDDEN,
            "OIDC login is disabled by the administrator",
        );
    }
    let issuer_raw = settings.oidc_issuer.unwrap_or_default();
    let client_id_raw = settings.oidc_client_id.unwrap_or_default();
    let client_secret_raw = settings.oidc_client_secret.unwrap_or_default();
    let redirect_uri_raw = settings.oidc_redirect_uri.unwrap_or_default();
    if issuer_raw.is_empty() || client_id_raw.is_empty() || redirect_uri_raw.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "OIDC is not configured yet. Contact an administrator",
        );
    }
    let issuer = match discovery_issuer(&issuer_raw) {
        Ok(i) => i,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "OIDC issuer URL is invalid"),
    };
    let http_client = match reqwest::Client::builder().redirect(Policy::none()).build() {
        Ok(c) => c,
        Err(_) => {
            return error_response(StatusCode::BAD_GATEWAY, "Failed to initialize OIDC client")
        }
    };
    let provider_metadata = match CoreProviderMetadata::discover_async(issuer, &http_client).await {
        Ok(m) => m,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "OIDC discovery failed"),
    };
    let redirect_uri = match RedirectUrl::new(redirect_uri_raw) {
        Ok(r) => r,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "OIDC redirect URI is invalid"),
    };
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(client_id_raw.clone()),
        Some(ClientSecret::new(client_secret_raw.clone())),
    )
    .set_redirect_uri(redirect_uri);

    if client_id_raw.is_empty() {
        return error_response(StatusCode::BAD_GATEWAY, "OIDC discovery failed");
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

pub(super) async fn oidc_callback(
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
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Authentication settings are unavailable",
            )
        }
    };
    if !settings.allow_oidc {
        return error_response(
            StatusCode::FORBIDDEN,
            "OIDC login is disabled by the administrator",
        );
    }
    let issuer_raw = settings.oidc_issuer.unwrap_or_default();
    let client_id_raw = settings.oidc_client_id.unwrap_or_default();
    let client_secret_raw = settings.oidc_client_secret.unwrap_or_default();
    let redirect_uri_raw = settings.oidc_redirect_uri.unwrap_or_default();
    if issuer_raw.is_empty() || client_id_raw.is_empty() || redirect_uri_raw.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "OIDC is not configured yet. Contact an administrator",
        );
    }
    let callback_state = query.state.clone().unwrap_or_default();
    let cookie_state = jar
        .get("typst_oidc_state")
        .map(|c| c.value().to_string())
        .unwrap_or_default();
    if callback_state.is_empty() || callback_state != cookie_state {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "OIDC login state is invalid or expired",
        );
    }

    let row = sqlx::query("select nonce from oidc_states where state = $1")
        .bind(&callback_state)
        .fetch_optional(&state.db)
        .await;
    let nonce = match row {
        Ok(Some(r)) => r.get::<String, _>("nonce"),
        _ => return error_response(StatusCode::UNAUTHORIZED, "OIDC login state is missing"),
    };

    let issuer = match discovery_issuer(&issuer_raw) {
        Ok(i) => i,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "OIDC issuer URL is invalid"),
    };
    let http_client = match reqwest::Client::builder().redirect(Policy::none()).build() {
        Ok(c) => c,
        Err(_) => {
            return error_response(StatusCode::BAD_GATEWAY, "Failed to initialize OIDC client")
        }
    };
    let provider_metadata = match CoreProviderMetadata::discover_async(issuer, &http_client).await {
        Ok(m) => m,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "OIDC provider is unavailable"),
    };
    let redirect_uri = match RedirectUrl::new(redirect_uri_raw) {
        Ok(r) => r,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "OIDC redirect URI is invalid"),
    };
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(client_id_raw.clone()),
        Some(ClientSecret::new(client_secret_raw)),
    )
    .set_redirect_uri(redirect_uri);
    if client_id_raw.is_empty() {
        return error_response(StatusCode::BAD_GATEWAY, "OIDC provider is unavailable");
    };
    let token_result = match client.exchange_code(AuthorizationCode::new(query.code.clone())) {
        Ok(token_request) => token_request.request_async(&http_client).await,
        Err(_) => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "OIDC authorization code is invalid",
            )
        }
    };
    let tokens = match token_result {
        Ok(t) => t,
        Err(_) => return error_response(StatusCode::UNAUTHORIZED, "OIDC token exchange failed"),
    };
    let id_token = match tokens.id_token() {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "OIDC ID token is missing"),
    };
    let id_token_verifier = client.id_token_verifier();
    let claims: CoreIdTokenClaims = match id_token.claims(&id_token_verifier, &Nonce::new(nonce)) {
        Ok(c) => c.clone(),
        Err(_) => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "OIDC ID token verification failed",
            )
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
    let username_seed = if let Some(username) = claims.preferred_username() {
        username.to_string()
    } else {
        email
            .split('@')
            .next()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("oidc-user")
            .to_string()
    };
    let username_base = sanitize_username_seed(&username_seed);
    let oidc_groups =
        extract_groups_from_id_token(id_token.to_string(), &settings.oidc_groups_claim);

    let mut user_id: Option<Uuid> = None;
    for attempt in 0..6usize {
        let username = oidc_username_candidate(&username_base, attempt);
        let user_row = sqlx::query(
            "insert into users (id, email, username, display_name, created_at, oidc_subject, oidc_issuer)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (oidc_subject) do update set email = excluded.email, display_name = excluded.display_name, oidc_issuer = excluded.oidc_issuer
             returning id",
        )
        .bind(Uuid::new_v4())
        .bind(email.clone())
        .bind(username)
        .bind(display_name.clone())
        .bind(Utc::now())
        .bind(subject.clone())
        .bind(issuer.clone())
        .fetch_one(&state.db)
        .await;
        match user_row {
            Ok(r) => {
                user_id = Some(r.get::<Uuid, _>("id"));
                break;
            }
            Err(err) if is_unique_violation(&err, "users_username_key") => continue,
            Err(_) => {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to provision user account",
                )
            }
        }
    }
    let Some(user_id) = user_id else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to allocate username for OIDC account",
        );
    };
    let _ = sync_user_oidc_groups(&state.db, user_id, &oidc_groups).await;
    let _ = apply_org_group_memberships(&state.db, user_id, &oidc_groups).await;

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

pub(super) async fn auth_me(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> impl IntoResponse {
    let user_id = match authenticated_user_id(&state.db, &headers, &jar).await {
        Ok(id) => id,
        Err(_) => return (StatusCode::UNAUTHORIZED, "No session").into_response(),
    };
    let row = sqlx::query(
        "select id, email, username, display_name
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
        username: row.get("username"),
        display_name: row.get("display_name"),
        session_expires_at: Utc::now() + chrono::Duration::hours(12),
    })
    .into_response()
}

pub(super) async fn auth_logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> impl IntoResponse {
    if let Some(token) = jar.get("typst_session").map(|c| c.value().to_string()) {
        let _ = sqlx::query("delete from auth_sessions where session_token = $1")
            .bind(token)
            .execute(&state.db)
            .await;
    }
    let jar = jar.remove(Cookie::from("typst_session"));
    (jar, StatusCode::NO_CONTENT).into_response()
}

pub(super) async fn issue_session_response(
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
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to issue session");
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

pub(super) fn hash_password(raw: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(raw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub(super) fn is_valid_email(email: &str) -> bool {
    let bytes = email.as_bytes();
    if email.len() < 3 || email.len() > 254 {
        return false;
    }
    let Some(at_index) = bytes.iter().position(|b| *b == b'@') else {
        return false;
    };
    if at_index == 0 || at_index + 1 >= bytes.len() {
        return false;
    }
    let domain = &email[at_index + 1..];
    domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

pub(super) fn normalize_username(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

pub(super) fn is_valid_username(username: &str) -> bool {
    let bytes = username.as_bytes();
    if bytes.len() < 3 || bytes.len() > 32 {
        return false;
    }
    let first = bytes[0];
    let last = bytes[bytes.len() - 1];
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'.' | b'_' | b'-'))
}

pub(super) fn sanitize_username_seed(input: &str) -> String {
    let mut raw = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            raw.push(ch.to_ascii_lowercase());
        } else if matches!(ch, '.' | '_' | '-') {
            raw.push(ch);
        } else {
            raw.push('-');
        }
    }

    let mut collapsed = String::with_capacity(raw.len());
    let mut prev_sep = false;
    for ch in raw.chars() {
        let is_sep = matches!(ch, '.' | '_' | '-');
        if is_sep && (collapsed.is_empty() || prev_sep) {
            continue;
        }
        collapsed.push(ch);
        prev_sep = is_sep;
    }

    while collapsed
        .chars()
        .next()
        .map(|c| !c.is_ascii_alphanumeric())
        .unwrap_or(false)
    {
        collapsed.remove(0);
    }
    while collapsed
        .chars()
        .last()
        .map(|c| !c.is_ascii_alphanumeric())
        .unwrap_or(false)
    {
        collapsed.pop();
    }

    if collapsed.is_empty() {
        collapsed.push_str("user");
    }
    while collapsed.len() < 3 {
        collapsed.push('x');
    }
    if collapsed.len() > 32 {
        collapsed.truncate(32);
        while collapsed
            .chars()
            .last()
            .map(|c| !c.is_ascii_alphanumeric())
            .unwrap_or(false)
        {
            collapsed.pop();
        }
    }
    while collapsed.len() < 3 {
        collapsed.push('x');
    }
    if !is_valid_username(&collapsed) {
        "userxxx".to_string()
    } else {
        collapsed
    }
}

pub(super) fn oidc_username_candidate(base: &str, attempt: usize) -> String {
    if attempt == 0 {
        return base.to_string();
    }
    let suffix = random_token(5).to_ascii_lowercase();
    let max_base_len = 32usize.saturating_sub(1 + suffix.len());
    let trimmed = if base.len() > max_base_len {
        &base[..max_base_len]
    } else {
        base
    };
    let mut candidate = format!("{trimmed}-{suffix}");
    if !is_valid_username(&candidate) {
        candidate = "userxxx".to_string();
    }
    candidate
}

pub(super) fn is_unique_violation(err: &sqlx::Error, constraint: &str) -> bool {
    match err {
        sqlx::Error::Database(db_err) => {
            db_err.code().as_deref() == Some("23505") && db_err.constraint() == Some(constraint)
        }
        _ => false,
    }
}

pub(super) fn defaults_from_env(oidc: &OidcSettings) -> AuthSettings {
    let env_site_name = env::var("SITE_NAME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Typst Collaboration".to_string());
    AuthSettings {
        allow_local_login: true,
        allow_local_registration: true,
        allow_oidc: true,
        anonymous_mode: "off".to_string(),
        site_name: env_site_name,
        announcement: String::new(),
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

pub(super) fn discovery_issuer(input: &str) -> Result<IssuerUrl, ()> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(());
    }
    if let Some(prefix) = trimmed.strip_suffix("/.well-known/openid-configuration") {
        return IssuerUrl::new(prefix.to_string()).map_err(|_| ());
    }
    IssuerUrl::new(trimmed.to_string()).map_err(|_| ())
}

pub(super) async fn load_auth_settings(
    db: &PgPool,
    defaults: &OidcSettings,
) -> Result<AuthSettings, StatusCode> {
    let row = sqlx::query(
        "select allow_local_login, allow_local_registration, allow_oidc, anonymous_mode, site_name, announcement,
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
            anonymous_mode: r.get("anonymous_mode"),
            site_name: r.get("site_name"),
            announcement: r.get("announcement"),
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

pub(super) async fn realtime_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RealtimeAuthResponse>, StatusCode> {
    let user_id = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    Ok(Json(RealtimeAuthResponse { user_id }))
}

pub(super) async fn list_personal_access_tokens(
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

pub(super) async fn create_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(input): Json<CreatePatInput>,
) -> axum::response::Response {
    let user_id = match authenticated_user_id(&state.db, &headers, &jar).await {
        Ok(id) => id,
        Err(_) => return error_response(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    let label = input.label.trim();
    if label.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Token label is required");
    }
    let expires_at = if let Some(raw) = input.expires_at {
        let parsed = match DateTime::parse_from_rfc3339(&raw) {
            Ok(v) => v.with_timezone(&Utc),
            Err(_) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "Invalid expiry time format. Use RFC3339 timestamp",
                )
            }
        };
        if parsed <= Utc::now() {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Token expiry must be in the future",
            );
        }
        Some(parsed)
    } else {
        None
    };
    let token_id = Uuid::new_v4();
    let created_at = Utc::now();
    let plain = format!("tpat_{}", random_token(40));
    let token_prefix = plain.chars().take(12).collect::<String>();
    let token_hash = token_sha256(&plain);
    if sqlx::query(
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
    .is_err()
    {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create personal access token",
        );
    }

    write_audit(
        &state.db,
        Some(user_id),
        "security.token.create",
        serde_json::json!({"token_id": token_id, "label": label}),
    )
    .await;

    Json(CreatePatResponse {
        id: token_id,
        label: label.to_string(),
        token: plain,
        token_prefix,
        created_at,
        expires_at,
    })
    .into_response()
}

pub(super) async fn revoke_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(token_id): Path<Uuid>,
) -> axum::response::Response {
    let user_id = match authenticated_user_id(&state.db, &headers, &jar).await {
        Ok(id) => id,
        Err(_) => return error_response(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
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
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    let Ok(res) = res else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to revoke personal access token",
        );
    };
    if res.rows_affected() == 0 {
        return error_response(StatusCode::NOT_FOUND, "Token not found or already revoked");
    }
    write_audit(
        &state.db,
        Some(user_id),
        "security.token.revoke",
        serde_json::json!({"token_id": token_id}),
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}
