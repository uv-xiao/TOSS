# Typst School Collaboration Platform (v1 Scaffold)

Monorepo scaffold for a self-hosted Typst collaboration platform with:

- React + Vite static frontend SPA
- Rust core API monolith (auth/session, RBAC, project APIs, WebSocket realtime, Git server, static hosting)
- PostgreSQL + MinIO + Docker Compose ops baseline

## Quick start

1. Copy `.env.example` to `.env`.
2. Build SPA:
   - `cd apps/web && npm install && npm run build`
3. Start infra and services:
   - `docker compose up --build`
4. Open app at `http://localhost:8080`.
5. API check:
   - `curl http://localhost:8080/health`

## Local dev without Docker

1. Ensure PostgreSQL is running and `DATABASE_URL` points to it.
2. Build web SPA:
   - `cd apps/web`
   - `npm install`
   - `npm run build`
2. Start core API:
   - `cd services/core-api`
   - `DATABASE_URL=postgres://... CORE_API_PORT=8080 GIT_STORAGE_PATH=/tmp/typst-git CHECKPOINT_STORAGE_PREFIX=/tmp/typst-checkpoints AUTH_DEV_HEADER_ENABLED=1 WEB_STATIC_DIR=../../apps/web/dist cargo run`
3. Open `http://localhost:8080`.

## Services

- `apps/web`: Vite React SPA
- `services/core-api`: Axum monolith (REST + WebSocket + Git HTTP + static files)
- `packages/shared`: Shared TypeScript contracts used by web app

## Current status

This repository implements a working v1 foundation and API surface with:
- project-level RBAC + org-admin APIs
- OIDC login/session with group-claim to project-role mapping
- realtime collaboration with presence and checkpoint replay in core-api monolith
- client-side Typst WASM canvas preview + PDF compile path with fallback source-only editing
- worker-based persistent Typst compiler runtime in browser for faster repeated compiles
- file tree APIs (multi-file + directories) and per-file realtime doc channels
- smart HTTP Git server endpoint per project with force-push rejection policy
- S3-compatible storage-backed project snapshots/assets and git bundle artifacts
- project archive and PDF artifact download APIs

Remaining advanced work includes deeper package/import-aware incremental compile,
branch/PR Git workflows, and Kubernetes deployment hardening.

## Git server behavior

- Repo link endpoint: `GET /v1/git/repo-link/{project_id}`
- Git auth uses Personal Access Tokens only (HTTP Basic password = PAT)
- Collaborative changes are wrapped into a system commit:
  - `Recent updates on Typst server`
  - `Co-authored-by` trailers for collaborative users
- Force push is rejected by server policy (`receive.denyNonFastForwards=true`)
- Offline users must `git pull`, rebase/merge, and retry push when server changed.

## Security tokens behavior

- User can create one or more PATs in security settings APIs
- Plaintext PAT is shown once at creation time only
- Optional expiration is supported
- Last-used timestamp is recorded on successful Git auth

## Browser fallback policy

If Typst WASM cannot run in browser, users can still edit Typst source in web UI.
PDF preview is unavailable in that case; users should sync via Git and compile offline.

## Seed users

- Teacher: `00000000-0000-0000-0000-000000000100`
- Student: `00000000-0000-0000-0000-000000000101`

Use these IDs in `x-user-id` header for RBAC-protected API calls.

## Useful scripts

- `scripts/smoke-test.sh`: checks core/realtime health and project listing.
- `scripts/ci-checks.sh`: full local CI suite (Rust checks + SPA build + API/browser collaboration and Git tests).
- `scripts/bootstrap-admin.sh`: creates school admin user in PostgreSQL.
- `scripts/backup-postgres.sh`: postgres dump into `tmp/backups`.
- `scripts/backup-minio.sh`: minio data archive into `tmp/backups`.
- `apps/web/scripts/realtime-multiuser-test.mjs`: two-user realtime sync/reconnect simulation.
- `apps/web/scripts/git-multiuser-test.sh`: strict-sync Git policy simulation (stale push rejection + force-push rejection).
- `apps/web/scripts/headless-collab-git.mjs`: headless browser multi-user collaboration + Git integration scenario with screenshots.

## Docs

- API reference: `docs/API.md`
- Architecture overview: `docs/ARCHITECTURE.md`
