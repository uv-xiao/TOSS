use crate::authz::ensure_project_access;
use crate::authz::AccessNeed;
use crate::types::{AppState, CollabEvent};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Utc;
use futures::{sink::SinkExt, stream::StreamExt};
use serde::Deserialize;
use sqlx::{PgPool, Row};
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub project_id: Option<String>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub session_token: Option<String>,
    pub share_token: Option<String>,
    pub guest_session: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct WsAuth {
    project_id: Uuid,
    user_id: Option<Uuid>,
    effective_id: Uuid,
    can_write: bool,
}

#[derive(Debug)]
struct CollabBootstrapState {
    snapshot_payload: Option<Vec<u8>>,
    updates: Vec<(String, Vec<u8>)>,
}

fn doc_path_from_ws_doc_id(project_id: Uuid, doc_id: &str) -> Option<String> {
    let project_prefix = format!("{project_id}:");
    doc_id
        .strip_prefix(&project_prefix)
        .map(|value| value.to_string())
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let Ok(auth) = authorize_ws_user(&state, &headers, &query).await else {
        return (StatusCode::UNAUTHORIZED, "Realtime auth failed").into_response();
    };
    let user_name = query.user_name.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, doc_id, auth, user_name, state))
        .into_response()
}

async fn authorize_ws_user(
    state: &AppState,
    headers: &HeaderMap,
    query: &WsQuery,
) -> Result<WsAuth, String> {
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
    if let Some(session_token) = &query.session_token {
        let value = HeaderValue::from_str(&format!("typst_session={}", session_token.trim()))
            .map_err(|_| "invalid session_token".to_string())?;
        auth_headers.insert("cookie", value);
    }
    if let Some(share_token) = &query.share_token {
        let value =
            HeaderValue::from_str(share_token.trim()).map_err(|_| "invalid share_token".to_string())?;
        auth_headers.insert("x-share-token", value);
    }
    if let Some(guest_session) = &query.guest_session {
        let value = HeaderValue::from_str(guest_session.trim())
            .map_err(|_| "invalid guest_session".to_string())?;
        auth_headers.insert("x-guest-session", value);
    }
    let principal = ensure_project_access(&state.db, &auth_headers, project_id, AccessNeed::Read)
        .await
        .map_err(|_| "forbidden".to_string())?;
    let effective_id = principal
        .user_id
        .or(principal.guest_session_id)
        .unwrap_or_else(Uuid::new_v4);
    Ok(WsAuth {
        project_id,
        user_id: principal.user_id,
        effective_id,
        can_write: principal.can_write,
    })
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

fn realtime_channel_key(project_id: Uuid, doc_id: &str) -> String {
    format!("{project_id}:{doc_id}")
}

fn collab_update_retention() -> i64 {
    std::env::var("COLLAB_DOC_UPDATE_RETAIN")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 100)
        .unwrap_or(4000)
}

fn collab_bootstrap_limit() -> i64 {
    std::env::var("COLLAB_DOC_BOOTSTRAP_LIMIT")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 100)
        .unwrap_or(8000)
}

fn json_payload_to_bytes(payload: &serde_json::Value) -> Option<Vec<u8>> {
    match payload {
        serde_json::Value::String(text) => BASE64_STANDARD.decode(text).ok(),
        serde_json::Value::Object(map) => map
            .get("payload")
            .and_then(|v| v.as_str())
            .and_then(|text| BASE64_STANDARD.decode(text).ok()),
        _ => None,
    }
}

fn bytes_to_json_payload(bytes: &[u8]) -> serde_json::Value {
    serde_json::Value::String(BASE64_STANDARD.encode(bytes))
}

