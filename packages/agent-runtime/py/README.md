# steerable-agent-runtime

Tier 3 runtime for the Steerable framework.

Provides four orthogonal pluggable adapters:

- `LLMProvider` — chat-completion / streaming / tool-call abstraction, with
  reference implementations for OpenAI-compatible servers (covers OpenAI,
  Ollama, vLLM, SiliconFlow, etc.) and Anthropic native.
- `ToolRouter` — in-process tool registry. Auto-classifies tools into
  `ToolMode`s using `steerable_agent_harness.policy`, supports per-tool
  permission overrides, and dispatches `ToolCall` → `ToolResult`.
- `StorageAdapter` — persistence interface for `AgentSession`, `ChatMessage`,
  `ChatAgent`, `HarnessTrace + spans + events`, the durable history record,
  and the child-agent index. Reference impls: in-memory (default for
  sidecar/dev) and SQLite (zero-dependency, the sidecar's own store).
  SQLAlchemy remains available for hosted backends.
- `TransportAdapter` — wire format. `FastAPISseTransport` exports SSE for
  hosted setups; `StdioJsonRpcTransport` powers the steerable-sidecar.

The runtime is **Python only** by design — frontends never depend on it
directly. Browsers/Electron consume runtime output via either the SSE transport
(over HTTP) or the stdio JSON-RPC transport (sidecar pattern).

## Install

```bash
pip install steerable-agent-runtime[all]
```

## Upgrading from 0.9

The multi-agent layer became "sub-agents as persistent objects" in this
release. Nothing in the single-agent path changed.

- **`SCHEMA_VERSION` 1 → 2.** The new `children` table is created with
  `CREATE TABLE IF NOT EXISTS`, so an existing database upgrades in place on
  first open — no migration function, no data rewrite. A database written by a
  newer build still refuses to open.
- **`budgetTokens` now bounds the whole turn tree.** It used to limit each
  loop separately; a parent plus three children could each spend the full
  allowance. Every agent in the tree now debits one counter, and the first to
  cross it fails there. A host that relied on per-child allowances gets a
  tighter (correct) limit.
- **New `TreeBudget` / `SessionBudgetExceeded`** in `steerable_agent_runtime`.
  `AgentPool(budget=...)` shares one counter across the pool; the parent loop's
  usage is charged to the same counter by the host.
- **`provider_factory` for sub-agent profiles now takes `(model, effort)`**
  instead of `(model)`. `None` for either knob means "inherit the parent's",
  never "clear it". A profile pinning neither does not rebuild the provider at
  all.
- **New: `AgentPool.spawn(..., engine="acp", acp_engine=...)`** runs a child as
  an external process over the Agent Client Protocol instead of a local loop.
  Such a child has `loop=None`, reports **no** token bill (`usage` unknown, not
  zero), and refuses a mid-run `agent_send` (`child_not_steerable`) — a peer
  runs one prompt, so there is no round boundary to steer at.
- **`HistorySeed.source_model`** records which model produced a forked
  prefix. Additive; a seed written before this release simply lacks the key.
  `completed_turn_prefix()` remains the fork primitive and now backs
  `agent_spawn`'s `context: "fork"`.
- **`SubagentExecutor.attach_pool()` / `.pool`** expose the shared pool so a
  host can report children's usage alongside the turn's own bill.

## Upgrading from 0.10

Peer messaging and a shared task board (R8). Additive on the tool surface:
the same six orchestration tools exist, `agent_send` gained reach, and four
board tools appear when the family is on.

- **`agent_send` is tree-wide.** It used to reach only an executor's own
  children. It now accepts any live lineage id in the turn's spawn tree — the
  root (`0`), a sibling, a child — authorized by membership, not by a
  permission table. Delivery still goes through the owning pool, so the
  verdict vocabulary (`steered` / `resumed` / `error:*`) is unchanged. A
  message to the root steers the parent loop and lands as a user turn at its
  next round boundary.
- **Leaf agents get `agent_send` and `agent_list`.** A child that may not
  spawn (depth wall) or that came from `delegate_subagent` is still a member
  of the job, so it is advertised those two tools with no `agent_spawn`. A
  host that counts tools per child will see two more.
- **`agent_list` gained `members` and `self`** next to `children` — the live
  addresses `agent_send` accepts. `children` keeps its meaning and shape.
- **New: `AgentTree` / `TreeMember` / `TeamTaskBoard` / `TaskItem`,**
  `OrchestrationExecutor(tree=..., team_board=...)`, and
  `AgentPool.tree`. Passing neither keeps the previous behaviour exactly
  (single-pool reach, no board tools). `PeerToolsExecutor` is the layer that
  gives a leaf the two messaging tools.
- **New board tools, advertised with the family:** `team_task_create`,
  `team_task_claim`, `team_task_complete`, `team_task_list`. They are
  in-process and per turn — the board does not outlive its root turn, and the
  durable child index remains the record of what survived.
- **`subagent` children now register in the same tree,** so a delegated child
  and an `agent_spawn` child can message each other. `AgentPool.tree` exposes
  it; `attach_pool` is what makes a delegation part of the turn's job.
Selectively install just the bits you need:

```bash
pip install "steerable-agent-runtime[openai]"
pip install "steerable-agent-runtime[anthropic]"
pip install "steerable-agent-runtime[sqlalchemy]"
pip install "steerable-agent-runtime[fastapi]"
```

CoreLoop execution is the Rust engine. `steerable-agent-runtime-native`
is a required dependency of this package (same lockstep version). A
missing wheel fails import or `CoreLoop.run()`; there is no Python
engine fallback.

```bash
pip install steerable-agent-runtime-native
```
