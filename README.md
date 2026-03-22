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

## Services

- `apps/web`: Next.js app
- `services/core-api`: Axum REST API
- `services/realtime`: Axum WebSocket service
- `packages/shared`: Shared TypeScript contracts used by web app

## Current status

This repository implements a working v1 foundation and API surface.
Some advanced capabilities (full OIDC handshake with external provider,
Typst WASM incremental compile internals, real Git remote auth workflows)
are scaffolded with clean interfaces and mocked/default behavior for local bring-up.

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
