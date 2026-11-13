"""Multi-agent orchestration — a parent CoreLoop driving parallel children.

Extends the depth-1 delegation seam (``subagent.py``) into the framework's
orchestration layer (P3.1): a pool of concurrent child ``CoreLoop`` instances
with coordination primitives the parent model drives through six tools —
``agent_spawn`` / ``agent_send`` / ``agent_wait`` / ``agent_close`` /
``agent_list`` / ``agent_interrupt``. The pool itself lives in ``pool.py``
(re-exported here) and also backs the single-tool delegation seam.

Design:
- **Lineage as data.** Child ids are ``<lineage>.<seq>`` (root ``0``), so
  ``0.2`` is the root's second child and ``0.2.1`` its first grandchild.
  Every tool result carries the id as structured JSON — the parent record
  alone rebuilds who was spawned and how they ended.
- **Budgets fail closed.** ``max_parallel`` and ``max_depth`` refuse at the
  boundary (``orchestration_budget_exceeded`` / no orchestration tools in
  the child), never silently queue. Depth is structural: a child only has
  orchestration tools when its own executor nests another
  ``OrchestrationExecutor``, which happens iff ``depth + 1 < max_depth``.
- **Coordination reuses loop primitives.** ``agent_send`` to a running child
  is ``loop.steer``; to a finished child it is a follow-up turn seeded from
  the clean-finish record snapshot (multi-turn children). ``agent_interrupt``
  is the cooperative ``loop.cancel()`` that keeps the child addressable;
  ``agent_close`` adds a hard-cancel backstop and a terminal closed flag —
  a closed child winds down with a consistent record, same as a
  user-cancelled turn, and rejects further sends.
- **Children stay out of the parent record.** A child's transcript is its
  own loop's; the parent sees spawn/wait/close results. Hosts that want
  child traces subscribe via ``event_sink`` (lifecycle events with lineage)
  or wrap children in their own hooks.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from steerable_agent_protocol.generated import ToolCall, ToolResult

from .spend import TreeSpend
from .hooks import ChainHooks, CompletionAction, CompletionDraft, NoopHooks
from .history import completed_turn_prefix
from .llm import LLMMessage, LLMProvider
from .loop import CoreLoop, LoopConfig, LoopContext, LoopHooks, ToolExecutor
from .peer import PeerToolsExecutor, peer_schemas, send_tool_descriptor, tool_schema
from .pool import (
    AgentPool,
    ChildOutcome,
    OrchestrationBudgetExceeded,
    OrchestrationConfig,
    SeedProvenance,
)
from .registry import ChildRegistry, default_record_id
from .resume import load_history_transcript
from .subagent import FilteredToolsExecutor, _schema_name
from .team_board import TeamTaskBoard
from .tree import AgentTree, TreeMember

logger = logging.getLogger(__name__)

__all__ = [
    "AgentPool",
    "ChildOutcome",
    "ChildBudgetWrapUp",
    "ForkRoute",
    "OrchestrationBudgetExceeded",
    "OrchestrationConfig",
    "OrchestrationExecutor",
    "PeerToolsExecutor",
    "orchestration_tool_descriptors",
    "send_tool_descriptor",
    "team_tool_descriptors",
]

#: Terminal status of a run stopped by ``max_rounds`` or the token budget.
_BUDGET_WALL_STATUS = "budget_exhausted"

_BUDGET_WRAP_UP_REQUEST = (
    "[system notice] This run has used its round budget and tools are now "
    "withheld. Answer the original task now from what you have already "
    "gathered: give your concrete findings first, then list what you could "
    "not finish or verify. Do not describe the steps you took."
)

_RESUME_HINT = (
    "The child stopped at its round budget; `answer` is its interim report. "
    "To continue, agent_send this childId a message naming what is still "
    "missing — it resumes with its prior context and a fresh budget. Do not "
    "spawn a new child for the same task."
)


@dataclass(frozen=True, slots=True)
class ForkRoute:
    """How a fork child's model route relates to its parent's.

    A fork is allowed to run on a different model or effort — the parent's
    findings are the input, and the cheapest way to check them is often a
    smaller model. The cost of doing that is real and has to be visible, not
    silent: the parent's cached prompt prefix belongs to the parent's model,
    so the child's first request is a full re-prefill, and the same
    transcript is then interpreted by two different models.
    """

    parent_model: str | None
    child_model: str | None
    parent_effort: str | None
    child_effort: str | None

    @property
    def diverged(self) -> bool:
        """True when the fork re-reads the parent history on a different route."""
        return (self.parent_model, self.parent_effort) != (
            self.child_model,
            self.child_effort,
        )

    def to_wire(self) -> dict[str, str | None]:
        """The `forkRoute` object a spawn result carries."""
        return {
            "parentModel": self.parent_model,
            "childModel": self.child_model,
            "parentEffort": self.parent_effort,
            "childEffort": self.child_effort,
        }


class ChildBudgetWrapUp(NoopHooks):
    """``before_completion``: one no-tools answer round at a child's budget wall.

    Without it a child stopped by ``max_rounds`` or the token budget returns
    whatever text its last working round produced — usually a progress note,
    not an answer. The parent then gets ``budget_exhausted`` with nothing
    usable. The ``narrate`` action runs one round without tools and keeps the
    ``budget_exhausted`` status, so the parent can still tell the answer is
    interim and resume the child with ``agent_send``.

    One instance per child loop. A resumed child runs the same loop with a new
    ``LoopContext``, so the one-round limit applies per run.
    """

    def __init__(self) -> None:
        self._wrapped_run: LoopContext | None = None

    async def before_completion(
        self, draft: CompletionDraft, ctx: LoopContext
    ) -> CompletionAction:
        """Narrate once per run when the draft stops at the budget wall."""
        if draft.status != _BUDGET_WALL_STATUS or self._wrapped_run is ctx:
            return CompletionAction(kind="accept")
        self._wrapped_run = ctx
        return CompletionAction(
            kind="narrate",
            message=_BUDGET_WRAP_UP_REQUEST,
            reason="child_budget_wrap_up",
        )


def orchestration_tool_descriptors(
    config: OrchestrationConfig | None = None,
) -> list[dict[str, Any]]:
    """OpenAI tool schemas for the four orchestration tools."""
    config = config or OrchestrationConfig()

    fn = tool_schema

    return [
        fn(
            config.spawn_tool,
            "Spawn a sub-agent with its own reasoning loop to work on a "
            "self-contained task concurrently. Returns immediately with a "
            "childId. For independent subtasks, emit several agent_spawn "
            "calls in ONE message: they run in parallel up to the pool's "
            "concurrency limit, and a call beyond that limit fails while the "
            "earlier ones keep running. Collect answers with agent_wait, "
            "which returns whichever child settles first.",
            {
                "task": {
                    "type": "string",
                    "description": (
                        "Complete, self-contained instructions for the "
                        "sub-agent — it sees none of this conversation unless "
                        "context is \"fork\"."
                    ),
                },
                "toolFilter": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional allow-list of tool names the child may "
                        "call; omitted delegates the full tool domain."
                    ),
                },
                "context": {
                    "type": "string",
                    "enum": ["fresh", "fork"],
                    "description": (
                        "\"fresh\" (default) starts the child with only the "
                        "task. \"fork\" seeds it with this conversation's "
                        "completed turns — the questions that were answered "
                        "and the tool work behind them — so a child can "
                        "continue an investigation without being told again. "
                        "An in-flight turn is excluded: its tool calls have "
                        "no results yet."
                    ),
                },
                "model": {
                    "type": "string",
                    "description": (
                        "Model for the child. Requires context=\"fork\": a "
                        "fresh child has no parent route to diverge from. "
                        "The parent's cached prompt prefix does not apply to "
                        "another model, so the result reports "
                        "cacheNote=\"cold\"."
                    ),
                },
                "reasoningEffort": {
                    "type": "string",
                    "description": (
                        "Reasoning effort for the child; context=\"fork\" "
                        "required, same as model."
                    ),
                },
            },
            ["task"],
        ),
        send_tool_descriptor(config),
        fn(
            config.wait_tool,
            "Wait for the first sub-agent to finish and return its outcome. "
            "Omit childIds to wait for whichever unfinished child of this "
            "pool settles first — after spawning several, one wait collects "
            "one answer. Pass childIds to restrict the wait to those. A child "
            "still running at the timeout returns status 'running' with the "
            "ids still pending. A child that hit its round budget returns "
            "status 'budget_exhausted' with an interim answer and "
            "resumable: true — continue it with agent_send instead of "
            "spawning a new child.",
            {
                "childId": {"type": "string"},
                "childIds": {"type": "array", "items": {"type": "string"}},
                "timeoutMs": {"type": "integer"},
            },
            [],
        ),
        fn(
            config.close_tool,
            "Close a sub-agent terminally: cooperative cancel with a "
            "hard-cancel backstop, and the child rejects further sends. "
            "Use agent_interrupt instead to pause a child you still need.",
            {"childId": {"type": "string"}},
            ["childId"],
        ),
        fn(
            config.list_tool,
            "List this job's agents with their status (running / "
            "completed / error / cancelled / interrupted / closed), task, "
            "and a preview of finished answers. `members` names every live "
            "agent in this job with the lineage id to message (`self` is "
            "yours), which is how you address a sibling or the root.",
            {},
            [],
        ),
        fn(
            config.interrupt_tool,
            "Interrupt a running sub-agent's current turn (cooperative "
            "cancel) while keeping it addressable: its context is preserved "
            "and a later agent_send resumes it. Unlike agent_close this is "
            "not terminal.",
            {"childId": {"type": "string"}},
            ["childId"],
        ),
    ]


def team_tool_descriptors(
    config: OrchestrationConfig | None = None,
) -> list[dict[str, Any]]:
    """OpenAI tool schemas for the shared task board (R8).

    The board moves the plan out of any one context: the agent that split the
    job writes items down, workers claim them, and anyone can see what is left.
    The tools are only advertised when a board is wired, so a host that did not
    opt in never sees them.
    """
    config = config or OrchestrationConfig()

    def fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
        return {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": False,
                },
            },
        }

    return [
        fn(
            config.task_create_tool,
            "Add a unit of work to the shared board so any agent in this "
            "job can see it. Use this when splitting work across agents: "
            "write the items once here instead of repeating them in every "
            "task you hand out. Returns the task id.",
            {
                "title": {
                    "type": "string",
                    "description": "One line naming the work.",
                },
                "detail": {
                    "type": "string",
                    "description": (
                        "Optional specifics the claimant needs — files, "
                        "acceptance, constraints."
                    ),
                },
                "dependsOn": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Task ids that must finish before this one can be "
                        "claimed. Ids come from earlier team_task_create "
                        "results."
                    ),
                },
            },
            ["title"],
        ),
        fn(
            config.task_claim_tool,
            "Claim a task from the shared board before working on it. "
            "Claiming is what stops two agents doing the same item: it "
            "fails if the task is taken, done, or still blocked by a "
            "dependency. Omit taskId to claim the first ready item. A "
            "refusal lists what is still claimable.",
            {
                "taskId": {
                    "type": "string",
                    "description": "Exact task id; omit to take the first ready one.",
                },
            },
            [],
        ),
        fn(
            config.task_complete_tool,
            "Mark a task you claimed as done, optionally recording what you "
            "found or changed. Completing unblocks tasks that depend on it.",
            {
                "taskId": {"type": "string"},
                "note": {
                    "type": "string",
                    "description": "Optional outcome note for whoever reads the board.",
                },
            },
            ["taskId"],
        ),
        fn(
            config.task_list_tool,
            "List the shared board: every item with its status, owner, and "
            "dependencies, plus a per-status count.",
            {},
            [],
        ),
    ]


class TeamToolExecutor:
    """ToolExecutor decorator: the four shared-board tools.

    Its own decorator rather than part of ``OrchestrationExecutor`` because
    the board is orthogonal to the spawn family: a leaf child has no
    ``agent_spawn`` but must still see the plan and claim from it. Keeping the
    two apart is what lets that child be a full participant without gaining
    the ability to spawn.
    """

    def __init__(
        self,
        inner: ToolExecutor,
        board: TeamTaskBoard,
        config: OrchestrationConfig,
        *,
        lineage: str,
    ) -> None:
        self._inner = inner
        self._board = board
        self._config = config
        #: Who claims and completes — the caller's lineage id, so the board
        #: answers "who is doing this" without a second registry.
        self._lineage = lineage

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        if call.name == self._config.task_create_tool:
            return self._create(call)
        if call.name == self._config.task_claim_tool:
            return self._claim(call)
        if call.name == self._config.task_complete_tool:
            return self._complete(call)
        if call.name == self._config.task_list_tool:
            return self._list()
        return await self._inner.execute(call, ctx)

    def _create(self, call: ToolCall) -> ToolResult:
        title = str(call.arguments.get("title") or "").strip()
        if not title:
            return ToolResult(success=False, error="empty title")
        raw_deps = call.arguments.get("dependsOn")
        depends_on = (
            tuple(str(dep).strip() for dep in raw_deps if str(dep).strip())
            if isinstance(raw_deps, list)
            else ()
        )
        detail = str(call.arguments.get("detail") or "").strip() or None
        try:
            item = self._board.create(
                title=title,
                detail=detail,
                depends_on=depends_on,
                created_by=self._lineage,
            )
        except KeyError as exc:
            return ToolResult(
                success=False, error=str(exc.args[0]), needsFollowup=True
            )
        return ToolResult(
            success=True, message=json.dumps(item.to_wire()), data={"taskId": item.id}
        )

    def _claim(self, call: ToolCall) -> ToolResult:
        task_id = str(call.arguments.get("taskId") or "").strip()
        if not task_id:
            ready = self._board.ready()
            if not ready:
                return ToolResult(
                    success=False,
                    error=(
                        "no_ready_task: nothing is unclaimed and unblocked; "
                        f"board: {json.dumps(self._board.summary())}"
                    ),
                    needsFollowup=True,
                )
            task_id = ready[0].id
        try:
            item = self._board.claim(task_id, owner=self._lineage)
        except (KeyError, ValueError) as exc:
            return ToolResult(
                success=False,
                error=f"claim_refused: {exc.args[0]}",
                needsFollowup=True,
            )
        return ToolResult(
            success=True,
            message=json.dumps(item.to_wire()),
            data={"taskId": item.id, "status": item.status},
        )

    def _complete(self, call: ToolCall) -> ToolResult:
        task_id = str(call.arguments.get("taskId") or "").strip()
        if not task_id:
            return ToolResult(success=False, error="empty taskId")
        note = str(call.arguments.get("note") or "").strip() or None
        try:
            item = self._board.complete(task_id, owner=self._lineage, note=note)
        except (KeyError, ValueError) as exc:
            return ToolResult(
                success=False,
                error=f"complete_refused: {exc.args[0]}",
                needsFollowup=True,
            )
        return ToolResult(
            success=True,
            message=json.dumps(item.to_wire()),
            data={"taskId": item.id, "status": item.status},
        )

    def _list(self) -> ToolResult:
        payload = {
            "tasks": [item.to_wire() for item in self._board.items()],
            "summary": self._board.summary(),
        }
        return ToolResult(
            success=True,
            message=json.dumps(payload),
            data={"count": len(self._board.items())},
        )

    def dedup_exempt(self, call: ToolCall) -> bool:
        # Claim is stateful: the same arguments twice must observe the second
        # refusal, not a cached first success.
        if call.name in self._config.team_tool_names:
            return True
        inner_exempt = getattr(self._inner, "dedup_exempt", None)
        return bool(inner_exempt and inner_exempt(call))

    def concurrency_safe(self, call: ToolCall) -> bool:
        # Every board call mutates or reads shared state; running two claim
        # attempts concurrently would defeat the exclusivity the board exists
        # for.
        if call.name in self._config.team_tool_names:
            return False
        inner_safe = getattr(self._inner, "concurrency_safe", None)
        return bool(inner_safe and inner_safe(call))


class OrchestrationExecutor:
    """ToolExecutor decorator: the six orchestration tools drive an AgentPool.

    ``tools`` is the parent loop's advertised schemas — children advertise
    the subset their ``toolFilter`` delegates (minus the orchestration
    family, re-added only when the depth budget allows the child its own
    pool). Without it children run reasoning-only, matching the legacy
    subagent seam.
    """

    def __init__(
        self,
        inner: ToolExecutor,
        provider: LLMProvider,
        config: OrchestrationConfig | None = None,
        *,
        tools: list[dict[str, Any]] | None = None,
        hooks: LoopHooks | None = None,
        event_sink: Callable[[str, dict[str, Any]], None] | None = None,
        registry: ChildRegistry | None = None,
        history_store: Any | None = None,
        parent_record_id: str | None = None,
        parent_projection: Callable[[], list[LLMMessage]] | None = None,
        spend: TreeSpend | None = None,
        parent_route: Callable[[], tuple[str | None, str | None]] | None = None,
        provider_factory: Callable[[str | None, str | None], LLMProvider] | None = None,
        tree: AgentTree | None = None,
        team_board: TeamTaskBoard | None = None,
        _depth: int = 0,
        _lineage: str = "0",
    ) -> None:
        #: The executor children are built from, and peers' tool calls land
        #: on. Kept unwrapped so the board decorator below is applied exactly
        #: once per agent.
        self._inner = inner
        self._provider = provider
        self._config = config or OrchestrationConfig()
        self._parent_tools = list(tools or [])
        self._hooks = hooks
        self._event_sink = event_sink
        self._registry = registry
        #: The parent's durable record channel. Children get their own record
        #: under ``<parent>:child:<lineage>`` so their reasoning is readable
        #: afterwards (``delegate_subagent`` already does this; without the
        #: same wiring here, the two multi-agent surfaces report differently).
        self._history_store = history_store
        self._parent_record_id = parent_record_id
        #: The parent's model-visible transcript, read lazily at spawn time.
        #: A callable rather than a list because the parent keeps appending
        #: between the executor's construction and a ``fork`` spawn — a
        #: snapshot taken at construction would seed the child with a stale
        #: conversation. ``None`` means this executor cannot fork (the caller
        #: did not wire it), and ``context: "fork"`` then fails closed rather
        #: than silently degrading to ``fresh``.
        self._parent_projection = parent_projection
        #: The parent's model route, read lazily for the same reason as the
        #: projection: the loop that answers it is built after this executor.
        #: Only the fork path reads it, and only to say whether the child is
        #: re-reading the prefix on a different route.
        self._parent_route = parent_route
        #: Rebuilds a provider at another model/effort. Only a cross-model
        #: fork needs it; without one, `agent_spawn` cannot change the route
        #: and says so instead of silently ignoring the request.
        self._provider_factory = provider_factory
        #: Tree-wide addressing (R8). Shared down the whole spawn tree so a
        #: child can message a sibling, its parent, or its own children. Each
        #: pool registers only the agents it owns; delivery goes through the
        #: owner. ``None`` keeps the pre-R8 reach: this pool's children only.
        self._tree = tree
        #: The shared board (R8). One per tree, so every member reads and
        #: writes the same plan. ``None`` leaves the team tools unadvertised.
        self._team_board = team_board
        #: The board decorator, built once so this agent's own calls and its
        #: children's share one implementation.
        self._team = (
            TeamToolExecutor(
                self._inner, team_board, self._config, lineage=_lineage
            )
            if team_board is not None
            else None
        )
        #: The tree's shared token limit; ``None`` keeps per-run accounting.
        self._spend = spend
        self._depth = _depth
        self._lineage = _lineage
        self._pool = AgentPool(
            config=self._config,
            depth=_depth,
            lineage=_lineage,
            loop_factory=self._child_loop,
            event_sink=event_sink,
            registry=registry,
            parent_record_id=parent_record_id,
            spend=spend,
            # Needed to write a fork seed's provenance into the child's record.
            history_store=history_store,
            tree=tree,
        )

    @property
    def pool(self) -> AgentPool:
        """This executor's pool — exposed so the delegation seam can share
        it (one ``max_parallel`` budget and one lineage space across both
        multi-agent surfaces; see the sidecar wiring)."""
        return self._pool

    # ------------------------------------------------------------------
    # child construction
    # ------------------------------------------------------------------

    def _child_record_id(self, child_id: str) -> str | None:
        """The child's own durable record id, or ``None`` without a parent
        record: a host that never persisted the parent has nothing to name
        the child's log after."""
        if self._parent_record_id is None:
            return None
        return default_record_id(self._parent_record_id, child_id)

    def _child_loop(
        self,
        child_id: str,
        tool_filter: frozenset[str] | None,
        *,
        depth: int | None = None,
        provider: LLMProvider | None = None,
    ) -> tuple[CoreLoop, list[dict[str, Any]] | None]:
        """Build a child loop and its advertised tools.

        ``depth`` defaults to this executor's depth + 1 (the fresh-spawn
        case). Resume passes the child's **recorded** depth instead: a child
        created when ``max_depth`` was 1 must not gain orchestration tools
        because the setting was later raised — the nesting decision is a
        permission, so it follows creation, not the current configuration.

        ``provider`` overrides the parent's for this child (a cross-model
        fork). The default keeps the parent's, which is the only route a
        same-model fork may use.
        """
        child_depth = self._depth + 1 if depth is None else depth
        child_provider = provider or self._provider
        base: ToolExecutor = self._inner
        if tool_filter is not None:
            base = FilteredToolsExecutor(base, tool_filter)
        orch_names = self._config.tool_names
        schemas = [
            schema
            for schema in self._parent_tools
            if _schema_name(schema) not in orch_names
            and (tool_filter is None or _schema_name(schema) in tool_filter)
        ]
        # A nested executor is built before the loop that will drive it (the
        # loop needs the executor), yet its fork seed must come from that very
        # loop's transcript. This holder breaks the cycle: the executor reads
        # through the closure at spawn time, by which point the loop exists.
        own_loop: list[CoreLoop] = []
        if child_depth < self._config.max_depth:
            base = OrchestrationExecutor(
                base,
                child_provider,
                self._config,
                tools=schemas,
                hooks=self._hooks,
                event_sink=self._event_sink,
                registry=self._registry,
                history_store=self._history_store,
                # The grandchild's record hangs off the child's, so a trace
                # walks down the lineage the same way the ids do.
                parent_record_id=self._child_record_id(child_id),
                parent_projection=lambda: (
                    own_loop[0].history.projection if own_loop else []
                ),
                spend=self._spend,
                # Same tree and board: a grandchild is as much a member of the
                # job as its parent, and the plan it reads must be the one the
                # root wrote.
                tree=self._tree,
                team_board=self._team_board,
                _depth=child_depth,
                _lineage=child_id,
            )
            schemas = [*schemas, *orchestration_tool_descriptors(self._config)]
        elif self._tree is not None:
            # A leaf cannot delegate, but it is still a member of the job:
            # without a send it could only report through the completion
            # notice, which carries no reply path. Messaging is a tree
            # property, not a depth permission.
            base = PeerToolsExecutor(
                base, self._tree, self._config, lineage=child_id
            )
            schemas = [*schemas, *peer_schemas(self._config)]
        # The board is advertised to every child regardless of nesting: a
        # worker that cannot spawn anyone still needs to see the plan and
        # claim from it, which is why the board is not part of the
        # orchestration family.
        if self._team_board is not None:
            base = TeamToolExecutor(
                base, self._team_board, self._config, lineage=child_id
            )
            schemas = [*schemas, *team_tool_descriptors(self._config)]
        wrap_up = ChildBudgetWrapUp()
        loop = CoreLoop(
            child_provider,
            base,
            LoopConfig(
                max_rounds=self._config.child_max_rounds,
                max_tool_errors=self._config.child_max_tool_errors,
            ),
            hooks=wrap_up if self._hooks is None else ChainHooks(self._hooks, wrap_up),
            history_store=self._history_store,
            record_id=self._child_record_id(child_id),
        )
        own_loop.append(loop)
        return loop, schemas or None

    # ------------------------------------------------------------------
    # ToolExecutor
    # ------------------------------------------------------------------

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        if call.name == self._config.spawn_tool:
            return await self._spawn(call)
        if call.name == self._config.send_tool:
            return await self._send(call)
        if call.name == self._config.wait_tool:
            return await self._wait(call)
        if call.name == self._config.close_tool:
            return await self._close(call)
        if call.name == self._config.list_tool:
            return await self._list(call)
        if call.name == self._config.interrupt_tool:
            return await self._interrupt(call)
        if call.name in self._config.team_tool_names:
            # The board layer answers only when a board was wired; otherwise
            # this agent has no plan to read and says so instead of letting the
            # call fall through to an executor that does not know the name.
            if self._team_board is None:
                return ToolResult(
                    success=False,
                    error=(
                        "team_board_unavailable: this turn has no shared task "
                        "board; work from the tasks you were given"
                    ),
                    needsFollowup=True,
                )
            return await self._team.execute(call, ctx)
        return await self._inner.execute(call, ctx)

    async def _spawn(self, call: ToolCall) -> ToolResult:
        task = str(call.arguments.get("task") or "").strip()
        if not task:
            return ToolResult(success=False, error="empty task")
        raw_filter = call.arguments.get("toolFilter")
        tool_filter = (
            frozenset(str(t) for t in raw_filter)
            if isinstance(raw_filter, list)
            else None
        )
        profile = str(call.arguments.get("subagent_type") or "").strip() or None
        raw_context = str(call.arguments.get("context") or "fresh").strip().lower()
        if raw_context not in ("fresh", "fork"):
            return ToolResult(
                success=False,
                error=f'unknown context {raw_context!r}; expected "fresh" or "fork"',
                needsFollowup=True,
            )
        # A fork may run on another model/effort; a fresh child has no
        # inherited route to diverge from, so a model there is a request the
        # six-tool family cannot honour (it has no profile registry).
        child_model = str(call.arguments.get("model") or "").strip() or None
        child_effort = (
            str(call.arguments.get("reasoningEffort") or "").strip() or None
        )
        child_provider: LLMProvider | None = None
        route: ForkRoute | None = None
        if child_model or child_effort:
            if raw_context != "fork":
                return ToolResult(
                    success=False,
                    error=(
                        "changing model or reasoningEffort needs "
                        'context="fork": a fresh child has no parent route to '
                        "diverge from. Name a subagent_type instead, or fork."
                    ),
                    needsFollowup=True,
                )
            if self._provider_factory is None:
                return ToolResult(
                    success=False,
                    error=(
                        "this host cannot build a provider for another model; "
                        "spawn with the parent's route"
                    ),
                    needsFollowup=True,
                )
            parent_model, parent_effort = (
                self._parent_route() if self._parent_route is not None else (None, None)
            )
            route = ForkRoute(
                parent_model=parent_model,
                child_model=child_model or parent_model,
                parent_effort=parent_effort,
                child_effort=child_effort or parent_effort,
            )
            child_provider = self._provider_factory(
                child_model, child_effort
            )
        seed: list[LLMMessage] | None = None
        seed_provenance: SeedProvenance | None = None
        if raw_context == "fork":
            if self._parent_projection is None:
                return ToolResult(
                    success=False,
                    error=(
                        'context="fork" needs the parent transcript, which this '
                        "host did not wire; use \"fresh\""
                    ),
                    needsFollowup=True,
                )
            fork_seed = completed_turn_prefix(
                self._parent_projection(), max_turns=self._config.fork_turns
            )
            if not fork_seed:
                # Nothing answered yet: a fork has nothing to inherit. Falling
                # back to a fresh child is the honest outcome — the alternative
                # is a child that believes it has context it was never given.
                seed = None
            else:
                # The parent's system prompt describes the parent's job. A
                # child carrying it alongside its own would be two competing
                # instructions, so the seed keeps only the conversation; the
                # child's own system message (below, if any) takes that slot.
                seed = [m for m in fork_seed if m.role != "system"]
                if self._parent_record_id is not None and seed:
                    # Record where this came from: the child's own record must
                    # answer "why does it already know that?" without reading
                    # the parent's transcript. The producing model is recorded
                    # even for a same-model fork — the question "which model
                    # wrote this history" has an answer either way.
                    parent_model = (
                        route.parent_model
                        if route is not None
                        else (
                            self._parent_route()[0]
                            if self._parent_route is not None
                            else None
                        )
                    )
                    seed_provenance = SeedProvenance(
                        source_record_id=self._parent_record_id,
                        source_model=parent_model,
                    )
        try:
            # ``profile`` is recorded, not resolved: the six-tool family has no
            # profile registry (``delegate_subagent`` owns that). It reaches the
            # index so a resumed child is rebuilt with the same label; the tool
            # domain here comes from ``toolFilter`` alone.
            handle = self._pool.spawn(
                task,
                tool_filter,
                profile=profile,
                seed=seed,
                seed_provenance=seed_provenance,
                **(
                    {
                        "loop_factory": (
                            lambda child_id, filter_: self._child_loop(
                                child_id, filter_, provider=child_provider
                            )
                        )
                    }
                    if child_provider is not None
                    else {}
                ),
            )
        except OrchestrationBudgetExceeded as exc:
            return ToolResult(
                success=False,
                error=f"orchestration_budget_exceeded: {exc}",
                needsFollowup=True,
            )
        payload: dict[str, Any] = {
            "childId": handle.child_id,
            "depth": self._depth + 1,
            "status": "running",
        }
        record_id = handle.loop.record_id
        if record_id:
            payload["recordId"] = record_id
        if route is not None and route.diverged:
            # Not an error: the fork succeeded. But its first request re-reads
            # the whole parent prefix on a route whose prompt cache does not
            # exist, and the same transcript is now interpreted by two models.
            # Saying so is what keeps that cost explainable afterwards.
            payload["cacheNote"] = "cold"
            payload["forkRoute"] = route.to_wire()
            payload["usageNote"] = "crossModelFork"
        return ToolResult(
            success=True,
            message=json.dumps(payload),
            data={"childId": handle.child_id},
        )

    async def _send(self, call: ToolCall) -> ToolResult:
        child_id = str(call.arguments.get("childId") or "")
        message = str(call.arguments.get("message") or "").strip()
        if not message:
            return ToolResult(success=False, error="empty message")
        outcome = self._pool.send(child_id, message)
        if outcome.startswith("error:"):
            # The pool only knows the children of this turn. Two other
            # destinations are legitimate, and both are tried before refusing:
            # a tree member that some other executor owns (a sibling, or this
            # agent's own parent), then a child from an earlier turn, which is
            # rebuilt from its durable row.
            peer = await self._send_to_tree(child_id, message)
            if peer is not None:
                return peer
            resumed = await self._resume_from_registry(child_id, message)
            if resumed is not None:
                return resumed
            return ToolResult(
                success=False,
                error=outcome[len("error:"):],
                needsFollowup=True,
            )
        return ToolResult(
            success=True,
            message=json.dumps({"childId": child_id, "delivery": outcome}),
            data={"childId": child_id, "delivery": outcome},
        )

    async def _send_to_tree(self, target: str, message: str) -> ToolResult | None:
        """Deliver to a member this pool does not own, if the tree has it.

        Returns ``None`` when there is no tree, or the target is not a member —
        the caller then falls through to the durable-index resume, so the
        refusals stay in one place with one wording.

        Delivery goes through the owner, which may steer a running agent or
        resume a settled one. A resume can take a while (the owner waits for
        the first step), so the verdict reports what happened rather than
        pretending the message was merely queued.
        """
        if self._tree is None:
            return None
        member = self._tree.get(target)
        if member is None:
            return None
        verdict = await self._tree.send(self._lineage, target, message)
        if verdict.startswith("error:"):
            return ToolResult(
                success=False,
                error=verdict[len("error:"):],
                needsFollowup=True,
            )
        return ToolResult(
            success=True,
            message=json.dumps(
                {
                    "childId": target,
                    "delivery": verdict,
                    "depth": member.depth,
                }
            ),
            data={"childId": target, "delivery": verdict},
        )

    async def _resume_from_registry(
        self, child_id: str, message: str
    ) -> ToolResult | None:
        """Re-run a child that this pool never had, from its durable row.

        Returns ``None`` when there is nothing to resume (no registry, no
        row, a closed child, or no record to seed from) — the caller then
        reports the pool's own error, so the model sees one consistent
        message either way.

        The rebuilt child keeps its **recorded** profile and depth: resume
        must not gain permissions the child never had, and a depth-1 child
        that was not allowed to spawn must not be able to after a resume.
        """
        if self._registry is None or self._parent_record_id is None:
            return None
        view = await self._registry.find_child(self._parent_record_id, child_id)
        if view is None or view.record.status == "closed":
            return None
        if view.live:
            # It is running in a pool we cannot see (another executor sharing
            # the registry). Steering it is not ours to do; say so.
            return ToolResult(
                success=False,
                error=(
                    f"child_busy: {child_id!r} is running under another pool; "
                    "wait for it to finish before sending"
                ),
                needsFollowup=True,
            )
        record_id = view.record.record_id
        seed_messages = await self._resume_seed(record_id, message)
        if seed_messages is None:
            return ToolResult(
                success=False,
                error=(
                    f"child_not_resumable: {child_id!r} has no readable record; "
                    "spawn a new child"
                ),
                needsFollowup=True,
            )
        loop, schemas = self._child_loop(child_id, None, depth=view.record.depth)
        try:
            self._pool.adopt(
                child_id=child_id,
                loop=loop,
                schemas=schemas,
                seed=seed_messages,
                profile=view.record.profile,
                engine=view.record.engine,
                record_id=record_id,
            )
        except OrchestrationBudgetExceeded as exc:
            return ToolResult(
                success=False,
                error=f"orchestration_budget_exceeded: {exc}",
                needsFollowup=True,
            )
        return ToolResult(
            success=True,
            message=json.dumps(
                {
                    "childId": child_id,
                    "delivery": "resumed",
                    "recordId": record_id,
                    "profile": view.record.profile,
                    "depth": view.record.depth,
                }
            ),
            data={"childId": child_id, "delivery": "resumed"},
        )

    async def _resume_seed(
        self, record_id: str, message: str
    ) -> list[LLMMessage] | None:
        """The child's recorded transcript plus the new user message."""
        if self._history_store is None:
            return None
        try:
            transcript = await load_history_transcript(self._history_store, record_id)
        except Exception as exc:  # noqa: BLE001 — a bad record is not a crash
            logger.warning("resume seed for %s unavailable: %s", record_id, exc)
            return None
        if transcript is None:
            return None
        return [*transcript, LLMMessage.text_of("user", message)]

    async def _list(self, call: ToolCall) -> ToolResult:
        """Every child of this session, plus every agent this one can message.

        The pool is per turn, so on its own it answers "what is running"; the
        durable index answers "what did this session spawn". Merging both is
        what makes the tool useful in a later turn, which is the whole point
        of R1 — a child that finished three turns ago is still listed.

        ``members`` is the second answer, and it is the one ``agent_send``
        needs: it names every live address in this job — this agent's children,
        its siblings, and the root — because a worker that has to route a
        finding sideways cannot look up an id it was never told. Both keys are
        present so a host reading the older one keeps working.
        """
        entries = self._pool.list()
        seen = {entry["childId"] for entry in entries}
        if self._registry is not None and self._parent_record_id is not None:
            for view in await self._registry.list_for_parent(self._parent_record_id):
                if view.record.child_id in seen:
                    continue
                entries.append(
                    {
                        "childId": view.record.child_id,
                        "status": view.status,
                        "recordId": view.record.record_id,
                        **(
                            {"profile": view.record.profile}
                            if view.record.profile
                            else {}
                        ),
                        "depth": view.record.depth,
                        **({"resumable": True} if view.resumable else {}),
                    }
                )
        payload: dict[str, Any] = {"children": entries}
        if self._tree is not None:
            payload["members"] = [
                member.to_wire() for member in self._tree.members()
            ]
            payload["self"] = self._lineage
        return ToolResult(
            success=True,
            message=json.dumps(payload),
            data={"count": len(entries)},
        )

    async def _interrupt(self, call: ToolCall) -> ToolResult:
        child_id = str(call.arguments.get("childId") or "")
        if not self._pool.interrupt(child_id):
            return ToolResult(
                success=False,
                error=(
                    f"unknown_or_not_running: {child_id!r} — only a running, "
                    "unclosed child can be interrupted"
                ),
                needsFollowup=True,
            )
        return ToolResult(
            success=True,
            message=json.dumps({"childId": child_id, "interrupted": True}),
            data={"childId": child_id},
        )

    async def _wait(self, call: ToolCall) -> ToolResult:
        """Wait for the first child to settle.

        Three accepted shapes, because the useful question differs by context:

        - ``childId`` — wait for that one (the original contract);
        - ``childIds`` — wait for whichever of those settles first;
        - neither — wait for any unfinished child of this pool, which is what
          makes "spawn several, then collect" one call instead of N.
        """
        single = str(call.arguments.get("childId") or "").strip()
        raw_ids = call.arguments.get("childIds")
        if single and isinstance(raw_ids, list):
            return ToolResult(
                success=False,
                error="pass either childId or childIds, not both",
                needsFollowup=True,
            )
        child_ids: list[str] | None
        if single:
            child_ids = [single]
        elif isinstance(raw_ids, list):
            child_ids = [str(item) for item in raw_ids]
        else:
            child_ids = None
        raw_timeout = call.arguments.get("timeoutMs")
        timeout_s = (
            float(raw_timeout) / 1000.0
            if isinstance(raw_timeout, (int, float))
            else None
        )
        outcome, pending, unknown = await self._pool.wait_any(child_ids, timeout_s)
        if outcome is None:
            if unknown and not pending:
                return ToolResult(
                    success=False,
                    error=f"unknown_child: {', '.join(unknown)}",
                    needsFollowup=True,
                )
            # Nobody settled within the timeout: report who is still going so
            # the model can decide to wait again rather than re-spawn.
            return ToolResult(
                success=True,
                message=json.dumps(
                    {
                        "status": "running",
                        "pending": pending,
                        **({"unknown": unknown} if unknown else {}),
                    }
                ),
                data={"status": "running", "pending": pending},
            )
        payload: dict[str, Any] = {
            "childId": outcome.child_id,
            "status": outcome.status,
            "answer": outcome.answer,
        }
        if pending:
            payload["pending"] = pending
        if unknown:
            payload["unknown"] = unknown
        if self._pool.resumable(outcome.child_id):
            payload["resumable"] = True
            payload["hint"] = _RESUME_HINT
        return ToolResult(
            success=True,
            message=json.dumps(payload),
            data={"childId": outcome.child_id, "status": outcome.status},
        )

    async def _close(self, call: ToolCall) -> ToolResult:
        child_id = str(call.arguments.get("childId") or "")
        if not await self._pool.close(child_id):
            return ToolResult(
                success=False,
                error=f"unknown_child: {child_id!r}",
                needsFollowup=True,
            )
        return ToolResult(
            success=True, message=json.dumps({"childId": child_id, "closed": True})
        )

    async def shutdown(self) -> None:
        """Wind down every live child — hosts call this when the parent run ends."""
        await self._pool.shutdown()

    def dedup_exempt(self, call: ToolCall) -> bool:
        # Every orchestration tool is stateful: identical args yield different
        # results as pool state evolves (a second spawn creates a NEW child,
        # a second wait observes the resumed run). The loop's same-turn
        # duplicate_call guard would break legitimate sequences like
        # wait → send → wait, so the family opts out; inner tools keep the
        # guard unless the inner executor exempts them. The board tools are in
        # the same family for the same reason: two `team_task_claim` calls
        # without a taskId are distinct claims of different items, and the
        # second must observe the board's new state rather than a cached
        # first result.
        if call.name in self._config.tool_names or call.name in self._config.team_tool_names:
            return True
        inner_exempt = getattr(self._inner, "dedup_exempt", None)
        return bool(inner_exempt and inner_exempt(call))

    def concurrency_safe(self, call: ToolCall) -> bool:
        """Whether this call may run alongside its siblings in one round.

        ``agent_spawn`` is safe to batch even though it consumes the bounded
        parallel pool: ``AgentPool.spawn`` is fully synchronous, so capacity is
        checked and reserved without ever yielding to the event loop. Concurrent
        spawns therefore reserve **in call order**, and a call beyond the cap is
        the one that fails — deterministic, not scheduler-dependent. That is
        what makes "emit several spawns in one message" a supported fan-out
        rather than a race.

        ``send`` / ``close`` / ``interrupt`` stay serial: they mutate an
        existing child's lifecycle, and interleaving them with a sibling's
        spawn would make the observed state depend on execution order.
        """
        if call.name in {
            self._config.spawn_tool,
            self._config.wait_tool,
            self._config.list_tool,
        }:
            return True
        if call.name in {
            self._config.send_tool,
            self._config.close_tool,
            self._config.interrupt_tool,
        }:
            return False
        if call.name in self._config.team_tool_names:
            # A claim must see the board a sibling claim left behind, so a
            # round that emits several of them runs them in order.
            return False
        inner_safe = getattr(self._inner, "concurrency_safe", None)
        return bool(inner_safe and inner_safe(call))
