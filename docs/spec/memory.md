# Dual-Layer Memory & Zero-Trust RSI

Steerable separates durable operator preferences (Layer 1) from bounded procedural refinements (Layer 2) inside a host-isolated directory (`<userDataDir>/memory/`).

## Physical & Sandbox Isolation

- `<userDataDir>/memory/` lives outside every project workspace.
- Both Host file/shell tools (`LocalExecutor`) and OS sandboxes (`Seatbelt` `(deny file-read* file-write* ...)` on macOS, `bwrap` mask mounts on Linux) deny direct path access to `<userDataDir>/memory/`.
- All reads and mutations flow exclusively through audited Host APIs (`/api/v2/memory*`) and typed memory tools (`memory_read`, `memory_propose`, `memory_withdraw`).

## Multi-Tenant RBAC & Subagent Write Ban

- **Scopes**:
  - `user`: isolated to `(tenantId, principal.id)`.
  - `workspace`: shared within `(tenantId, workspaceId)`.
  - `tenant`: readable by tenant members; writable **only** when `principal.isAdmin === true`.
- **Subagent & Fork Quarantine**: delegated child runs (`isSubagent`) and branched sessions (`isFork`) are rejected before effect with `subagent_memory_write_forbidden`.

## Snapshot-Anchored Prompt Injection (KV-Cache Safe)

1. `prompt-builder.ts` (`system`) never concatenates `MEMORY.md`, keeping the static system prompt prefix deterministic.
2. At session start (and immediately after `compactionEpoch` advances), the Host captures a frozen `<untrusted_memory_note trust="untrusted">` snapshot at the conversation head.
3. Mid-session memory edits do **not** mutate historical messages; incremental `[memory delta]` notes append only to the latest turn tail so upstream KV-cache prefixes remain 100% intact.
4. Every `MEMORY.md` index enforces a strict `16 KiB / 200 lines` ceiling. Exceeding capacity rejects with `MEMORY_CONSOLIDATION_REQUIRED` rather than silently evicting entries via FIFO.

## Zero-Trust RSI Safeguards

- **30-Day Expiry & Promotion**: procedural `<!-- refinement: ... -->` blocks expire after 30 days unless promoted by a human via **Make ordinary** (`convertRefinementToOrdinary`).
- **Permanent Revocation Tombstone**: withdrawing an entry records its canonical SHA-256 as `user_revoked`, permanently blocking automatic re-learning of the same rule.
- **`humanEdited` Protection**: entries edited manually by an operator cannot be overwritten by automated RSI consolidation (`409 human_edited_protected`).
- **Dual-Hash Authoring Quarantine**: `authoring-candidates` only emits candidate skill/profile diffs after the exact canonical pattern repeats across `>= 3` independent `Principal`s and `>= 5` sessions, never auto-activating without human publication.
- **Privacy De-Identification**: sessions that wrote or proposed memory strip raw `userText` / `assistantText` before enqueuing `insights` telemetry.
