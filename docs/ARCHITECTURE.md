# Architecture (v1)

## Components

- `apps/web` (Next.js): Workspace UI, collaborative editor shell, client-side Typst compile loop, PDF preview pane.
- `services/core-api` (Rust/Axum + PostgreSQL): Auth config/callback, project metadata, RBAC enforcement, comments/revisions/documents APIs, git sync state APIs, audit log writes.
- `services/realtime` (Rust/Axum WebSocket): Realtime channel for collaboration events and Yjs update payload forwarding.
- `services/realtime` also persists per-doc checkpoint payloads on update and replays last checkpoint when a client reconnects.
- `postgres`: Source of truth for metadata and permissions.
- `minio` (S3-compatible): Intended store for snapshots/assets/git artifacts.

## Realtime path

1. Browser opens websocket to `/v1/realtime/ws/{doc_id}`.
2. Editor state emits Yjs update payloads.
3. Realtime service broadcasts events to all subscribed peers.
4. Clients apply incoming updates and converge.
5. Presence join/leave events are surfaced in the editor header.
6. Latest update payload is checkpointed and replayed to newly connected clients.

## Git sync path

1. Project config stores remote URL + default branch and local mirror path.
2. On push, project documents are materialized into local mirror files, committed, and pushed to remote.
3. On pull, mirror fetch/rebase runs and pulled files are imported back into project documents.

## Permission model (v1)

Project-level roles:

- `Owner`, `Teacher`: manage roles and project controls.
- `TA`: collaborator with git sync rights.
- `Student`: project read/write for document + comment activity.

## Deployment shape

- Single VM, Docker Compose.
- Basic structured logging.
- Backup scripts for PostgreSQL and MinIO.
- Health endpoints at `/health` for core-api and realtime.