async fn persist_collab_update(
    db: &PgPool,
    project_id: Uuid,
    doc_id: &str,
    user_id: Option<Uuid>,
    kind: &str,
    payload: &[u8],
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "insert into collab_doc_updates (project_id, doc_id, user_id, kind, payload, created_at)
         values ($1, $2, $3, $4, $5, $6)
         returning id",
    )
    .bind(project_id)
    .bind(doc_id)
    .bind(user_id)
    .bind(kind)
    .bind(payload)
    .bind(Utc::now())
    .fetch_one(db)
    .await?;
    Ok(row.get::<i64, _>("id"))
}

async fn upsert_collab_snapshot(
    db: &PgPool,
    project_id: Uuid,
    doc_id: &str,
    upto_update_id: i64,
    state_update: &[u8],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into collab_doc_latest_snapshots (project_id, doc_id, upto_update_id, state_update, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, doc_id)
         do update set
           upto_update_id = excluded.upto_update_id,
           state_update = excluded.state_update,
           updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(doc_id)
    .bind(upto_update_id)
    .bind(state_update)
    .bind(Utc::now())
    .execute(db)
    .await?;
    Ok(())
}

async fn prune_collab_updates(
    db: &PgPool,
    project_id: Uuid,
    doc_id: &str,
    latest_update_id: i64,
) -> Result<(), sqlx::Error> {
    let retain = collab_update_retention();
    let cutoff = latest_update_id.saturating_sub(retain);
    if cutoff <= 0 {
        return Ok(());
    }
    sqlx::query(
        "delete from collab_doc_updates u
         where u.project_id = $1
           and u.doc_id = $2
           and u.id < $3
           and exists (
             select 1
             from collab_doc_latest_snapshots s
             where s.project_id = $1
               and s.doc_id = $2
               and s.upto_update_id >= $3
           )",
    )
    .bind(project_id)
    .bind(doc_id)
    .bind(cutoff)
    .execute(db)
    .await?;
    Ok(())
}

async fn load_collab_bootstrap(
    db: &PgPool,
    project_id: Uuid,
    doc_id: &str,
) -> Result<CollabBootstrapState, sqlx::Error> {
    if let Some(path) = doc_path_from_ws_doc_id(project_id, doc_id) {
        let document_exists = sqlx::query(
            "select 1
             from documents
             where project_id = $1 and path = $2
             limit 1",
        )
        .bind(project_id)
        .bind(path)
        .fetch_optional(db)
        .await?
        .is_some();
        if document_exists {
            return Ok(CollabBootstrapState {
                snapshot_payload: None,
                updates: Vec::new(),
            });
        }
    }

    let mut snapshot_payload = None;
    let mut snapshot_upto_update_id = 0_i64;

    let snapshot_row = sqlx::query(
        "select upto_update_id, state_update
         from collab_doc_latest_snapshots
         where project_id = $1 and doc_id = $2",
    )
    .bind(project_id)
    .bind(doc_id)
    .fetch_optional(db)
    .await?;
    if let Some(row) = snapshot_row {
        snapshot_upto_update_id = row.get("upto_update_id");
        snapshot_payload = Some(row.get("state_update"));
    } else {
        let sync_row = sqlx::query(
            "select id, payload
             from collab_doc_updates
             where project_id = $1 and doc_id = $2 and kind = 'yjs.sync'
             order by id desc
             limit 1",
        )
        .bind(project_id)
        .bind(doc_id)
        .fetch_optional(db)
        .await?;
        if let Some(row) = sync_row {
            snapshot_upto_update_id = row.get("id");
            snapshot_payload = Some(row.get("payload"));
        }
    }

    let rows = sqlx::query(
        "select kind, payload
         from collab_doc_updates
         where project_id = $1 and doc_id = $2 and id > $3
         order by id asc
         limit $4",
    )
    .bind(project_id)
    .bind(doc_id)
    .bind(snapshot_upto_update_id)
    .bind(collab_bootstrap_limit())
    .fetch_all(db)
    .await?;

    let updates = rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("kind"),
                row.get::<Vec<u8>, _>("payload"),
            )
        })
        .collect();

    Ok(CollabBootstrapState {
        snapshot_payload,
        updates,
    })
}

