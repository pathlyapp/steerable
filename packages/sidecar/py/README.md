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
  engine reports no tokens at all). `treeUsage: {limit, spent, byAgent}` is
  present only when the request carried `budgetTokens`.
- **`budgetTokens` now bounds the whole turn tree**, not each loop.
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
