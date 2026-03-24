# Sync Systems Review and Redesign Tracker

Last updated: 2026-03-25
Scope: CRDT realtime sync, revision storage, Git server integration, and cross-system consistency.

## Current Architecture Summary

- Realtime uses per-file WebSocket channels (`/v1/realtime/ws/{doc_id}`) and server-side broadcast fanout.
- CRDT/Yjs updates are exchanged between clients through relay events (`yjs.update`, `yjs.sync`), not persisted as server CRDT state.
- Durable content is persisted through REST document upserts (`documents` table).
- Mutations call `mark_project_dirty`, which:
  - sets Git pending sync state,
  - records potential co-authors,
  - may auto-create revision snapshots/diffs.
- Git HTTP backend flushes pending server commit before serving Git protocol and, on successful push, imports repo files back into DB documents.
- Revisions are stored in mixed mode:
  - periodic full snapshots,
  - otherwise parent-based diffs for docs/directories/assets.

## Findings (Prioritized)

## Latest Review Cycle (2026-03-25)

Status legend:
- `OPEN`: confirmed issue not fixed yet
- `IN_PROGRESS`: patch in progress
- `FIXED`: code patch landed and tests rerun
- `MONITOR`: no concrete bug found now, keep observing under scale

1. `FIXED` Realtime channel isolation keyed only by `doc_id` (cross-project leakage risk).
  - Fix: realtime broadcaster key is now `(project_id, doc_id)` composed key.
  - Also added idle channel cleanup when receiver count reaches zero.
  - Ref: `backend/src/realtime.rs`.

2. `FIXED` Realtime updates dropped on persistence failure.
  - Fix: server still relays event to connected collaborators even if durable write fails, while emitting `server.error`.
  - Ref: `backend/src/realtime.rs`.

3. `FIXED` Incomplete revision visibility / partial-materialization hazard.
  - Fix: added `revisions.is_complete`, only complete revisions are visible/queryable/used as parents.
  - Creation now inserts `is_complete=false`, snapshots/diffs, then flips to `true`; on snapshot failure row is deleted.
  - Ref: `backend/migrations/202603250001_revision_completeness.sql`, `backend/src/server/support.rs`, `backend/src/server/documents.rs`, `backend/src/server/projects.rs`.

4. `FIXED` Path alias safety issue (`./` segments could alias repo files).
  - Fix: stricter canonicalization rejects `CurDir` and normalizes components into a canonical slash-joined path.
  - Ref: `backend/src/server/projects.rs`.

5. `MONITOR` Revision materialization cost can still be high for very large projects.
  - Current mitigation: diff chain bounded by periodic full snapshots (`REVISION_FULL_SNAPSHOT_INTERVAL`), adaptive delta/full transfer.
  - Future options: hot-state cache, streaming assets, and payload budgets.

6. `FIXED` Git HTTP backend process-level failure propagation.
  - Fix: if `git http-backend` exits non-zero without CGI output, API returns 500 with stderr context.
  - Ref: `backend/src/server/git.rs`.

7. `FIXED` Defensive cap behavior for abnormal revision chain depth.
  - Fix: guard overflow now fails safely (`None`) instead of silently materializing a truncated state.
  - Ref: `backend/src/server/support.rs`.

## Current Residual Risk (After This Cycle)

- `MONITOR` Revision browse CPU/memory can still be heavy for very large projects with many large assets because server currently materializes full in-memory state to choose best transfer anchor.
  - Not a correctness/safety bug observed in tests.
  - Candidate future optimization: bounded in-memory materialized-state cache keyed by `(project_id, revision_id)`.

## P0 Critical

- [ ] **P0-1: Git push can succeed while DB import fails (hard divergence risk).**
  - In smart-HTTP flow, successful `receive-pack` may return success even if `sync_repo_documents_to_project` fails.
  - Result: Git remote accepted commit, but collaborative DB state is stale/diverged.
  - Ref: `backend/src/server/git.rs` around `git_http_backend`.

- [ ] **P0-2: Git<->workspace sync is text-only and incomplete for full project state.**
  - Repo import keeps only UTF-8 text files (`documents`) and skips binary files.
  - Repo export writes `documents` only; stale files and asset/directory parity are not fully reconciled.
  - Result: potential data loss or inconsistency for binaries/assets and deleted files.
  - Ref: `backend/src/server/support.rs` `sync_project_documents_to_repo` / `sync_repo_documents_to_project`, `backend/src/git_utils.rs` `collect_repo_files`.

