# Typst Collaboration Platform

Self-hosted Typst collaboration platform with:

- Static React SPA (`apps/web`, Vite build output)
- Rust monolith (`services/core-api`) serving:
  - REST APIs
  - Realtime WebSocket collaboration
  - Smart HTTP Git endpoint
  - Static SPA assets on the same origin
- PostgreSQL metadata store
- Optional S3-compatible storage for snapshots/assets/artifacts

## Current Product Surface (v1.1-dev)

- Multi-project workspace with project/file tree (directories + file CRUD + uploads)
- Realtime per-file collaboration with Yjs + collaborator presence/cursor locations
- Client-side Typst WASM compile/render (canvas preview + `Download PDF (Client)`)
- Package proxy/cache for Typst Universe (`/v1/typst/packages/...`)
- Git server access per project (PAT auth, no force push)
- Project archive download
- Automatic periodic revisions with author attribution + read-only revision browsing
- Admin panel for auth/OIDC settings and OIDC group-role mappings
- Profile security panel for personal access tokens

## Local Development (No Docker)

### 1. Build frontend static assets

```bash
cd apps/web
npm install
npm run build
```

### 2. Start backend monolith

```bash
cd services/core-api
DATABASE_URL=postgres://typstapp:iv61v6mRPCGxvWjt@127.0.0.1:5432/typstappdb \
CORE_API_PORT=18080 \
GIT_STORAGE_PATH=/tmp/typst-git \
AUTH_DEV_HEADER_ENABLED=1 \
WEB_STATIC_DIR=../../apps/web/dist \
cargo run
```

Open: [http://127.0.0.1:18080](http://127.0.0.1:18080)

Health check:

```bash
curl http://127.0.0.1:18080/health
```

## Initial Admin Account

On first startup, the backend seeds an initial admin user and generates a random local password once.

Look for this log line in backend output:

```text
INITIAL ADMIN ACCOUNT: email=admin@example.com password=...
```

Rotate this password immediately after first login.

An additional seeded collaborator account is available for local testing:

- `member@example.com` / `member1234!`

## Auth Model

- Local account login and registration are supported.
- OIDC is supported with discovery/issuer URL configuration from the Admin panel.
- Admin can enable/disable:
  - local login
  - local self-registration
  - OIDC login
- If self-registration is disabled and OIDC is enabled, users can still be auto-provisioned on successful OIDC login.

## Git Access Model

- Each project exposes a Git clone URL (`GET /v1/git/repo-link/{project_id}`).
- Git transport authenticates with Personal Access Token (HTTP Basic password).
- Force push is rejected.
- If collaborative server-side updates exist, pushes can be rejected until client pulls/rebases/merges and retries.

## Useful Commands

```bash
# Rust checks
cd services/core-api && cargo check

# Web build
cd apps/web && npm run build

# Full local CI (checks + API tests + headless browser tests)
scripts/ci-checks.sh
```

## Headless Test Scripts

- `apps/web/scripts/realtime-multiuser-test.mjs`
- `apps/web/scripts/git-multiuser-test.sh`
- `apps/web/scripts/headless-smoke.mjs`
- `apps/web/scripts/headless-collab-git.mjs`

Screenshots are written to:

- `/tmp/typst-headless`
- `/tmp/typst-collab-git`

## Admin Bootstrap Helper

`scripts/bootstrap-admin.sh` can ensure an email is an org admin:

```bash
DATABASE_URL=postgres://... scripts/bootstrap-admin.sh
```

Optional variables:

- `ORG_ID`
- `ADMIN_EMAIL`
- `ADMIN_NAME`
- `ADMIN_ID`

## Notes

- Non-WASM browsers can still edit source but do not get live Typst preview.
- Production deployment hardening is intentionally deferred until feature-complete validation is finished.
