# API Surface (v1.1-dev)

Base URL: `http://localhost:8080`  
WS URL: `ws://localhost:8080`

All browser APIs run on the same Rust origin as static assets.

## Auth

- `GET /v1/auth/config`
- `POST /v1/auth/local/login`
- `POST /v1/auth/local/register`
- `GET /v1/auth/oidc/login`
- `GET /v1/auth/oidc/callback`
- `GET /v1/auth/me`
- `POST /v1/auth/logout`

## Realtime

- `GET /v1/realtime/auth/{project_id}`
- `GET /v1/realtime/ws/{doc_id}?project_id={uuid}`

WS payloads include:
- `yjs.sync`
- `yjs.update`
- `presence.meta`
- `presence.cursor`
- `presence.join`
- `presence.leave`

## Projects, Tree, and Documents

- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/{project_id}/tree`
- `POST /v1/projects/{project_id}/files`
- `PATCH /v1/projects/{project_id}/files/move`
- `DELETE /v1/projects/{project_id}/files/{path}`
- `GET /v1/projects/{project_id}/settings`
- `PUT /v1/projects/{project_id}/settings`
- `GET /v1/projects/{project_id}/documents`
- `POST /v1/projects/{project_id}/documents`
- `PUT /v1/projects/{project_id}/documents/by-path/{path}`
- `GET /v1/projects/{project_id}/documents/{document_id}`
- `PUT /v1/projects/{project_id}/documents/{document_id}`
- `DELETE /v1/projects/{project_id}/documents/{document_id}`

## Revisions and Exports

- `GET /v1/projects/{project_id}/revisions`
- `POST /v1/projects/{project_id}/revisions`
- `GET /v1/projects/{project_id}/revisions/{revision_id}/documents`
- `GET /v1/projects/{project_id}/archive`
- `POST /v1/projects/{project_id}/pdf-artifacts`
- `GET /v1/projects/{project_id}/pdf-artifacts/latest`

## Assets and Typst Packages

- `GET /v1/projects/{project_id}/assets`
- `POST /v1/projects/{project_id}/assets`
- `GET /v1/projects/{project_id}/assets/{asset_id}`
- `DELETE /v1/projects/{project_id}/assets/{asset_id}`
- `GET /v1/projects/{project_id}/assets/{asset_id}/raw`
- `GET /v1/typst/packages/{*path}`

## Git

- `GET /v1/git/status/{project_id}`
- `GET /v1/git/repo-link/{project_id}`
- `GET /v1/git/config/{project_id}`
- `PUT /v1/git/config/{project_id}`
- `POST /v1/git/sync/pull/{project_id}`
- `POST /v1/git/sync/push/{project_id}`
- `GET|POST /v1/git/repo/{project_id}/{*rest}` (smart HTTP Git transport)

Policy:
- PAT auth only for Git transport
- force push rejected
- stale push rejected when server changed; client must pull/rebase/merge and retry

## Admin

- `GET /v1/admin/settings/auth`
- `PUT /v1/admin/settings/auth`
- `GET /v1/admin/orgs/{org_id}/oidc-group-role-mappings`
- `POST /v1/admin/orgs/{org_id}/oidc-group-role-mappings`
- `DELETE /v1/admin/orgs/{org_id}/oidc-group-role-mappings/{group_name}`

## Profile Security

- `GET /v1/profile/security/tokens`
- `POST /v1/profile/security/tokens`
- `DELETE /v1/profile/security/tokens/{token_id}`

Token behavior:
- plaintext token returned once at creation
- optional expiration
- last-used timestamp updated on successful use
