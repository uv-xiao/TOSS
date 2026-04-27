# TOSS

**TOSS = Typst Open-Source Server**  
An open-source, self-hosted collaborative writing platform for Typst (and LaTeX), with realtime editing, Git access, revision history, and browser-side compilation preview.

中文文档: [README.zh-CN.md](./README.zh-CN.md)

Demo: [https://typst-demo.cslabs.cn/](https://typst-demo.cslabs.cn/)

> ⚠️ This project is 100% vibe coded; reading its code too carefully may cause emotional damage.  
> ⚠️此项目100% vibe coded，阅读其代码可能对您造成精神伤害。

## Features

- Realtime collaborative editing with presence and cursor awareness
- Multi-file project workspace with directory tree, file/folder CRUD, and uploads
- Client-side Typst compilation and preview in browser (WASM)
- Client-side LaTeX compilation/preview support (pdfTeX/XeTeX via SwiftLaTeX runtime)
- Project-level Git HTTP access with Personal Access Token authentication
- Revision history browsing with author attribution
- Project sharing with read-only/read-write link modes
- Project archive export and PDF download
- Admin controls for authentication, OIDC, site branding, and announcements
- User profile security management for personal access tokens

## Architecture

- `web/`: static React SPA (Vite build)
- `backend/`: Rust monolith serving:
  - REST APIs
  - realtime WebSocket endpoints
  - Git HTTP endpoints
  - static frontend assets (same origin)
- PostgreSQL for metadata/state
- Runtime data under `DATA_DIR` (Git repos, thumbnails, TeXLive cache, etc.)

## Quick Start (Local Self-Deploy)

### 1) Build frontend

```bash
cd web
npm install
npm run build
```

### 2) Run backend

```bash
cd backend
DATABASE_URL=postgres://typstapp:iv61v6mRPCGxvWjt@127.0.0.1:5432/typstappdb \
CORE_API_PORT=18080 \
DATA_DIR=/tmp/toss-data \
WEB_STATIC_DIR=../web/dist \
MAX_REQUEST_BODY_BYTES=$((64 * 1024 * 1024)) \
LATEX_TEXLIVE_BASE_URL=https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet \
cargo run
```

Open: [http://127.0.0.1:18080](http://127.0.0.1:18080)

Health check:

```bash
curl http://127.0.0.1:18080/health
```

## First Login / Admin Bootstrap

On first startup, TOSS creates an initial admin account and prints credentials once:

```text
INITIAL ADMIN ACCOUNT: email=admin@example.com password=...
```

Sign in, rotate the password immediately, then configure auth policy and OIDC from the Admin panel.

## Testing Guide

### Fast checks

```bash
cd backend && cargo check
cd web && npm run build
```

### Full local CI checks

```bash
scripts/ci-checks.sh
```

### Headless E2E scripts

- `web/scripts/headless-smoke.mjs`
- `web/scripts/headless-collab-git.mjs`
- `web/scripts/realtime-multiuser-test.mjs`
- `web/scripts/headless-revision-collab-regression.mjs`

## Auth & Access Model

- Local login/register
- OIDC (discovery-based) configurable from Admin panel
- Admin-configurable auth switches (local login, registration, OIDC, anonymous policy)
- PAT-based Git authentication (PAT as HTTP password)
- Force push protection on project Git endpoints

## Environment Notes

- `DATA_DIR` is the runtime root:
  - `git/<project_id>` repositories
  - `thumbnails/<project_id>.thumb` cached previews
  - `texlive/...` local TeXLive cache/bootstrap files
- `LATEX_TEXLIVE_BASE_URL` can point to SwiftLaTeX-compatible upstreams or CTAN `/tlnet` mirrors
- `MAX_REQUEST_BODY_BYTES` defaults to 64 MiB; increase for large assets

## Project Scope

TOSS currently focuses on practical self-hosting and feature completeness for collaborative writing workflows.  
Production hardening and scale-out deployment guidance can be layered on top as needed.
