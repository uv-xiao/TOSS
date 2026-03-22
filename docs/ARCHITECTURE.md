# Architecture (v1)

## Components

- `apps/web` (Vite React SPA): Project dashboard, file tree, collaborative editor shell, client-side Typst compile loop, canvas preview pane.
- `services/core-api` (Rust/Axum + PostgreSQL): Monolith serving static SPA, Auth/OIDC, project metadata, RBAC, file tree APIs, realtime WebSocket channel, Git smart HTTP endpoint, export APIs, audit logs.
- Realtime checkpoint replay is persisted by core-api under `CHECKPOINT_STORAGE_PREFIX`.
- `postgres`: Source of truth for metadata and permissions.
- `minio` (S3-compatible): Store for snapshots/assets/git bundle artifacts.

## Realtime path

1. Browser opens websocket to `/v1/realtime/ws/{doc_id}?project_id=...` on the same origin as API/static app.
2. Core API validates RBAC/session directly for websocket upgrades.
3. Editor state emits Yjs update payloads.
4. Core API realtime channel broadcasts events to subscribed peers.
5. Clients apply incoming updates and converge.
6. Presence join/leave events are surfaced in the editor header.
7. Latest update payload is checkpointed and replayed to newly connected clients.

## Client compile path

1. Browser editor updates are debounced by React state and sent to a dedicated Typst Web Worker.
2. Worker holds a long-lived Typst compiler instance and compiles the configured entry file (`main.typ` default).
3. Worker compiles to vector artifact and returns deterministic diagnostics.
4. UI renders vector artifact to canvas with Typst renderer when successful, or inline diagnostics otherwise.
5. Worker also compiles PDF bytes; UI can download directly and upload latest PDF artifact to server.
5. Worker uses server package proxy/cache endpoint for Typst universe dependency fetch.

## Git sync path

1. Project config stores remote URL + default branch and local mirror path.
2. On push, project documents are materialized into local mirror files, committed, and pushed to remote.
3. On pull, mirror fetch/rebase runs and pulled files are imported back into project documents.
4. Server also exposes project repo as smart HTTP Git endpoint for external clients.
  Git transport authenticates with PAT only.
5. Before serving Git traffic, pending collaborative changes are wrapped into a system commit `Recent updates on Typst server` with collaborative users captured in `Co-authored-by` trailers.
6. Non-fast-forward updates (including force push) are rejected so offline users must pull/rebase/merge first.

## Permission model (v1.1)

Project-level roles:

- `Owner`, `Teacher`: manage roles and project controls.
- `TA`: collaborator with git sync rights.
- `Student`: project read/write for document + comment activity.

OIDC group-to-role mapping:
- Org admins define `group_name -> role` mappings per organization.
- During OIDC callback, backend reads configured groups claim and syncs user group membership.
- Mapped roles are projected into `project_roles` across org projects with strict sync semantics.

## Deployment shape

- Single VM, Docker Compose.
- Basic structured logging.
- Backup scripts for PostgreSQL and MinIO.
- Health endpoint at `/health` for the core monolith.

## Object storage path

1. Core API serializes project snapshots and uploads them to S3-compatible object storage.
2. Project assets are uploaded/downloaded through API and stored as objects keyed by project.
3. On successful Git pull/push/receive-pack events, API emits git bundle artifacts to storage for backup/recovery flows.
