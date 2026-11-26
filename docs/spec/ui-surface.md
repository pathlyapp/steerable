# `UiSurface` v1, Deliverable Verifiers, and Fact-Chain Provenance

Steerable Phase 9 introduces a deterministic, zero-arbitrary-JS structured workbench (`UiSurface` v1), pre-delivery quality gates (`DeliverableVerifier`), and end-to-end deliverable provenance (`FactChainDrawer`).

## Closed 6-Component `UiSurface` v1

Scenario packs emit structured surfaces through `ui_surface_render`. `@steerable/agent-ui` renders only six audited primitives without `dangerouslySetInnerHTML`, `eval`, or `iframe`:

1. `DataTable` — filterable tabular rows (`<= 500` rows, `<= 64 KiB` serialized payload).
2. `KeyValue` — structured summary pairs.
3. `Form` — bounded operator input fields (`text`, `number`, `select`, `checkbox`) whose draft edits persist in `sessionStorage` across panel unmount/remount.
4. `DiffView` — before/after inspection prior to committing mutations.
5. `ActionButton` — explicit action trigger carrying `mode` (`read | safe_write | destructive | outward`), `expectedRevision`, and `(chatId, commandId)` idempotency keys.
6. `Badge` — status indicators (`neutral | info | success | warning | danger`).

When no GUI is attached (`steerable-cli tui` or headless transcripts), `renderUiSurfacePlainText` degrades every `UiSurface` into an aligned ASCII table and numbered action hints.

## Live `$source` Hash Anti-Stale Check (`409 UI_STALE`)

1. Data-backed components bind to read-only `PackDataSource` queries (`$source`) instead of trusting model-transcribed numbers.
2. When rendering a surface, the Host computes a canonical SHA-256 digest for each `$source` dataset (`sourceHashes`).
3. When an operator clicks a mutating `ActionButton`, `POST /api/v2/chats/:id/surfaces/:surfaceId/actions` verifies `expectedRevision` **and** re-queries every bound `$source` in real time:
   - If any canonical hash drifted, the Host immediately returns `409 { code: "UI_STALE", staleKeys }` with **zero** downstream tool calls.
   - Selected row snapshots are resolved from the authoritative server-side surface revision rather than trusting client-supplied row JSON.

## `DeliverableVerifier` & Immutable Snapshot Archive

When the model declares final outputs via `present_files` (`purpose="output"`):

1. Every matching `DeliverableVerifier` runs under a `15s` hard timeout.
2. Any `severity: "blocking"` issue or verifier timeout/error aborts delivery (`{ success: false, needsFollowup: true, data: { blockers } }`), feeding structured remediation back into `CoreLoop`.
3. Passing deliverables are archived as read-only (`0o444`) content-addressed snapshots under `<userDataDir>/deliverables/<chatId>/<sha256><ext>` alongside `policyDigest` and executed tool call summaries.

## `FactChainDrawer` Provenance States

`GET /api/v2/chats/:id/fact-chain` returns a 3-node provenance graph (`requestNode -> toolNodes -> deliverableNode`):

- Conversation turns lacking tool calls report `evidenceStatus: "no_tool_evidence"` rather than fabricating links.
- Imported historical sessions without turn metadata report `evidenceStatus: "gap"`.
- If the workspace file is edited or deleted after delivery, `deliverableNode.workspaceState` reports `"modified"` or `"missing"` while keeping the immutable archived snapshot accessible.
