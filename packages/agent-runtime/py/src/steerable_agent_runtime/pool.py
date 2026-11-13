"""AgentPool — concurrent child CoreLoops for one parent, budgeted and
lineage-tracked.

The pool is the framework's single child-execution engine, shared by both
multi-agent surfaces:

- the six-tool orchestration family (``orchestration.py`` — the parent
  model drives ``agent_spawn``/``agent_send``/``agent_wait``/...), and
- the single-tool delegation seam (``subagent.py`` — ``delegate_subagent``
  spawns into a pool and awaits the terminal outcome synchronously).

Design:
- **Lineage as data.** Child ids are ``<lineage>.<seq>`` (root ``0``), so
  ``0.2`` is the root's second child and ``0.2.1`` its first grandchild.
- **Budgets fail closed.** ``max_parallel`` refuses at the boundary
  (``OrchestrationBudgetExceeded``), never silently queues.
- **One pool, several drivers.** The constructor's ``loop_factory`` is the
  default child builder; a caller whose children differ per spawn (the
  delegation seam resolves a named profile per call) passes a per-spawn
  ``loop_factory`` override instead. Sharing one pool instance between the
  two surfaces keeps one ``max_parallel`` budget and one lineage space.
- **Children stay out of the parent record.** A child's transcript is its
  own loop's; hosts that want child traces subscribe via ``event_sink``
  (lifecycle events with lineage) or wrap children in their own hooks.
- **Session state is isolated.** A child runs with its durable record id as
  ``chat_id`` when available, otherwise a pool-local id, so session-scoped
  tools such as ``todo_write`` cannot overwrite a sibling or parent list.
- **The pool is not the index.** A pool is built per turn and shut down with
  it, so it can only answer "what is running now". ``ChildRegistry`` is the
  durable answer to "what did this session spawn"; the pool writes to it at
  spawn and at every terminal exit, and ``adopt`` lets a resumed child rejoin
  a fresh pool under its original lineage id.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from itertools import count
from typing import Any

from .budget import SessionBudgetExceeded, TreeBudget, TreeBudgetReport
from .engines import (
    AcpEngineSpec,
    AcpOutcome,
    AcpPermissionPolicy,
    AcpToolBridge,
    AcpUnavailable,
    run_acp_child,
)
from .history import HistorySeed, entry_to_dict
from .llm import LLMMessage, LLMUsage
from .loop import CoreLoop
from .registry import ChildRegistry, SpawnedChild, default_record_id, registry_status
from .tree import AgentTree, TreeMember

logger = logging.getLogger(__name__)

#: Grace between a cooperative close (``loop.cancel()``) and the hard-cancel
#: backstop for a child that fails to wind down.
_CLOSE_GRACE_S = 2.0
_POOL_CONTEXT_SEQUENCE = count(1)


class OrchestrationBudgetExceeded(Exception):
    """Raised by ``AgentPool.spawn`` at the parallel cap — fail closed."""


@dataclass(frozen=True, slots=True)
class OrchestrationConfig:
    """Tunables for the orchestration layer (pool budgets + tool family).

    ``max_depth`` counts loop nesting: 1 means the parent spawns children
    that cannot spawn themselves (today's depth-1 delegation). ``max_parallel``
    caps concurrently running children per pool. ``child_max_rounds`` and
    ``child_max_tool_errors`` bound each child run; hosts pass the parent
    loop's values so a child is not tighter than its parent.
    ``wait_timeout_s`` bounds an
    ``agent_wait`` without an explicit ``timeoutMs`` — kept under the loop's
    per-tool backstop (default 5 min) so a hung child surfaces as a
    ``running`` outcome, not a tool timeout. The six tool names configure
    the orchestration family the ``OrchestrationExecutor`` exposes.

    ``fork_turns`` caps how many of the parent's user requests a forked child
    inherits. ``None`` (the default) keeps the whole answered prefix — the
    right choice for "continue what we were doing" — and a number is the
    escape hatch for a parent conversation long enough to crowd the child's
    own work out of its context window.
    """

    max_depth: int = 1
    max_parallel: int = 4
    child_max_rounds: int = 8
    child_max_tool_errors: int = 3
    wait_timeout_s: float = 120.0
    fork_turns: int | None = None
    spawn_tool: str = "agent_spawn"
    send_tool: str = "agent_send"
    wait_tool: str = "agent_wait"
    close_tool: str = "agent_close"
    list_tool: str = "agent_list"
    interrupt_tool: str = "agent_interrupt"
    #: R8 shared task board. Advertised only when a board is wired; the names
    #: are configurable so a host can avoid colliding with its own tools.
    task_create_tool: str = "team_task_create"
    task_claim_tool: str = "team_task_claim"
    task_complete_tool: str = "team_task_complete"
    task_list_tool: str = "team_task_list"

    @property
    def tool_names(self) -> frozenset[str]:
        return frozenset(
            {
                self.spawn_tool,
                self.send_tool,
                self.wait_tool,
                self.close_tool,
                self.list_tool,
                self.interrupt_tool,
            }
        )

    @property
    def team_tool_names(self) -> frozenset[str]:
        """The four board tools — separate so a nested child narrows its
        orchestration family without losing the shared plan."""
        return frozenset(
            {
                self.task_create_tool,
                self.task_claim_tool,
                self.task_complete_tool,
                self.task_list_tool,
            }
        )


@dataclass(frozen=True, slots=True)
class ChildOutcome:
    """Terminal (or snapshot) state of one child, returned by ``wait``."""

    child_id: str
    #: completed | error | cancelled | running (wait timed out, child alive)
    status: str
    answer: str


class _ChildHandle:
    def __init__(self, child_id: str, loop: CoreLoop | None) -> None:
        self.child_id = child_id
        #: ``None`` for an external (ACP) child: it has no local loop. Every
        #: local-only path checks for it rather than pretending one exists.
        self.loop = loop
        self.task: asyncio.Task[None] | None = None
        self.outcome: ChildOutcome | None = None
        #: Original spawn task (for list display and budget accounting).
        self.task_desc = ""
        #: Advertised tool schemas of the current/last run — reused on resume.
        self.schemas: list[dict[str, Any]] | None = None
        #: Terminal flag set by close()/shutdown(): a closed child rejects
        #: sends even after its run has finished.
        self.closed = False
        #: Set by ``shutdown`` only — the turn ended, not the child. Its row
        #: then settles as ``cancelled`` (resumable) rather than ``closed``:
        #: "the parent stopped waiting" is not "the user gave up on it".
        self.pool_gone = False
        #: Model-visible record snapshot at the end of the last cleanly
        #: finished run (cooperative cancel included — the loop guarantees
        #: no dangling tool_calls). ``None`` before the first clean finish;
        #: the hard-cancel backstop path leaves no resumable record.
        self.resume_messages: list[LLMMessage] | None = None
        #: Bill of the last settled run. ``None`` means either "not settled
        #: yet" or "settled without a bill" — ``usage_known`` separates the
        #: two: an external engine reports no tokens at all, while a local
        #: child that reported none is a known zero.
        self.usage: LLMUsage | None = None
        self.usage_known = True
        #: The profile this child was created under, so a usage breakdown can
        #: say which role spent the tokens.
        self.profile: str | None = None
        #: Which engine ran this child. ``coreloop`` bills tokens it can count;
        #: an external engine (ACP) reports no token bill at all, which is a
        #: different fact from "ran and reported zero".
        self.engine = "coreloop"
        #: Set only for an external child (see ``AgentPool.spawn``).
        self.acp_engine: AcpEngineSpec | None = None
        self.acp_permission: AcpPermissionPolicy | None = None
        self.acp_tool_bridge: AcpToolBridge | None = None


#: Builds a child's loop and advertised tool schemas for a child id and tool
#: filter. Owned by the driving executor (``OrchestrationExecutor`` keeps
#: depth narrowing and tool-domain narrowing in one place; the delegation
#: seam resolves the named profile's provider and round bound).
LoopFactory = Callable[
    [str, frozenset[str] | None], tuple[CoreLoop, list[dict[str, Any]] | None]
]


@dataclass(frozen=True, slots=True)
class SeedProvenance:
    """Where a fork child's seed came from.

    The child's record has to answer "why does it already know this?" without
    reading the parent's transcript, so the seed is written as one
    ``HistorySeed`` entry carrying its source record, the cut it used, and the
    model that produced the text — the same format a branch fork writes, so
    ``agent.session.tree`` reads both as the same kind of edge.
    """

    source_record_id: str
    source_until_seq: int | None = None
    source_model: str | None = None


def _usage_payload(usage: LLMUsage) -> dict[str, int]:
    """Wire shape for a child's token bill.

    Mirrors the stream's own ``usage`` keys (camelCase, ``promptTokens`` …) so a
    host that already reads the turn's usage does not learn a second spelling
    for the same numbers.
    """
    return {
        "promptTokens": usage.prompt_tokens,
        "completionTokens": usage.completion_tokens,
        "totalTokens": usage.total_tokens,
        "cachedPromptTokens": usage.cached_prompt_tokens,
    }


class AgentPool:
    """Concurrent child CoreLoops for one parent, budgeted and lineage-tracked.

    ``loop_factory`` is the default child builder; individual spawns may
    pass their own (see the module docstring for why the delegation seam
    does). ``event_sink`` receives lifecycle events (``child_spawned`` …)
    as ``(kind, data)`` — synchronous, fired inside tool execution.
    """

    def __init__(
        self,
        *,
        config: OrchestrationConfig,
        depth: int,
        lineage: str,
        loop_factory: LoopFactory | None = None,
        event_sink: Callable[[str, dict[str, Any]], None] | None = None,
        registry: ChildRegistry | None = None,
        parent_record_id: str | None = None,
        budget: TreeBudget | None = None,
        history_store: Any | None = None,
        tree: AgentTree | None = None,
    ) -> None:
        self._config = config
        self._depth = depth
        self._lineage = lineage
        self._context_namespace = next(_POOL_CONTEXT_SEQUENCE)
        self._loop_factory = loop_factory
        self._event_sink = event_sink
        self._children: dict[str, _ChildHandle] = {}
        self._seq = 0
        #: Children whose terminal outcome has already been handed to the
        #: model by ``wait_any``. A fan-out collects one answer per call, so
        #: a child that was already reported must not be reported again —
        #: otherwise "spawn five, wait five times" returns the same child
        #: five times and the other four answers are unreachable.
        self._reported: set[str] = set()
        #: Terminal notices awaiting delivery to the parent, as
        #: ``(child_id, status, answer)``. Filled by ``_settle_child`` and
        #: drained by the ``ChildNoticeHooks`` a host can install, so the
        #: parent learns a child finished without polling ``agent_wait``.
        #: A plain list, not a queue: draining happens on the same event loop
        #: and must stay ordered by settlement.
        self._notices: list[tuple[str, str, str]] = []
        #: Durable index (``registry.py``). ``None`` keeps the pool exactly
        #: as it was before the index existed: runs work, nothing is
        #: remembered across turns.
        self._registry = registry
        #: The parent's own durable record id, needed to name a child record
        #: (``<parent>:child:<lineage>``). Absent for a parent that never had
        #: one (a bare test loop), in which case children go unregistered.
        self._parent_record_id = parent_record_id
        #: One token limit for the whole tree. ``None`` means each run keeps
        #: its own accounting, which is the pre-delegation behaviour — a pool
        #: without a shared budget cannot charge siblings against each other.
        self._budget = budget
        #: The record channel. Needed only to write a fork seed's provenance
        #: into the child's own record; ``None`` keeps the legacy behaviour
        #: (the seed is just the child's opening messages).
        self._history_store = history_store
        #: Tree-wide addressing, shared by every pool in one spawn tree. Each
        #: pool registers the children it owns, so a peer message reaches an
        #: agent through the owner that can actually steer or resume it.
        #: ``None`` keeps the pre-R8 behaviour: only this pool's own children
        #: are addressable.
        self._tree = tree

    @property
    def tree(self) -> AgentTree | None:
        """The tree this pool's children register into, or ``None``.

        Exposed so another surface that shares this pool (the delegation seam)
        can give its own children the same peer-addressing tools: membership
        is a property of the tree, not of which executor built the child.
        """
        return self._tree

    def _emit(self, kind: str, data: dict[str, Any]) -> None:
        if self._event_sink is not None:
            self._event_sink(kind, data)

    def spawn(
        self,
        task: str,
        tool_filter: frozenset[str] | None,
        *,
        loop_factory: LoopFactory | None = None,
        event_extra: dict[str, Any] | None = None,
        system_prompt: str | None = None,
        profile: str | None = None,
        engine: str = "coreloop",
        seed: list[LLMMessage] | None = None,
        seed_provenance: SeedProvenance | None = None,
        acp_engine: AcpEngineSpec | None = None,
        acp_permission: AcpPermissionPolicy | None = None,
        acp_tool_bridge: AcpToolBridge | None = None,
    ) -> _ChildHandle:
        """Start a child loop immediately; returns its handle.

        ``loop_factory`` overrides the constructor's default for this spawn;
        ``event_extra`` merges into the ``child_spawned`` payload (the
        delegation seam adds the resolved ``profile`` name there).

        ``system_prompt`` seeds the child's transcript ahead of the task —
        the delegation seam passes the resolved profile's system prompt
        (CC ``.claude/agents`` body parity); without one the child starts
        from the bare task, as before.

        ``profile`` and ``engine`` are what the durable index records: resume
        rebuilds the child's tool domain and nesting from them, so a resumed
        child keeps the permissions it was created with.

        ``seed`` prepends already-built messages ahead of the task (the fork
        path); omitting it keeps the legacy ``[user(task)]`` transcript.
        ``seed_provenance`` writes those messages into the child's own record
        as one ``HistorySeed`` entry (source record, cut, producing model),
        the same shape a branch fork writes — so "why does this child already
        know that?" is answerable from its record alone.

        ``acp_engine`` switches this child to an external agent process: the
        pool then runs ``run_acp_child`` instead of a ``CoreLoop``, and the
        remaining ``acp_*`` arguments configure that run. ``loop_factory`` is
        ignored in that case (there is no local loop), and the handle's
        ``loop`` attribute is ``None``.

        Registration happens **before** the child runs, and only when this
        pool has both a registry and the parent's record id: a crash during
        the spawn then still leaves a resumable row behind, while a bare pool
        (tests, hosts without storage) behaves exactly as before.
        """
        factory = loop_factory or self._loop_factory
        if acp_engine is None and factory is None:
            raise RuntimeError(
                "AgentPool.spawn needs a loop factory — none was given at "
                "construction or per spawn"
            )
        live = [h for h in self._children.values() if h.outcome is None]
        if len(live) >= self._config.max_parallel:
            raise OrchestrationBudgetExceeded(
                f"parallel cap {self._config.max_parallel} reached "
                f"({len(live)} children running); wait for one to finish "
                "or close one before spawning again"
            )
        # A tree that already spent its budget must not start new work: the
        # child would run until its own wall and then be refused anyway, which
        # costs tokens for nothing.
        if self._budget is not None and self._budget.exhausted:
            raise OrchestrationBudgetExceeded(
                f"the turn tree has spent {self._budget.report().spent} of its "
                f"{self._budget.limit} tokens; no further children can start"
            )
        self._seq += 1
        child_id = f"{self._lineage}.{self._seq}"
        if acp_engine is not None:
            # An external child has no local loop: it is a process, driven by
            # `run_acp_child`, and its answer is the only thing that comes
            # back. The pool still owns its lifecycle, capacity and lineage.
            loop = None
            schemas = None
        else:
            assert factory is not None
            loop, schemas = factory(child_id, tool_filter)
        handle = _ChildHandle(child_id, loop)
        handle.task_desc = task
        handle.schemas = schemas
        handle.profile = profile
        handle.engine = engine
        # An engine that reports no token bill at all is "unknown", never zero:
        # the difference decides whether a turn's total can be read as complete.
        handle.usage_known = engine == "coreloop"
        handle.acp_engine = acp_engine
        handle.acp_permission = acp_permission
        handle.acp_tool_bridge = acp_tool_bridge
        self._children[child_id] = handle
        record_id = self._register_child(
            child_id, depth=self._depth + 1, profile=profile, engine=engine
        )
        self._watch_child(handle, loop)
        if seed and seed_provenance is not None and loop is not None and loop.record_id:
            # Persist the inherited prefix with its provenance *before* the
            # child's first request, so the child's record explains where its
            # opening context came from and `agent.session.tree` sees the edge.
            self._write_seed_entry(loop, seed, seed_provenance)
        child_seed = [
            *(seed or []),
            LLMMessage.text_of("user", task),
        ]
        if system_prompt:
            child_seed.insert(0, LLMMessage.text_of("system", system_prompt))
        handle.task = asyncio.ensure_future(self._run_child(handle, child_seed))
        self._join_tree(child_id, profile=profile)
        loop_record_id = loop.record_id if loop is not None else None
        self._emit(
            "child_spawned",
            {
                "childId": child_id,
                "depth": self._depth + 1,
                "task": task,
                # Present only when the factory gave the child a durable
                # record; hosts read that record to show the child's process.
                **({"recordId": loop_record_id} if loop_record_id else {}),
                **({"profile": profile} if profile else {}),
                **({"engine": engine} if engine != "coreloop" else {}),
                **(
                    {"recordId": record_id}
                    if record_id and not loop_record_id
                    else {}
                ),
                **(event_extra or {}),
            },
        )
        return handle

    def adopt(
        self,
        *,
        child_id: str,
        loop: CoreLoop,
        schemas: list[dict[str, Any]] | None,
        seed: list[LLMMessage],
        task: str = "",
        profile: str | None = None,
        engine: str = "coreloop",
        record_id: str | None = None,
    ) -> _ChildHandle:
        """Run an already-built child under an **existing** lineage id.

        Resume path: ``child_id`` (``0.2``) and the loop come from the
        registry row, so the resumed child keeps its lineage, depth and tool
        domain instead of gaining a new sequence number. It still consumes
        ``max_parallel`` capacity, because it is a real running child.
        """
        if child_id in self._children:
            handle = self._children[child_id]
            if handle.outcome is None:
                raise OrchestrationBudgetExceeded(
                    f"child {child_id!r} is already running in this pool"
                )
        live = [h for h in self._children.values() if h.outcome is None]
        if len(live) >= self._config.max_parallel:
            raise OrchestrationBudgetExceeded(
                f"parallel cap {self._config.max_parallel} reached "
                f"({len(live)} children running); wait for a child to "
                "finish before resuming this one"
            )
        handle = _ChildHandle(child_id, loop)
        handle.task_desc = task
        handle.schemas = schemas
        handle.profile = profile
        handle.engine = engine
        handle.usage_known = engine == "coreloop"
        self._children[child_id] = handle
        resumed_record = self._register_child(
            child_id,
            depth=self._depth + 1,
            profile=profile,
            engine=engine,
            record_id=record_id,
        )
        self._watch_child(handle, loop)
        handle.task = asyncio.ensure_future(self._run_child(handle, list(seed)))
        self._join_tree(child_id, profile=profile)
        self._emit(
            "child_resumed",
            {
                "childId": child_id,
                "depth": self._depth + 1,
                **({"recordId": resumed_record} if resumed_record else {}),
                **({"profile": profile} if profile else {}),
            },
        )
        return handle

    def _write_seed_entry(        self,
        loop: CoreLoop,
        seed: list[LLMMessage],
        provenance: SeedProvenance,
    ) -> None:
        """Write the fork seed into the child's record with its provenance.

        Synchronous and best-effort: ``spawn`` must not yield, and a storage
        failure must not turn a spawn into an error. The seed is also passed
        to the run, so a lost entry costs the audit trail, not the child's
        context.
        """
        store = self._history_store
        if store is None:
            return
        try:
            entry = HistorySeed(
                seq=0,
                messages=tuple(seed),
                token_estimate=0,
                source_record_id=provenance.source_record_id,
                source_until_seq=provenance.source_until_seq,
                source_model=provenance.source_model,
            )
            # A scheduling hook, not an await: the write is queued on the
            # pool's own loop and lands before the child's first request,
            # which cannot start in the same tick.
            asyncio.ensure_future(
                store.append_history(loop.record_id, [entry_to_dict(entry)])
            )
        except Exception as exc:  # noqa: BLE001 — bookkeeping never fails a spawn
            logger.warning("fork seed provenance write failed: %s", exc)

    def _join_tree(self, child_id: str, *, profile: str | None) -> None:
        """Make this child addressable by peers while it exists.

        The pool owns the loop, so it is also the thing that can deliver a
        message to it — registering here is what lets a sibling reach this
        child without knowing which executor built it.
        """
        if self._tree is None:
            return
        self._tree.register(
            TreeMember(
                lineage=child_id,
                depth=self._depth + 1,
                parent=self._lineage or None,
                profile=profile,
            ),
            lambda message, cid=child_id: self._deliver_to_peer(cid, message),
        )

    def _leave_tree(self, child_id: str) -> None:
        """Stop resolving this child's address (closed or wound down)."""
        if self._tree is not None:
            self._tree.unregister(child_id)

    async def _deliver_to_peer(self, child_id: str, message: str) -> str:
        """Deliver a peer's message to one child, asynchronously.

        ``AgentPool.send`` is synchronous because a tool call runs inside the
        loop and must answer in one step; a peer message instead arrives from
        another agent's tool call, and resuming that child means awaiting its
        new run's first step. So this routes through the same vocabulary
        ``send`` returns (``steered`` / ``resumed`` / ``error:*``) while
        allowing the resume to await.
        """
        verdict = self.send(child_id, message)
        if verdict != "resumed":
            return verdict
        handle = self._children.get(child_id)
        if handle is None or handle.task is None:
            return "resumed"
        # The resumed child is running; wait for it to settle so the sender
        # learns the outcome rather than a bare "accepted". Shielded: a
        # timeout on the sender's side must not cancel the work.
        try:
            await asyncio.shield(handle.task)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the child's own outcome carries it
            pass
        return verdict

    def _register_child(
        self,
        child_id: str,
        *,
        depth: int,
        profile: str | None,
        engine: str,
        record_id: str | None = None,
    ) -> str | None:
        """Note one child in the registry; returns the record id it uses.

        Synchronous so the row is visible to ``agent_list`` the instant
        ``spawn`` returns, and durable before the child's first model request
        (``_run_child`` awaits the write). ``spawned`` is idempotent, so
        noting here and persisting there is one row, not two.
        """
        if self._registry is None or self._parent_record_id is None:
            return None
        resolved = record_id or default_record_id(self._parent_record_id, child_id)
        self._registry.note_spawn(
            SpawnedChild(
                parent_record_id=self._parent_record_id,
                child_id=child_id,
                depth=depth,
                profile=profile,
                engine=engine,
            ),
            record_id=resolved,
        )
        return resolved

    def _watch_child(self, handle: _ChildHandle, loop: CoreLoop | None) -> None:
        """Teach the registry how to answer "is this child running now"."""
        if self._registry is None or self._parent_record_id is None:
            return
        record_id = default_record_id(self._parent_record_id, handle.child_id)
        self._registry.mark_live(record_id, lambda: handle.outcome is None)

    async def run(
        self,
        task: str,
        tool_filter: frozenset[str] | None,
        *,
        loop_factory: LoopFactory | None = None,
        event_extra: dict[str, Any] | None = None,
        system_prompt: str | None = None,
        profile: str | None = None,
        engine: str = "coreloop",
        seed: list[LLMMessage] | None = None,
        acp_engine: AcpEngineSpec | None = None,
        acp_permission: AcpPermissionPolicy | None = None,
        acp_tool_bridge: AcpToolBridge | None = None,
    ) -> ChildOutcome:
        """Synchronous delegation: spawn a child and await its terminal
        outcome. The caller's cancellation propagates into the child run
        (a parent turn cancel winds the child down with it)."""
        handle = self.spawn(
            task,
            tool_filter,
            loop_factory=loop_factory,
            event_extra=event_extra,
            system_prompt=system_prompt,
            profile=profile,
            engine=engine,
            seed=seed,
            acp_engine=acp_engine,
            acp_permission=acp_permission,
            acp_tool_bridge=acp_tool_bridge,
        )
        assert handle.task is not None
        await handle.task
        # _run_child sets the outcome on every non-cancelled exit path.
        assert handle.outcome is not None
        return handle.outcome

    async def _run_child(
        self, handle: _ChildHandle, seed: list[LLMMessage]
    ) -> None:
        # The answer is the text of the run's last model request, not every
        # round's text joined: working rounds narrate progress ("let me read
        # the file") that is not an answer. A last request without text (a
        # tool round cut by the budget wall) falls back to the most recent
        # request that produced text.
        request_text: list[str] = []
        last_text = ""
        status = "completed"
        # The spawn row is noted synchronously (so ``agent_list`` sees it at
        # once) and persisted here, before the first model request: a crash
        # after this point leaves a resumable ``interrupted`` row.
        await self._flush_child_row(handle)
        if handle.acp_engine is not None:
            await self._run_acp_child(handle, seed)
            return
        assert handle.loop is not None
        try:
            async for event in handle.loop.run(
                seed,
                tools=handle.schemas,
                chat_id=(
                    handle.loop.record_id
                    or f"subagent:{self._context_namespace}:{handle.child_id}"
                ),
            ):
                if event.kind == "llm_request":
                    last_text = "".join(request_text).strip() or last_text
                    request_text = []
                elif event.kind == "content_delta":
                    request_text.append(str(event.data.get("delta") or ""))
                elif event.kind == "completion":
                    status = str(event.data.get("status") or "completed")
        except asyncio.CancelledError:
            # Hard-cancel backstop path (close/shutdown grace expired). No
            # resume snapshot: the record may hold dangling tool_calls.
            handle.outcome = ChildOutcome(handle.child_id, "cancelled", "")
            cancelled_usage = handle.loop.last_run_usage if handle.loop else None
            handle.usage = cancelled_usage
            self._emit(
                "child_cancelled",
                {
                    "childId": handle.child_id,
                    **(
                        {"usage": _usage_payload(cancelled_usage)}
                        if cancelled_usage
                        else {}
                    ),
                },
            )
            await self._settle_child(
                handle, status="cancelled", usage=cancelled_usage
            )
            raise
        except Exception as exc:  # noqa: BLE001 — a child run can raise anything
            # (provider, executor, bugs); the pool must survive with the
            # failure recorded as the child's outcome, never an escape that
            # leaves wait() hanging on an unset outcome.
            logger.warning("child %s failed: %s", handle.child_id, exc)
            handle.outcome = ChildOutcome(handle.child_id, "error", str(exc))
            # A failed child still burned tokens before it raised; dropping
            # them under-reports the turn exactly when the user is looking for
            # what went wrong.
            failed_usage = handle.loop.last_run_usage
            handle.usage = failed_usage
            self._emit(
                "child_failed",
                {
                    "childId": handle.child_id,
                    "error": str(exc),
                    **({"usage": _usage_payload(failed_usage)} if failed_usage else {}),
                },
            )
            await self._settle_child(handle, status="error", usage=failed_usage)
            return
        # Clean finish (completion or cooperative cancel): the record has no
        # dangling tool_calls, so it is a valid resume seed for follow-ups.
        handle.resume_messages = list(handle.loop.history.projection)
        answer = "".join(request_text).strip() or last_text
        handle.outcome = ChildOutcome(handle.child_id, status, answer)
        usage = handle.loop.last_run_usage
        handle.usage = usage
        # Charge the tree before announcing: a child that pushed the tree over
        # its limit must be reported as having done so, not settled quietly
        # and letting the parent discover it on the next spawn.
        budget_exceeded: str | None = None
        if self._budget is not None:
            try:
                self._budget.charge(usage, agent=handle.child_id)
            except SessionBudgetExceeded as exc:
                budget_exceeded = str(exc)
                logger.warning("child %s crossed the tree budget: %s", handle.child_id, exc)
        kind = "child_completed" if status == "completed" else "child_failed"
        self._emit(
            kind,
            {
                "childId": handle.child_id,
                "status": status,
                # The child's own bill, on the event that announces its end:
                # a host rendering the child list needs it without a second
                # read, and a parent computing turn cost needs it before the
                # stream closes.
                **({"usage": _usage_payload(usage)} if usage is not None else {}),
                **({"budgetExceeded": budget_exceeded} if budget_exceeded else {}),
            },
        )
        await self._settle_child(handle, status=status, usage=usage)

    async def _run_acp_child(
        self, handle: _ChildHandle, seed: list[LLMMessage]
    ) -> None:
        """Run an external agent process as this child, then settle it.

        The task is the last user message in the seed (the spawn builds it
        that way); anything before it is context we cannot hand to a foreign
        engine, so only the task travels — the peer never sees our transcript.

        An engine that cannot start is reported as a failed child, not raised
        into the pool: ``spawn`` has already returned, so the caller's only
        way to learn about it is this child's outcome.
        """
        engine = handle.acp_engine
        assert engine is not None
        task = ""
        for message in reversed(seed):
            if message.role == "user":
                task = message.content_text
                break

        try:
            outcome: AcpOutcome = await run_acp_child(
                engine,
                task,
                tool_bridge=handle.acp_tool_bridge or AcpToolBridge(),
                permission=handle.acp_permission or AcpPermissionPolicy(),
                on_event=lambda event: self._emit(
                    "child_progress", {"childId": handle.child_id, **event}
                ),
            )
        except AcpUnavailable as exc:
            # The command is wrong or the peer never greeted us. Report it on
            # the child so the parent sees a failed delegation with a reason.
            handle.outcome = ChildOutcome(handle.child_id, "error", str(exc))
            handle.usage = None
            handle.usage_known = False
            self._emit(
                "child_failed", {"childId": handle.child_id, "error": str(exc)}
            )
            await self._settle_child(handle, status="error", usage=None)
            return
        except asyncio.CancelledError:
            handle.outcome = ChildOutcome(handle.child_id, "cancelled", "")
            handle.usage = None
            handle.usage_known = False
            self._emit("child_cancelled", {"childId": handle.child_id})
            await self._settle_child(handle, status="cancelled", usage=None)
            raise

        handle.outcome = ChildOutcome(handle.child_id, outcome.status, outcome.answer)
        # An external engine reports no tokens: unknown, never zero.
        handle.usage = None
        handle.usage_known = False
        kind = "child_completed" if outcome.status == "completed" else "child_failed"
        self._emit(
            kind,
            {
                "childId": handle.child_id,
                "status": outcome.status,
                **({"error": outcome.error} if outcome.error else {}),
            },
        )
        await self._settle_child(handle, status=outcome.status, usage=None)

    async def _flush_child_row(self, handle: _ChildHandle) -> None:
        """Persist this child's spawn row; no-op for an unregistered pool."""
        if self._registry is None or self._parent_record_id is None:
            return
        await self._registry.flush_spawn(
            default_record_id(self._parent_record_id, handle.child_id)
        )

    async def _settle_child(
        self, handle: _ChildHandle, *, status: str, usage: Any
    ) -> None:
        """Announce the terminal state, then write the durable row.

        The notice comes first and does not depend on the registry: telling the
        parent a child finished is useful whether or not this host persists
        anything, and a host with no storage adapter is a supported deployment.

        The row write is best-effort: a storage failure must not turn a
        finished child into an error, and an unreachable registry must not
        break a run that already produced an answer.
        """
        outcome = handle.outcome
        if outcome is not None:
            self._notices.append((handle.child_id, outcome.status, outcome.answer))
        if self._registry is None or self._parent_record_id is None:
            return
        record_id = default_record_id(self._parent_record_id, handle.child_id)
        # A closed child's row says `closed`, whatever the run it was in the
        # middle of reports. Cancelling to close produces `cancelled` from the
        # loop, and writing that would leave the row resumable again — the
        # in-memory flag dies with the pool, the row does not.
        #
        # ``shutdown`` also marks handles closed, but that is the turn
        # ending rather than the user giving up: those rows settle as
        # ``cancelled`` (resumable) and `pool_gone` is what tells them apart.
        final_status = (
            "closed" if handle.closed and not handle.pool_gone else registry_status(status)
        )
        try:
            wrote = await self._registry.finished(
                record_id,
                status=final_status,
                usage=usage,
                usage_known=handle.usage_known,
            )
            if wrote:
                self._registry.mark_settled(record_id)
        except Exception as exc:  # noqa: BLE001 — bookkeeping never fails a run
            logger.warning("child %s registry settle failed: %s", handle.child_id, exc)

    def budget_report(self) -> TreeBudgetReport | None:
        """The tree budget's snapshot, or ``None`` when this pool has none.

        Exposed so a host can report the turn's real cost (parent plus every
        child) without walking the registry, and can tell "no limit" from
        "zero spent".
        """
        return self._budget.report() if self._budget is not None else None

    def children_usage(self) -> tuple[list[dict[str, Any]], int]:
        """Per-child bills for this turn's usage record, and the unknown count.

        Only settled children appear: a child still running has not reported
        a bill yet, and inventing one would overstate the turn. ``unknown``
        counts settled children whose engine reports no tokens at all (an
        external ACP agent), so a host can mark the turn's total as partial
        instead of presenting a smaller number as complete.
        """
        entries: list[dict[str, Any]] = []
        unknown = 0
        for handle in self._children.values():
            if handle.outcome is None:
                continue
            if not handle.usage_known:
                unknown += 1
                continue
            usage = handle.usage
            entries.append(
                {
                    "childId": handle.child_id,
                    **(
                        {
                            "promptTokens": usage.prompt_tokens,
                            "completionTokens": usage.completion_tokens,
                            "totalTokens": usage.total_tokens,
                        }
                        if usage is not None
                        else {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0}
                    ),
                    **({"profile": handle.profile} if handle.profile else {}),
                }
            )
        return entries, unknown

    def drain_notices(self) -> list[tuple[str, str, str]]:
        """Take every notice awaiting delivery, oldest first.

        Draining is destructive on purpose: the parent must be told once, not
        on every subsequent step. The hook that consumes these runs at a round
        boundary, so a child finishing mid-round is delivered at the next one.
        """
        if not self._notices:
            return []
        drained = self._notices
        self._notices = []
        return drained

    def get(self, child_id: str) -> _ChildHandle | None:
        return self._children.get(child_id)

    async def wait(self, child_id: str, timeout_s: float | None) -> ChildOutcome | None:
        handle = self._children.get(child_id)
        if handle is None:
            return None
        if handle.outcome is not None:
            return handle.outcome
        assert handle.task is not None
        try:
            # Shielded: a wait timeout must not cancel the child.
            await asyncio.wait_for(
                asyncio.shield(handle.task),
                timeout=timeout_s or self._config.wait_timeout_s,
            )
        except asyncio.TimeoutError:
            return ChildOutcome(child_id, "running", "")
        return handle.outcome or ChildOutcome(child_id, "cancelled", "")

    async def wait_any(
        self,
        child_ids: Sequence[str] | None,
        timeout_s: float | None,
    ) -> tuple[ChildOutcome | None, list[str], list[str]]:
        """Wait for the **first** child to reach a terminal state.

        Returns ``(outcome, pending, unknown)``: the settled child (or ``None``
        on timeout), the ids still running, and the ids this pool has never
        heard of. Reporting all three lets the caller answer honestly instead
        of collapsing "not finished" and "no such child" into one "running".

        ``child_ids=None`` waits on every child of this pool, which is the
        fan-out case: spawn several, then wait for whichever reports first.
        Already-finished children count as immediately available — a caller
        that waits after the work is done must not block on nothing.

        Candidates exclude children already reported by an earlier ``wait_any``,
        so a fan-out collects one distinct answer per call. Passing an explicit
        ``child_ids`` overrides that: asking for a specific child means asking
        for it again, not "whatever is left".

        The wait is shielded, so a timeout never cancels a child.
        """
        if child_ids is not None:
            candidates = list(child_ids)
        else:
            candidates = [
                child_id
                for child_id in self._children
                if child_id not in self._reported
            ]
        known: list[_ChildHandle] = []
        unknown: list[str] = []
        for child_id in candidates:
            handle = self._children.get(child_id)
            if handle is None:
                unknown.append(child_id)
                continue
            # Already settled: no need to wait for anyone.
            if handle.outcome is not None:
                pending = [
                    cid for cid, h in self._children.items()
                    if h.outcome is None and cid in candidates and cid != child_id
                ]
                self._reported.add(child_id)
                return handle.outcome, pending, unknown
            known.append(handle)
        if not known:
            return None, [], unknown
        tasks = {asyncio.ensure_future(asyncio.shield(h.task)): h for h in known}
        done, pending_tasks = await asyncio.wait(
            tasks, timeout=timeout_s or self._config.wait_timeout_s,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending_tasks:
            task.cancel()
        if not done:
            return None, [h.child_id for h in known], unknown
        # Deterministic pick when several finish in the same tick: the pool's
        # own order, not the set's iteration order.
        finished = sorted(
            (tasks[task] for task in done if task in tasks),
            key=lambda h: h.child_id,
        )
        settled = finished[0]
        self._reported.add(settled.child_id)
        still_running = [
            h.child_id for h in known
            if h is not settled and h.outcome is None
        ]
        return (
            settled.outcome or ChildOutcome(settled.child_id, "cancelled", ""),
            still_running,
            unknown,
        )

    def send(self, child_id: str, message: str) -> str:
        """Deliver a message: steer a running child, resume a finished one.

        Returns ``"steered"`` / ``"resumed"`` / an ``error:*`` string the
        executor maps onto a failed ToolResult — the model needs the
        distinction to recover (e.g. spawn a fresh child after closing one).
        """
        handle = self._children.get(child_id)
        if handle is None:
            return f"error:unknown_child: {child_id!r} is not a child of this pool"
        if handle.closed:
            return f"error:child_closed: {child_id!r} is closed; spawn a new child"
        if handle.outcome is None:
            if handle.loop is None:
                # An external child is a single prompt; there is no round
                # boundary to steer at. Saying so lets the model close it and
                # spawn a fresh one with the new instruction.
                return (
                    f"error:child_not_steerable: {child_id!r} runs on an "
                    "external engine and cannot take a mid-run message"
                )
            handle.loop.steer(message)
            return "steered"
        # Follow-up turn on a finished/interrupted child. The resume seed is
        # the clean-finish record snapshot plus the new user message.
        if handle.resume_messages is None:
            return (
                f"error:child_not_resumable: {child_id!r} ended without a "
                "clean record (hard-cancelled); spawn a new child"
            )
        live = [h for h in self._children.values() if h.outcome is None]
        if len(live) >= self._config.max_parallel:
            return (
                f"error:orchestration_budget_exceeded: parallel cap "
                f"{self._config.max_parallel} reached; wait for a child to "
                "finish before resuming this one"
            )
        seed = [*handle.resume_messages, LLMMessage.text_of("user", message)]
        handle.outcome = None
        # It is running again, so its next terminal state is news: without
        # this, a resumed child would never come back from wait_any.
        self._reported.discard(child_id)
        if handle.loop is not None:
            handle.loop.reset_cancel()
        handle.task = asyncio.ensure_future(self._run_child(handle, seed))
        self._emit("child_resumed", {"childId": child_id})
        return "resumed"

    def interrupt(self, child_id: str) -> bool:
        """Cooperatively cancel the child's current turn, keeping it
        addressable: the clean-finish snapshot preserves its record and a
        later send() resumes it. False when the child is unknown, closed, or
        not running."""
        handle = self._children.get(child_id)
        if handle is None or handle.closed or handle.outcome is not None:
            return False
        self._cancel_handle(handle)
        self._emit("child_interrupted", {"childId": child_id})
        return True

    def list(self) -> list[dict[str, Any]]:
        """Snapshot of every child: id, status, task, and answer preview."""
        entries: list[dict[str, Any]] = []
        for handle in self._children.values():
            if handle.closed:
                status = "closed"
            elif handle.outcome is None:
                status = "running"
            elif handle.outcome.status == "cancelled":
                # Cooperative cancel via interrupt() — resumable, distinct
                # from a hard-cancelled (closed) child.
                status = "interrupted"
            else:
                status = handle.outcome.status
            entry: dict[str, Any] = {
                "childId": handle.child_id,
                "status": status,
                "task": handle.task_desc,
            }
            if handle.outcome is not None and handle.outcome.answer:
                entry["answerPreview"] = handle.outcome.answer[:200]
            if self.resumable(handle.child_id):
                entry["resumable"] = True
            entries.append(entry)
        return entries

    def resumable(self, child_id: str) -> bool:
        """True when the child stopped at its budget wall and ``send`` can
        continue it in place (open, finished cleanly with a resume record)."""
        handle = self._children.get(child_id)
        return (
            handle is not None
            and not handle.closed
            and handle.outcome is not None
            and handle.outcome.status == "budget_exhausted"
            and handle.resume_messages is not None
        )

    async def close(self, child_id: str) -> bool:
        handle = self._children.get(child_id)
        if handle is None:
            return False
        handle.closed = True
        # Closing is the caller's "never again": the address stops resolving
        # so a peer's message reports an unknown member instead of resuming an
        # agent the owner already gave up on.
        self._leave_tree(child_id)
        # The same promise has to reach the durable row, not just this
        # process. `send` after close is refused by `_resume_from_registry`
        # only because that row says `closed`; leaving it at its last run's
        # status let a closed child be resumed by a later turn (or by another
        # executor reading the same registry) — the in-memory flag dies with
        # the pool, the row does not.
        await self._mark_closed(handle)
        if handle.outcome is not None:
            return True
        self._cancel_handle(handle)
        assert handle.task is not None
        try:
            await asyncio.wait_for(asyncio.shield(handle.task), timeout=_CLOSE_GRACE_S)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if not handle.task.done():
                handle.task.cancel()
        return True

    async def _mark_closed(self, handle: _ChildHandle) -> None:
        """Write ``closed`` onto the child's row; best-effort like settling.

        A pool without a registry (tests, hosts without storage) keeps its
        previous behaviour, and a storage failure must not turn a close into
        an error — the in-process refusal still holds for this turn.
        """
        if self._registry is None or self._parent_record_id is None:
            return
        record_id = default_record_id(self._parent_record_id, handle.child_id)
        try:
            wrote = await self._registry.finished(
                record_id,
                status="closed",
                usage=handle.usage,
                usage_known=handle.usage_known,
            )
            if wrote:
                self._registry.mark_settled(record_id)
        except Exception as exc:  # noqa: BLE001 — bookkeeping never fails a run
            logger.warning("child %s registry close failed: %s", handle.child_id, exc)

    def _cancel_handle(self, handle: _ChildHandle) -> None:
        """Ask one child to stop, whichever engine it runs on.

        An external child has no loop to cancel: its process is owned by the
        run, so cancelling the task is what winds it down (``run_acp_child``
        cancels the peer and then kills it).
        """
        if handle.loop is not None:
            handle.loop.cancel()
        elif handle.task is not None and not handle.task.done():
            handle.task.cancel()

    async def shutdown(self) -> None:
        """Cooperatively cancel every live child; hard-cancel stragglers.

        Terminal for the whole **pool**, not for its children: a child that
        was still running when the turn ended stays resumable, so its row is
        ``cancelled`` (the run was cut short), not ``closed`` (the user gave
        up on it). ``close`` is the one that writes ``closed``, because that
        is the only path where "never again" was actually asked for.
        """
        live = [h for h in self._children.values() if h.outcome is None]
        for handle in self._children.values():
            handle.closed = True
            handle.pool_gone = True
            self._leave_tree(handle.child_id)
        for handle in live:
            self._cancel_handle(handle)
        for handle in live:
            assert handle.task is not None
            try:
                await asyncio.wait_for(
                    asyncio.shield(handle.task), timeout=_CLOSE_GRACE_S
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                if not handle.task.done():
                    handle.task.cancel()
