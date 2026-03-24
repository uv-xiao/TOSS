# Git 1:1 History Redesign Tracker

Last updated: 2026-03-25
Status: IN_PROGRESS (Core functional path implemented)

## Goal

Make Git the single source of truth for project history:

- `revision_id` maps 1:1 to Git commit SHA.
- Revision panel shows Git commits directly.
- Remove DB revision tables from hot path for revision history read/write.
- Keep DB only for app metadata (auth, permissions, share links, settings, UI state).

## Locked Design Decisions

1. Transport
- Keep `git http-backend` for smart HTTP transport.
- Do not implement custom smart protocol stack.

2. Policy layer
- Enforce push policy with server hook flow around receive-pack.
- Non-transport Git operations must use Rust `git2` bindings.

3. Server-side online edits
- Collaborative updates stay uncommitted as working-tree/index delta.
- Autosave commit interval: 10 minutes.
- System commit message: `Online updates`.

4. Push acceptance policy
- Reject force push semantics: newest server commit must be in pushed history.
- If server has uncommitted online delta:
  - attempt replay/rebase of delta on pushed tip;
  - accept only if conflict-free auto-application is possible;
  - if conflict: create immediate `Online updates` commit on server side with co-authors and reject push.

## Implementation Plan

### Phase A: Foundations (git2 migration except transport)

- [x] Replace shell Git helpers in non-transport paths with `git2`:
  - repo init/open,
  - branch/head checks,
  - status clean/dirty detection,
  - add/index/write-tree/commit,
  - fetch/pull/push for manual sync APIs,
  - bundle artifact generation moved to no-op placeholder in current prototype path.
- [x] Keep `git http-backend` command execution only for smart-HTTP transport.

### Phase B: History model cutover (revision == commit)

- [x] Add commit-based revision list endpoint behavior:
  - `GET /v1/projects/{id}/revisions` from Git log.
- [x] Add commit-tree based revision content endpoint behavior:
  - `GET /v1/projects/{id}/revisions/{revision_id}/documents`.
- [x] Ensure revision panel names come from commit subject.
- [x] Stop creating DB snapshot/diff revisions for new updates.
- [ ] Keep legacy DB revision code disabled or removed from runtime path.

### Phase C: Push policy integration

- [x] Add receive-pack policy behavior on server-side receive-pack wrapper:
  - ancestry check (no force push),
  - online delta replay check against pushed tip,
  - immediate `Online updates` commit + reject on replay conflict.
- [x] Ensure clear rejection messages for Git clients.

### Phase D: Correctness and durability

- [x] Guarantee online delta durability (persisted in DB + mirrored to repo working tree).
- [x] Serialize per-project operations with lock coverage.
- [ ] Add invariant checks after push/pull/flush:
  - repo head,
  - DB file mirror summary,
  - pending-author queue state.

### Phase E: Validation loops

- [x] API stress/fuzz:
  - concurrent collaborative edits,
  - push/pull races,
  - stale push rejection,
  - forced-push rejection,
  - immediate `Online updates` behavior.
- [x] Headless visual E2E:
  - revision panel commit list,
  - browsing commits,
  - collaboration continuity,
  - Git round trip reflected in UI.
- [x] Review performance/safety and iterate until no major concerns remain (no major correctness/safety issue found in current test scope).

## Open Risks to Track

- [ ] Hook complexity around receive-pack path can be subtle; verify with real Git client pushes.
- [ ] 10-minute autosave increases size of uncommitted delta and conflict probability.
- [ ] Commit-author attribution for aggregated online changes must be deterministic and auditable.
- [ ] Binary assets must remain fully round-trippable across Git and workspace state.

## Progress Log

### 2026-03-25

- Created redesign tracker with locked policy and implementation phases.
- Migrated non-transport Git operations to `git2`; only smart-HTTP transport still executes `git http-backend`.
- Replaced DB-backed revisions read path with commit-backed revision list/content APIs (`revision_id = commit SHA`).
- Updated manual revision checkpoint endpoint to create explicit Git commits (allow-empty supported).
- Removed DB auto-revision creation from dirty-marking flow.
- Implemented push policy handling in receive-pack wrapper:
  - force-push style ancestry rejection,
  - online-uncommitted delta merge check against pushed tip,
  - immediate `Online updates` commit + reject on conflict.
- Updated/ran stress and headless suites; fixed script drift for token auth and strict-sync flow.

### Residual Monitoring Notes

- Current online-delta replay uses file-level three-way merge semantics (safe, but may reject some line-mergeable text cases).
- Legacy DB revision snapshot/diff functions remain in codebase but are no longer on the active runtime path.
- Push rejection currently occurs at HTTP wrapper response path after receive-pack invocation; functional in tests, but hook-based enforcement remains a future hardening option.
