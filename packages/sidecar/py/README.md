# steerable-sidecar

The portable Python entrypoint for the **steerable** framework. Designed to be
spawned by an Electron / desktop host (or directly from a CLI) and addressed
via stdio JSON-RPC 2.0.

## Quick start

```bash
pip install steerable-sidecar
python -m steerable_sidecar
```

Or use the console script:

```bash
steerable-sidecar
```

The process:

1. Initializes the in-memory storage and a default tool router.
2. Prints the **ready signal** on **stderr** as a single line:
   `__SIDECAR_READY__:<json>` matching `spec/sidecar/SidecarHealth`.
3. Begins reading JSON-RPC frames from stdin (one frame per line).
4. Writes responses and notifications to stdout.

See `spec/sidecar/README.md` for the full method/notification catalog.

## Upgrading from 0.9

Sub-agents became persistent objects: they outlive the turn that spawned them,
are recorded in a durable index, and can be listed and resumed after a restart.
Every change below is additive except where noted.

- **New RPC `agent.children.list`** — every child recorded for a parent
  session, with a composed status (`running` from a live handle, `interrupted`
  when the row never settled and no handle exists) and `resumable`.
  Params: `{parentRecordId? | recordId?, prefix?, includeFinished?,
  answerPreviewChars?}`. This is the durable answer the per-turn pool cannot
  give once the spawning turn ends.
- **New RPC `agent.children.interrupt`** — cooperatively stop one running
  child of a chat's live turn. Params `{chatId, childId}`; returns
  `{interrupted, reason?}`. `interrupted: false` means the child is not
  running in this process, which is the honest answer for a row that settled
  between render and click.
- **New notification `agent.child` kinds** — `child_needs_input` (with the
  child's `intro`), and `usage` on the terminal kinds. A host that renders the
  child list reads the bill from the event instead of walking the index.
- **`stream.done` gains fields, changes none.** `usage` grows
  `childPromptTokens` / `childCompletionTokens` / `childTotalTokens`,
  `children[]` (per-child split) and `unknownUsageChildren` (children whose
  engine reports no tokens at all). `treeUsage: {spent, byAgent}` carries the
  whole turn tree's bill, always present — it is a display figure and compares
  against nothing.
- **`budgetTokens` no longer bounds the turn tree.** It keeps its older job of
  capping the parent run's own loop. The tree-wide limit was removed: it stopped
  tasks partway through and left children at `budget_exhausted` waiting for a
  human to resume, which costs more than the tokens it saves. The spend figure
  above is what a host shows instead.
- **`orchestration` accepts an object**: `{enabled, maxDepth, maxParallel,
  childMaxRounds, childMaxToolErrors, forkTurns}`. A bare boolean still means
  `1 / 4`, so an older client keeps working.
- **Sub-agent profiles accept `model` / `reasoningEffort`** (both optional;
  omit to follow the parent) and **`engine: {kind: "acp", command, …}`** to run
  that profile on an external ACP agent instead of a local loop. Any `kind`
  other than `"acp"` fails at load with `unsupported_engine` rather than
  running locally.
- **`agent_spawn` accepts `model` / `reasoningEffort` when
  `context: "fork"`**, and reports `cacheNote: "cold"` plus `forkRoute` when
  the child re-reads the parent prefix on a different route. Changing the route
  without a fork fails closed.

## Upgrading from 0.10

Peer messaging and a shared task board ride the orchestration opt-in. Nothing
changes for a host that does not enable it.

- **`orchestration.team` (default `true`)** — with `enabled: true`, the turn
  also creates a spawn tree and a shared task board, and advertises four board
  tools (`team_task_create`, `team_task_claim`, `team_task_complete`,
  `team_task_list`) to every agent in the job. `team: false` keeps the six-tool
  family without them, for a host that does not want the extra tools in the
  prompt.
- **`agent_send` reaches the whole job.** Any live lineage id is addressable —
  `0` (the turn's root), a sibling, a child — not just this executor's own
  children. A message to the root steers the parent loop, so a worker's report
  arrives as a user turn. `agent_list` now also returns `members` (live
  addresses with depth and profile) and `self`.
- **Depth no longer gates messaging.** A child at the depth wall, and a
  `delegate_subagent` child, are advertised `agent_send` + `agent_list` and
  nothing else from the family. A host that counts child tools sees two more.
- **The tree and board are per turn.** They do not outlive the root run;
  `agent.children.list` remains the durable record. A message to an id that
  belonged to an earlier turn is not resumable through the tree — that is what
  `agent_send`'s registry path handles.

## Embedding

```python
import asyncio
from steerable_sidecar import Sidecar

async def main() -> None:
    sidecar = Sidecar()
    sidecar.tools.register(my_tool)
    await sidecar.serve()

asyncio.run(main())
```
