# State Ownership & Failure Semantics Contract

This specification defines the authoritative single source of truth (SSoT) and side-effect failure semantics across the Steerable engine, host runtime, and scenario packs.

## 1. Authoritative State Ownership Matrix

Every runtime fact has exactly one owning store. Downstream consumers project or cache read-only views from that owner and never mutate shadow copies.

| Domain Fact | Authoritative Owner | Persistence Backing | Permitted Readers / Projections | Prohibited Anti-Patterns |
| :--- | :--- | :--- | :--- | :--- |
| Turn transcript, tool call/result ledger, compaction checkpoints | Sidecar `HistoryStore` (Session Ledger) | Sidecar SQLite (`sessions.db`) | CoreLoop resume, branch fork, `FactChainDrawer` event timeline | Re-synthesizing tool history from truncated UI markdown |
| Tenant/user chat metadata, messages, traces, usage & reliability counters | Host `ScopedStore` (`SqliteScopedStore` / `MysqlScopedStore`) | Host SQLite (`agent-shell.db`) or Team MySQL | Sidebar list, trace inspector, usage dashboard, `diag-bundle` | Scenario packs opening `better-sqlite3` or querying host tables directly |
| Authenticated `Principal` & `OriginChannel` | Host `AuthProvider` + `turn-security-context` | Ephemeral per-request / per-turn Node host memory | `PackToolContext`, `PackBackendRouteRequest`, `HttpRouteRequest`, `ApprovalBridge` | Trusting model-supplied `args.principal` or unverified client headers |
| External data-source secrets (`PackDataSource`) | Host `CredentialBroker` + `SecretRedactor` | `pack_credentials` (AES-256-GCM encrypted at rest) | `PackToolContext.credentials.resolve(sourceId)` at transport call time | Passing raw tokens in prompts, tool schemas, traces, or `.env` dumps |
| Non-idempotent unknown-outcome locks | Host `ReconciliationGate` + Runtime `ApprovalExecutor` | `pending_reconciliations` | Tool dispatch pre-check, `OutcomeReconcileCard`, `GET /api/v2/chats/:id/reconciliations` | Auto-retrying a timed-out non-idempotent write tool without human reconciliation |
| Durable approval grants (`allow_always` / `deny_always`) | Runtime `JsonApprovalStore` | `approvals.json` keyed by `policyDigest` | `ApprovalExecutor` (`checkpoint === 'standard'` only) | Reusing `allow_always` after sandbox roots, network allowlists, or safety policies widen |
| Session declarative workbenches & action receipts | Host `UiSurfaceRegistry` | `chat_ui_surfaces`, `chat_ui_receipts` | `UiSurfaceCard`, `UiSurfaceWorkbench`, `FactChainDrawer` | Executing write actions against stale `$source` data without fingerprint verification |
| Verified turn deliverables & quality reports | Host `DeliverableRegistry` | `chat_deliverables` | `TurnFilesCard`, `FactChainDrawer` | Marking a deliverable verified when a registered `DeliverableVerifier` reports blocking issues |
| Scoped durable memory (`MEMORY.md` + entries + tombstones) | Host `MemoryStore` | `memory_documents`, `memory_entries`, `memory_revoked_hashes` | Turn-start frozen memory snapshot, `MemorySettingsPanel`, `MemorySaveNoticeBar` | Mutating mid-turn system prompts (invalidating KV prefix cache) or resurrecting revoked memories |

## 2. Closed `RejectedBeforeEffect` vs. `outcome_unknown`

Tool failures are partitioned into three mutually exclusive side-effect states recorded on `ToolResult.effect`:

1. **`effect: "none"` (`RejectedBeforeEffect`)**
   - Guaranteed only when rejection occurs strictly before the side-effecting handler or transport call begins:
     - JSON Schema validation failure
     - Plan-mode write block or agent `toolPolicy` rejection
     - Critical command safety block
     - `approval_denied`, `timed_out` on approval wait, or `outward_confirmation_required`
     - `reconciliation_required` (blocked by an unresolved prior `outcome_unknown`)
   - Safe for the model to adjust arguments or ask the user (`retryable: true` unless blocked by policy/reconciliation).

2. **`effect: "committed"`**
   - The handler ran and returned a deterministic domain outcome (either `success: true` or a known business rejection from the downstream system where rollback/non-execution is confirmed).

3. **`effect: "unknown"` (`outcomeUnknown: true`, `retryable: false`)**
   - Triggered whenever a tool declared with `idempotent: false` crosses all pre-dispatch gates into handler execution and encounters a timeout, broken reverse-RPC pipe, transport disconnect, unhandled exception, or explicit `{ outcomeUnknown: true }` return.
   - Records a durable `pending_reconciliations` lock for `(chatId, toolName)` and halts automatic retries of `toolName` until an operator resolves the lock via `POST /api/v2/chats/:id/reconcile` (`confirmed_executed` or `confirmed_not_executed`).

## 3. Policy-Digest Bound Approvals & `outward` Checkpoints

- **`policyDigest`**: Computed over canonicalized security posture (`approval_mode`, `sandbox_enforced`, sorted `writable_roots`, sorted `allowed_hosts`, and command safety posture). Cosmetic settings (`model`, `provider`, `theme`, `temperature`) are excluded. Any change to `policyDigest` invalidates prior `allow_always` grants.
- **`checkpoint: "outward"`**: Reserved for irreversible external actions (external messages, ticket mutations, financial/production submissions). Bypasses `JsonApprovalStore`, `SessionApprovalCache`, `WorkspaceAutoApprover`, and non-interactive `--approve allow-all`, requiring per-invocation human confirmation on Web, Desktop, or interactive TUI.
