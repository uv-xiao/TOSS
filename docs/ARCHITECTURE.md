# Architecture (v1.1-dev)

## Runtime Topology

- `apps/web`: static Vite React SPA bundle
- `services/core-api`: Rust/Axum monolith
  - serves static SPA assets
  - serves REST APIs
  - serves realtime WebSocket endpoint
  - serves smart HTTP Git endpoint
- PostgreSQL: metadata, auth/session, RBAC, revisions, assets metadata, Git state
- Optional S3-compatible storage: snapshots/assets/pdf artifacts/git bundles

Single-origin deployment removes cross-origin auth complexity in normal operation.

## Realtime Collaboration

1. Client opens `ws /v1/realtime/ws/{doc_id}?project_id=...`.
2. Backend authorizes project access.
3. Clients exchange Yjs updates (`yjs.sync`, `yjs.update`) and presence payloads.
4. Backend broadcasts events to connected peers for that doc channel.
5. Clients converge on same text state and display collaborator cursor positions.

## Typst Client Compile Path

1. Editor/workspace state is passed to a browser worker.
2. Worker compiles entry Typst file via Typst WASM.
3. Worker returns:
  - vector artifact for canvas preview
  - PDF bytes for client download
  - deterministic diagnostics on compile failure
4. UI renders vector output to canvas and updates on content changes.
5. Typst packages are fetched through backend proxy/cache (`/v1/typst/packages/...`).

If WASM is unavailable, source editing remains available without live preview.

## Git Server Behavior

1. Each project maps to a local bare/non-bare Git repository path.
2. Backend exposes smart HTTP endpoints for clone/pull/push.
3. PAT auth is enforced for Git transport.
4. Pending collaborative server-side edits are wrapped into system commit:
   - `Recent updates on Typst server`
   - `Co-authored-by` trailers for contributing collaborators
5. Force push is rejected (`denyNonFastForwards`).
6. Stale pushes are rejected when server advanced; users pull/rebase/merge and retry.

## Auth and Identity

- Local accounts (password hash in DB) + session cookies
- OIDC auth flow with issuer/discovery settings configurable in Admin panel
- Org-admin scoped OIDC group-role mappings
- Project-level RBAC enforced for API and realtime endpoints
- Dev-only `x-user-id` header override gated by `AUTH_DEV_HEADER_ENABLED`

## Revision Model

- Revisions are created automatically on periodic dirty intervals.
- Each revision stores file snapshots plus associated authors.
- Users can open a revision in read-only mode in workspace UI.