## P1 High

- [ ] **P1-1: Missing per-project lock for Git filesystem operations.**
  - `git_pull`, `git_push`, `git_http_backend`, and `flush_pending_server_commit` can overlap on same repo path.
  - Risk: race conditions, `.git/index.lock` errors, partial cross-system sync.

- [ ] **P1-2: Revision creation path is non-atomic across metadata and payload rows.**
  - Revision row insertion and snapshot/diff row writes are not one DB transaction.
  - Risk: partial or corrupted revision records on failure.

- [ ] **P1-3: Durable writes are last-write-wins without optimistic concurrency/version checks.**
  - REST upsert can overwrite newer content from stale client state.
  - Risk: data loss under delayed reconnects/multi-device out-of-order save.

## P2 Medium

- [ ] **P2-1: Auto snapshot scheduling and attribution are race-prone.**
  - Multiple concurrent writes can pass due-check and create near-duplicate snapshots.
  - Author attribution window can over/under include contributors.

- [ ] **P2-2: Realtime channel map can grow unbounded.**
  - Channels are created per `doc_id` and not evicted when last client disconnects.
  - Risk: long-term memory growth on busy instances.

- [ ] **P2-3: Revision retrieval path can be CPU/bandwidth heavy at scale.**
  - Materializes multiple states and base64-encodes assets for payload selection.
  - Risk: high CPU and memory under frequent revision browsing in large projects.

## TODO Plan (Execution Order)

## Phase 1: Correctness and Safety (Blockers)

- [x] Add per-project sync lock (cover `git_pull`, `git_push`, `git_http_backend`, flush job).
- [x] Make Git receive-pack apply path fail hard if DB import fails (or rollback strategy with reject).
- [x] Redesign repo import/export to include binary assets and deletion parity.
- [ ] Add explicit end-to-end consistency checks after sync (repo head, DB file count/hash summary).

## Phase 2: Transactional Integrity

- [x] Guard revision visibility/materialization with `is_complete` lifecycle (practical atomicity boundary for readers).
- [ ] Introduce save precondition/version token for document upsert.
- [ ] Ensure dirty mark + author touch + auto snapshot decision use transaction/locking semantics.

## Phase 3: Performance and Scalability

- [x] Add realtime channel eviction when no subscribers remain.
- [ ] Cache/materialize revision states for hot revisions (bounded cache).
- [ ] Add payload budget controls and streaming for large revision assets.
- [ ] Add metrics: sync latency, snapshot cost, revision materialization cost, DB write amplification.

## Phase 4: Observability and Recovery

- [ ] Add structured sync event logs with correlation id per project operation.
- [ ] Add reconciliation command: detect and repair Git/DB drift.
- [ ] Add property and chaos tests:
  - concurrent edits + git push/pull,
  - process restart during revision creation,
  - binary assets round-trip through Git path.

## Redesign Recommendation (Battle-tested Stack)

Recommended target architecture for a clean rebuild:

- Realtime CRDT core:
  - Keep Yjs on client.
  - Use a battle-tested Yjs server stack with persistence/awareness support (e.g. Hocuspocus/y-websocket family with Redis-backed fanout and persistence).
  - Treat CRDT update log + periodic CRDT snapshots as authoritative collaborative state.

- Git as source-of-history and transport:
  - Keep server as Git HTTP server with strict non-fast-forward rejection.
  - Serialize all project Git operations through a per-project worker/queue.
  - Use append-only system commits for collaborative flushes (`Recent updates on Typst server` + co-authors).

- Revision model:
  - Use Git commits/trees as canonical revision source (instead of separate custom diff tables for long-term history).
  - Optionally keep short-lived DB cache/index for fast UI listing, but rebuildable from Git metadata.

- Asset model:
  - Store all project files (text + binary) in one canonical tree model for Git round-trip fidelity.
  - Use object storage only as optimization/cache, never as separate truth diverging from repo/tree.

## Migration Notes

- Existing mixed DB revision data should be treated as legacy.
- During migration, implement dual-write and validator:
  - old path + new path write in parallel,
  - compare effective project state hashes,
  - cut over only when drift is zero over sustained period.
