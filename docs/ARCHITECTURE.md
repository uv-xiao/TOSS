# Architecture (v1)

## Components

- `apps/web` (Next.js): Workspace UI, collaborative editor shell, client-side Typst compile loop, PDF preview pane.
- `services/core-api` (Rust/Axum + PostgreSQL): Auth config/callback, project metadata, RBAC enforcement, comments/revisions/documents APIs, git sync state APIs, audit log writes.
- `services/realtime` (Rust/Axum WebSocket): Realtime channel for collaboration events and Yjs update payload forwarding.
- `services/realtime` also persists per-doc checkpoint payloads on update and replays last checkpoint when a client reconnects.
- `postgres`: Source of truth for metadata and permissions.
- `minio` (S3-compatible): Store for snapshots/assets/git bundle artifacts.

## Realtime path

1. Browser opens websocket to `/v1/realtime/ws/{doc_id}?project_id=...`.
2. Realtime service calls core API `/v1/realtime/auth/{project_id}` to validate RBAC and resolve canonical user id.
3. Editor state emits Yjs update payloads.
4. Realtime service broadcasts events to all subscribed peers.
5. Clients apply incoming updates and converge.
6. Presence join/leave events are surfaced in the editor header.
7. Latest update payload is checkpointed and replayed to newly connected clients.

## Git sync path

1. Project config stores remote URL + default branch and local mirror path.
2. On push, project documents are materialized into local mirror files, committed, and pushed to remote.
3. On pull, mirror fetch/rebase runs and pulled files are imported back into project documents.
4. Server also exposes project repo as smart HTTP Git endpoint for external clients.
  Git transport authenticates with PAT only.
5. Before serving Git traffic, pending collaborative changes are wrapped into a system commit `Recent updates on Typst server` with collaborative users captured in `Co-authored-by` trailers.
6. Non-fast-forward updates (including force push) are rejected so offline users must pull/rebase/merge first.

## Permission model (v1)

Project-level roles:

- `Owner`, `Teacher`: manage roles and project controls.
- `TA`: collaborator with git sync rights.
- `Student`: project read/write for document + comment activity.

OIDC group-to-role mapping:
- Each project can define `group_name -> role` bindings.
- During OIDC callback, backend reads configured groups claim and syncs user group membership.
- Matching group bindings are projected into `project_roles` (upgrade-only to avoid stripping manually granted stronger roles).

## Deployment shape

- Single VM, Docker Compose.
- Basic structured logging.
- Backup scripts for PostgreSQL and MinIO.
- Health endpoints at `/health` for core-api and realtime.

## Object storage path

1. Core API serializes project snapshots and uploads them to S3-compatible object storage.
2. Project assets are uploaded/downloaded through API and stored as objects keyed by project.
3. On successful Git pull/push/receive-pack events, API emits git bundle artifacts to storage for backup/recovery flows.
