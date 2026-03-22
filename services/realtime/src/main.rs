use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use futures::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<CollabEvent>>>>,
    checkpoint_dir: PathBuf,
    core_api_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CollabEvent {
    doc_id: String,
    user_id: String,
    kind: String,
    payload: serde_json::Value,
    at: DateTime<Utc>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "realtime=info,tower_http=info".into()),
        )
        .init();

    let state = AppState {
        channels: Arc::new(RwLock::new(HashMap::new())),
        checkpoint_dir: env::var("CHECKPOINT_STORAGE_PREFIX")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp/typst-checkpoints")),
        core_api_url: env::var("CORE_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string()),
    };
    let _ = std::fs::create_dir_all(&state.checkpoint_dir);

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/realtime/ws/{doc_id}", get(ws_handler))
        .layer(CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = env::var("REALTIME_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8090);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("realtime service listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "realtime",
    })
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let Ok(user_id) = authorize_ws_user(&state, &headers, &query).await else {
        return (StatusCode::UNAUTHORIZED, "Realtime auth failed").into_response();
    };
    ws.on_upgrade(move |socket| handle_socket(socket, doc_id, user_id, state))
        .into_response()
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    project_id: Option<String>,
    user_id: Option<String>,
    session_token: Option<String>,
}

async fn get_or_create_sender(
    channels: &RwLock<HashMap<String, broadcast::Sender<CollabEvent>>>,
    doc_id: &str,
) -> broadcast::Sender<CollabEvent> {
    if let Some(sender) = channels.read().await.get(doc_id).cloned() {
        return sender;
    }
    let mut write = channels.write().await;
    if let Some(sender) = write.get(doc_id).cloned() {
        return sender;
    }
    let (tx, _rx) = broadcast::channel(512);
    write.insert(doc_id.to_string(), tx.clone());
    tx
}

async fn handle_socket(socket: WebSocket, doc_id: String, user_id: String, state: AppState) {
    let sender = get_or_create_sender(&state.channels, &doc_id).await;
    let mut rx = sender.subscribe();
    let (mut ws_tx, mut ws_rx) = socket.split();
    if let Some(checkpoint) = load_checkpoint(&state.checkpoint_dir, &doc_id) {
        let checkpoint_event = CollabEvent {
            doc_id: doc_id.clone(),
            user_id: "system".to_string(),
            kind: "checkpoint.replay".to_string(),
            payload: checkpoint,
            at: Utc::now(),
        };
        if let Ok(text) = serde_json::to_string(&checkpoint_event) {
            let _ = ws_tx.send(Message::Text(text.into())).await;
        }
    }

    let joined = CollabEvent {
        doc_id: doc_id.clone(),
        user_id: user_id.clone(),
        kind: "presence.join".to_string(),
        payload: serde_json::json!({"user_id": user_id, "auth_kind": "project-scoped"}),
        at: Utc::now(),
    };
    let _ = sender.send(joined);

    let send_task = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let Ok(text) = serde_json::to_string(&event) {
                if ws_tx.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                let text_string = text.to_string();
                let incoming: serde_json::Value =
                    serde_json::from_str(&text_string)
                        .unwrap_or_else(|_| serde_json::json!({ "raw": text_string }));
                let event = CollabEvent {
                    doc_id: doc_id.clone(),
                    user_id: user_id.clone(),
                    kind: "doc.update".to_string(),
                    payload: incoming,
                    at: Utc::now(),
                };
                store_checkpoint(&state.checkpoint_dir, &doc_id, &event.payload);
                let _ = sender.send(event);
            }
            Message::Binary(bin) => {
                let event = CollabEvent {
                    doc_id: doc_id.clone(),
                    user_id: user_id.clone(),
                    kind: "doc.update.binary".to_string(),
                    payload: serde_json::json!({ "bytes": bin.len() }),
                    at: Utc::now(),
                };
                store_checkpoint(&state.checkpoint_dir, &doc_id, &event.payload);
                let _ = sender.send(event);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let left = CollabEvent {
        doc_id,
        user_id,
        kind: "presence.leave".to_string(),
        payload: serde_json::json!({}),
        at: Utc::now(),
    };
    let _ = sender.send(left);
    send_task.abort();
}

#[derive(Deserialize)]
struct RealtimeAuthResponse {
    user_id: Uuid,
}

async fn authorize_ws_user(
    state: &AppState,
    headers: &HeaderMap,
    query: &WsQuery,
) -> Result<String, String> {
    let project_id = query
        .project_id
        .as_ref()
        .ok_or_else(|| "missing project_id".to_string())?;
    let project_id = Uuid::parse_str(project_id)
        .map_err(|_| "invalid project_id".to_string())?;
    let url = format!(
        "{}/v1/realtime/auth/{}",
        state.core_api_url.trim_end_matches('/'),
        project_id
    );
    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if let Some(cookie) = headers.get(header::COOKIE).and_then(|h| h.to_str().ok()) {
        request = request.header(header::COOKIE.as_str(), cookie);
    }
    if let Some(authz) = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
    {
        request = request.header(header::AUTHORIZATION.as_str(), authz);
    }
    if let Some(session_token) = &query.session_token {
        request = request.header(
            header::AUTHORIZATION.as_str(),
            format!("Bearer {}", session_token.trim()),
        );
    }
    if let Some(user_id) = &query.user_id {
        request = request.header("x-user-id", user_id.trim());
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("auth status {}", response.status()));
    }
    let body = response
        .json::<RealtimeAuthResponse>()
        .await
        .map_err(|e| e.to_string())?;
    Ok(body.user_id.to_string())
}

fn checkpoint_path(base: &PathBuf, doc_id: &str) -> PathBuf {
    let sanitized = doc_id.replace('/', "_");
    base.join(format!("{sanitized}.json"))
}

fn store_checkpoint(base: &PathBuf, doc_id: &str, payload: &serde_json::Value) {
    let path = checkpoint_path(base, doc_id);
    let body = serde_json::json!({
        "doc_id": doc_id,
        "at": Utc::now(),
        "payload": payload
    });
    let _ = std::fs::write(path, body.to_string());
}

fn load_checkpoint(base: &PathBuf, doc_id: &str) -> Option<serde_json::Value> {
    let path = checkpoint_path(base, doc_id);
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&content).ok()
}
