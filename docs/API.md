# API Surface (v1)

Core API base URL: `http://localhost:8080`

Most project-scoped endpoints require `x-user-id` for RBAC context.
In browser usage, session cookie auth from OIDC login is preferred; `x-user-id` remains a dev override.

## Auth

- `GET /v1/auth/config`: Returns OIDC provider/client config.
- `GET /v1/auth/oidc/login`: Starts OIDC authorization code flow.
- `GET /v1/auth/oidc/callback?code=...&state=...`: Dev callback that issues a session token and writes an audit event.
- `GET /v1/auth/me`: Returns current session user profile.
- `POST /v1/auth/logout`: Revokes current session.

## Projects and RBAC

- `GET /v1/projects`: List projects visible to current user.
- `POST /v1/projects`: Create project and grant caller `Owner`.
- `GET /v1/projects/{project_id}/roles`: List role bindings.
- `POST /v1/projects/{project_id}/roles`: Upsert role binding (`Owner | Teacher | Student | TA`), requires `Owner/Teacher`.
- `GET /v1/projects/{project_id}/group-roles`: List OIDC group -> project role mappings.
- `POST /v1/projects/{project_id}/group-roles`: Upsert OIDC group -> project role mapping, requires `Owner/Teacher`.
- `DELETE /v1/projects/{project_id}/group-roles/{group_name}`: Remove mapping.

OIDC group claim mapping:
- Group claim name comes from `OIDC_GROUPS_CLAIM` (default `groups`).
- On each successful OIDC login, backend syncs current groups into `user_oidc_groups`.
- Matching `project_group_roles` mappings are applied to the user as project roles (only upgrades; no automatic downgrades).

## Documents, comments, revisions

- `GET /v1/projects/{project_id}/documents`
- `POST /v1/projects/{project_id}/documents`
- `PUT /v1/projects/{project_id}/documents/by-path/{path}` (upsert save path for editor autosave)
- `GET /v1/projects/{project_id}/documents/{document_id}`
- `PUT /v1/projects/{project_id}/documents/{document_id}`
- `DELETE /v1/projects/{project_id}/documents/{document_id}`
- `GET /v1/projects/{project_id}/comments`
- `POST /v1/projects/{project_id}/comments`
- `GET /v1/projects/{project_id}/revisions`
- `POST /v1/projects/{project_id}/revisions`

## Snapshots and assets (S3-compatible storage)

- `GET /v1/projects/{project_id}/snapshots`
- `POST /v1/projects/{project_id}/snapshots`
- `POST /v1/projects/{project_id}/snapshots/{snapshot_id}/restore`
- `GET /v1/projects/{project_id}/assets`
- `POST /v1/projects/{project_id}/assets` (JSON body with `path`, `content_base64`, optional `content_type`)
- `GET /v1/projects/{project_id}/assets/{asset_id}`
- `DELETE /v1/projects/{project_id}/assets/{asset_id}`

Storage configuration:
- `S3_BUCKET` enables object storage integration.
- Optional: `S3_ENDPOINT` (for MinIO), `S3_REGION`, `S3_KEY_PREFIX`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- If `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are missing, service falls back to `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`.

## Git sync (main branch in v1)

- `GET /v1/git/status/{project_id}`
- `GET /v1/git/repo-link/{project_id}`
- `GET /v1/git/config/{project_id}`
- `PUT /v1/git/config/{project_id}`
- `POST /v1/git/sync/pull/{project_id}`
- `POST /v1/git/sync/push/{project_id}`
- `/{repo_url}` smart HTTP Git endpoint served by backend (`git clone`, `git pull`, `git push`)

Git HTTP authentication:
- Personal Access Token (PAT) only via HTTP Basic auth password field.
- Session cookies are not accepted for Git transport.

Current implementation stores sync state with audit events and uses a per-project local mirror to run real git pull/push commands.
`git pull` imports remote files back into `documents` rows.
Force push is rejected (`receive.denyNonFastForwards=true`).
If collaborative edits happened on server, clients must pull/rebase/merge, then push again.
Branch-aware PR flows are intentionally deferred to later phases.
Successful pull/push/receive-pack also upload git bundle artifacts into object storage when S3 is configured.

## Security tokens

- `GET /v1/security/tokens` list current user tokens (without plaintext secrets)
- `POST /v1/security/tokens` create token:
  - accepts label and optional `expires_at` (RFC3339 or null)
  - returns plaintext token exactly once in response
- `DELETE /v1/security/tokens/{token_id}` revoke token
