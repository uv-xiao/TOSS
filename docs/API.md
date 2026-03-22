# API Surface (v1)

Core API base URL: `http://localhost:8080`

Most project-scoped endpoints require `x-user-id` for RBAC context.

## Auth

- `GET /v1/auth/config`: Returns OIDC provider/client config.
- `GET /v1/auth/oidc/callback?code=...&state=...`: Dev callback that issues a session token and writes an audit event.

## Projects and RBAC

- `GET /v1/projects`: List projects visible to current user.
- `POST /v1/projects`: Create project and grant caller `Owner`.
- `GET /v1/projects/{project_id}/roles`: List role bindings.
- `POST /v1/projects/{project_id}/roles`: Upsert role binding (`Owner | Teacher | Student | TA`), requires `Owner/Teacher`.

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

## Security tokens

- `GET /v1/security/tokens` list current user tokens (without plaintext secrets)
- `POST /v1/security/tokens` create token:
  - accepts label and optional `expires_at` (RFC3339 or null)
  - returns plaintext token exactly once in response
- `DELETE /v1/security/tokens/{token_id}` revoke token
