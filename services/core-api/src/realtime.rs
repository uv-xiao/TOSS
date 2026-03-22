use crate::authz::ensure_project_role;
use crate::authz::AccessNeed;
use crate::types::{AppState, CollabEvent};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use chrono::Utc;
use futures::{sink::SinkExt, stream::StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub project_id: Option<String>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let Ok(user_id) = authorize_ws_user(&state, &headers, &query).await else {
        return (StatusCode::UNAUTHORIZED, "Realtime auth failed").into_response();
    };
    let user_name = query.user_name.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, doc_id, user_id, user_name, state))
        .into_response()
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
    let project_id = Uuid::parse_str(project_id).map_err(|_| "invalid project_id".to_string())?;
    let mut auth_headers = headers.clone();
    if let Some(user_id) = &query.user_id {
        let value =
            HeaderValue::from_str(user_id.trim()).map_err(|_| "invalid user_id".to_string())?;
        auth_headers.insert("x-user-id", value);
    }
    let user_id = ensure_project_role(&state.db, &auth_headers, project_id, AccessNeed::Read)
        .await
        .map_err(|_| "forbidden".to_string())?;
    Ok(user_id.to_string())
}

async fn get_or_create_sender(state: &AppState, doc_id: &str) -> broadcast::Sender<CollabEvent> {
    if let Some(sender) = state.realtime_channels.read().await.get(doc_id).cloned() {
        return sender;
    }
    let mut write = state.realtime_channels.write().await;
    if let Some(sender) = write.get(doc_id).cloned() {
        return sender;
    }
    let (tx, _rx) = broadcast::channel(512);
    write.insert(doc_id.to_string(), tx.clone());
    tx
}

async fn handle_socket(
    socket: WebSocket,
    doc_id: String,
    user_id: String,
    user_name: Option<String>,
    state: AppState,
) {
    let sender = get_or_create_sender(&state, &doc_id).await;
    let mut rx = sender.subscribe();
    let (mut ws_tx, mut ws_rx) = socket.split();

    let joined = CollabEvent {
        doc_id: doc_id.clone(),
        user_id: user_id.clone(),
        kind: "presence.join".to_string(),
        payload: serde_json::json!({
            "user_id": user_id,
            "user_name": user_name,
            "auth_kind": "project-scoped"
        }),
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
                let incoming: serde_json::Value = serde_json::from_str(&text_string)
                    .unwrap_or_else(|_| serde_json::json!({ "raw": text_string }));
                let kind = incoming
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("doc.update")
                    .to_string();
                let payload = incoming
                    .get("payload")
                    .cloned()
                    .unwrap_or_else(|| incoming.clone());
                let event = CollabEvent {
                    doc_id: doc_id.clone(),
                    user_id: user_id.clone(),
                    kind,
                    payload,
                    at: Utc::now(),
                };
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
