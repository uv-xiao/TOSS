# Typst Collaboration Platform

Self-hosted Typst collaboration platform with:

- Static React SPA (`web/`, Vite build output)
- Rust monolith (`backend/`) serving:
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
cd web
npm install
npm run build
```

`npm run build` now runs `sync:typst-assets` first, which stages Typst default text
font assets into `web/public/vendor/typst-assets/fonts` from a Typst-assets git tag
resolved from the installed compiler version (with fallback). The script caches fonts
under `web/.cache/typst-assets/<tag>/...` and writes a local manifest, so repeated
builds do not re-download once synced.

Optional override:

```bash
TYPST_ASSETS_TAG=v0.13.1 npm run build --prefix web
```

### 2. Start backend monolith

```bash
cd backend
DATABASE_URL=postgres://typstapp:iv61v6mRPCGxvWjt@127.0.0.1:5432/typstappdb \
CORE_API_PORT=18080 \
DATA_DIR=/tmp/typst-data \
WEB_STATIC_DIR=../web/dist \
MAX_REQUEST_BODY_BYTES=$((64 * 1024 * 1024)) \
cargo run
```

Open: [http://127.0.0.1:18080](http://127.0.0.1:18080)

Health check:

```bash
curl http://127.0.0.1:18080/health
```

### Optional: Self-Hosted TeXLive On-Demand (SwiftLaTeX)

The backend can serve SwiftLaTeX TeXLive assets directly (pure Rust, no separate
Python/Flask service).

Environment variables:

- `LATEX_TEXLIVE_BASE_URL`
  - If set: backend uses **prefer-local then upstream fallback** mode.
  - If unset: backend runs in **local-only** mode.

On first startup, backend auto-downloads bootstrap files into `DATA_DIR/texlive`:

- `swiftlatexxetex.fmt`
- `swiftlatexpdftex.fmt`
- `xetexfontlist.txt`

Bootstrap source defaults to:

- `https://github.com/SwiftLaTeX/Texlive-Ondemand/raw/refs/heads/master/...`

Optional override:

- `LATEX_TEXLIVE_BOOTSTRAP_BASE_URL`

Example:

```bash
cd backend
DATABASE_URL=postgres://typstapp:iv61v6mRPCGxvWjt@127.0.0.1:5432/typstappdb \
CORE_API_PORT=18080 \
DATA_DIR=/tmp/typst-data \
WEB_STATIC_DIR=../web/dist \
LATEX_TEXLIVE_BASE_URL=https://texlive2.swiftlatex.com \
cargo run
```

## Initial Admin Account

On first startup, the backend seeds an initial admin user and generates a random local password once.

Look for this log line in backend output:

```text
INITIAL ADMIN ACCOUNT: email=admin@example.com password=...
```

Rotate this password immediately after first login.
Additional users can self-register from the sign-in screen while `Allow self registration` is enabled in the Admin panel.

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
cd backend && cargo check

# Web build
cd web && npm run build

# Full local CI (checks + API tests + headless browser tests)
scripts/ci-checks.sh
```

## Headless Test Scripts

- `web/scripts/realtime-multiuser-test.mjs`
- `web/scripts/git-multiuser-test.sh`
- `web/scripts/headless-smoke.mjs`
- `web/scripts/headless-collab-git.mjs`
- `web/scripts/headless-revision-collab-regression.mjs`

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
- Upload/API payload size is controlled by `MAX_REQUEST_BODY_BYTES` (default 64 MiB).
  Increase it if you upload large base64-encoded assets (fonts, figures, etc).
- Runtime writable data is rooted at `DATA_DIR` (default `./tmp/data`):
  - Git repositories: `$DATA_DIR/git/<project_id>`
  - Project thumbnails: `$DATA_DIR/thumbnails/<project_id>.thumb`
  - `GIT_STORAGE_PATH` still works and overrides `$DATA_DIR/git` if explicitly set.
- Browser Typst preview uses Typst's default embedded text-font asset set
  (`Libertinus Serif`, `New Computer Modern`, `DejaVu Sans Mono`) plus any
  project-uploaded font files, to best match offline CLI output.
- `AUTH_DEV_HEADER_ENABLED=1` is for automated/local API tests only.
  Do not enable it for normal interactive login testing.
- Production deployment hardening is intentionally deferred until feature-complete validation is finished.
