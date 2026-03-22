# Typst School Collaboration Platform (v1 Scaffold)

Monorepo scaffold for a self-hosted Typst collaboration platform with:

- Next.js frontend (collaborative editor + PDF preview shell)
- Rust core API (auth/session, RBAC, project APIs, git sync APIs)
- Rust realtime service (WebSocket collaboration channel)
- PostgreSQL + MinIO + Docker Compose ops baseline

## Quick start

1. Copy `.env.example` to `.env`.
2. Start infra and services:
   - `docker compose up --build`
3. Open frontend at `http://localhost:3000`.
4. API check:
   - `curl http://localhost:8080/health`
   - `curl http://localhost:8090/health`

## Local dev without Docker

1. Ensure PostgreSQL is running and `DATABASE_URL` points to it.
2. Start core API:
   - `cd services/core-api`
   - `DATABASE_URL=postgres://... CORE_API_PORT=8080 GIT_STORAGE_PATH=/tmp/typst-git cargo run`
3. Start realtime:
   - `cd services/realtime`
   - `REALTIME_PORT=8090 CHECKPOINT_STORAGE_PREFIX=/tmp/typst-checkpoints cargo run`
4. Start web:
   - `cd apps/web`
   - `npm install`
   - `NEXT_PUBLIC_CORE_API_URL=http://localhost:8080 NEXT_PUBLIC_REALTIME_URL=ws://localhost:8090 npm run dev`

## Services

- `apps/web`: Next.js app
- `services/core-api`: Axum REST API
- `services/realtime`: Axum WebSocket service
- `packages/shared`: Shared TypeScript contracts used by web app

## Current status

This repository implements a working v1 foundation and API surface with:
- project-level RBAC APIs
- realtime collaboration service with presence and checkpoint replay
- client-side Typst WASM PDF compile path with fallback preview
- Git mirror config + pull/push synchronization against a real remote

Remaining advanced work includes production-grade OIDC token validation,
browser compatibility hardening for Typst WASM, and richer Git conflict UI/flows.

## Seed users

- Teacher: `00000000-0000-0000-0000-000000000100`
- Student: `00000000-0000-0000-0000-000000000101`

Use these IDs in `x-user-id` header for RBAC-protected API calls.

## Useful scripts

- `scripts/smoke-test.sh`: checks core/realtime health and project listing.
- `scripts/bootstrap-admin.sh`: creates school admin user in PostgreSQL.
- `scripts/backup-postgres.sh`: postgres dump into `tmp/backups`.
- `scripts/backup-minio.sh`: minio data archive into `tmp/backups`.

## Docs

- API reference: `docs/API.md`
- Architecture overview: `docs/ARCHITECTURE.md`