async fn send_bootstrap_state(
    ws_tx: &mut futures::stream::SplitSink<WebSocket, Message>,
    doc_id: &str,
    user_id: &str,
    state: CollabBootstrapState,
) {
    if let Some(snapshot) = state.snapshot_payload {
        let event = CollabEvent {
            doc_id: doc_id.to_string(),
            user_id: user_id.to_string(),
            kind: "yjs.sync".to_string(),
            payload: bytes_to_json_payload(&snapshot),
            at: Utc::now(),
        };
        if let Ok(text) = serde_json::to_string(&event) {
            let _ = ws_tx.send(Message::Text(text.into())).await;
        }
    }
    for (kind, payload) in state.updates {
        let event = CollabEvent {
            doc_id: doc_id.to_string(),
            user_id: user_id.to_string(),
            kind,
            payload: bytes_to_json_payload(&payload),
            at: Utc::now(),
        };
        if let Ok(text) = serde_json::to_string(&event) {
            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
    }
    let done = CollabEvent {
        doc_id: doc_id.to_string(),
        user_id: "system".to_string(),
        kind: "bootstrap.done".to_string(),
        payload: serde_json::json!({}),
        at: Utc::now(),
    };
    if let Ok(text) = serde_json::to_string(&done) {
        let _ = ws_tx.send(Message::Text(text.into())).await;
    }
}

async fn handle_socket(
    socket: WebSocket,
    doc_id: String,
    auth: WsAuth,
    user_name: Option<String>,
    state: AppState,
) {
    let channel_key = realtime_channel_key(auth.project_id, &doc_id);
    let sender = get_or_create_sender(&state, &channel_key).await;
    let mut rx = sender.subscribe();
    let (mut ws_tx, mut ws_rx) = socket.split();
    let user_id = auth.effective_id.to_string();

    if let Ok(bootstrap) = load_collab_bootstrap(&state.db, auth.project_id, &doc_id).await {
        send_bootstrap_state(&mut ws_tx, &doc_id, &user_id, bootstrap).await;
    }

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
                if kind == "yjs.update" || kind == "yjs.sync" {
                    if !auth.can_write {
                        continue;
                    }
                    if let Some(payload_bytes) = json_payload_to_bytes(&payload) {
                        match persist_collab_update(
                            &state.db,
                            auth.project_id,
                            &doc_id,
                            auth.user_id,
                            &kind,
                            &payload_bytes,
                        )
                        .await
                        {
                            Ok(inserted_id) => {
                                if kind == "yjs.sync" {
                                    if let Err(err) = upsert_collab_snapshot(
                                        &state.db,
                                        auth.project_id,
                                        &doc_id,
                                        inserted_id,
                                        &payload_bytes,
                                    )
                                    .await
                                    {
                                        warn!("failed to upsert collab snapshot: {err}");
                                    }
                                }
                                if let Err(err) = prune_collab_updates(
                                    &state.db,
                                    auth.project_id,
                                    &doc_id,
                                    inserted_id,
                                )
                                .await
                                {
                                    warn!("failed to prune collab updates: {err}");
                                }
                            }
                            Err(err) => {
                                warn!("failed to persist collab update: {err}");
                                let _ = sender.send(CollabEvent {
                                    doc_id: doc_id.clone(),
                                    user_id: "system".to_string(),
                                    kind: "server.error".to_string(),
                                    payload: serde_json::json!({
                                        "message": "Failed to persist collaborative update"
                                    }),
                                    at: Utc::now(),
                                });
                            }
                        }
                    }
                }
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
    if sender.receiver_count() == 0 {
        let mut write = state.realtime_channels.write().await;
        if let Some(existing) = write.get(&channel_key) {
            if existing.same_channel(&sender) && sender.receiver_count() == 0 {
                write.remove(&channel_key);
            }
        }
    }
}
