"""Sub-agent delegation seam — answer one tool call with a child CoreLoop.

codex and dsh both ship a delegation primitive (codex's agent tool, dsh's
subagent capability); this is the framework's equivalent: a ``ToolExecutor``
decorator that intercepts one well-known tool name and answers it by
running a bounded child ``CoreLoop`` on the same provider with a fresh
transcript.

Design:
- Depth-1 by construction: the child dispatches to the *inner* executor,
  so a child cannot spawn further agents.
- **Delegate-on-pool.** The child runs inside an ``AgentPool``
  (``pool.py``) — the same engine the six-tool orchestration family
  drives. The tool contract stays synchronous (the call returns the
  child's final answer), but execution is a pooled child run: concurrent
  profiles batch in parallel under the pool's ``max_parallel`` budget, and
  lifecycle lands on the ``event_sink`` as ``child_spawned`` /
  ``child_completed`` / ``child_failed`` events (carrying the resolved
  ``profile`` name) so hosts can render delegation live. When the host
  also enables the orchestration family it attaches the orchestration
  executor's pool (``attach_pool``) — one budget, one lineage space, and
  delegate children show up in ``agent_list``.
- In the parent trace the whole delegation is a single tool span — child
  internals stay out of the parent's event stream. With ``history_store`` +
  ``record_id_prefix`` the child instead writes its **own** durable record
  (``<prefix>:child:<lineage id>``, published on ``child_spawned`` as
  ``recordId``), which is how a host renders the delegation's process
  afterwards. Without them the child runs storage-free, as before.
- The child's answer is its accumulated assistant text at completion.
- User interaction stays with the parent. Every child receives the
  ``request_parent_input`` coordination tool instead of ``ask_user``; a
  request ends the child run and returns structured ``needs_input`` data so
  the parent can ask and re-delegate with the answers.
- Opt-out: hosts advertise ``subagent_tool_descriptor`` in the tools list
  and wrap their executor; the sidecar does both by default and
  ``params.subagent: false`` turns delegation off.
- Named profiles (CC ``subagent_type`` parity): a ``SubagentRegistry``
  maps profile names onto per-profile tool domains, round bounds, models,
  and concurrency; the tool schema advertises the names as a
  ``subagent_type`` enum and unknown names fail closed. A profile's
  ``model`` is honored through the host's ``provider_factory`` — without
  one the dispatch fails closed rather than silently running the parent's
  model.
- Privilege boundary: ``SubagentConfig.tool_filter`` narrows the child's
  tool domain (dsh ``toolFilter`` → restrict counterpart); filtered-out
  calls fail closed with ``tool_not_delegated``. Approval narrowing is not
  done here — an ``ApprovalExecutor`` outside this decorator already gates
  child calls (it is wrapped innermost, see the sidecar wiring note on
  ``SubagentExecutor``), and the child cannot spawn further agents.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from steerable_agent_protocol.generated import ToolCall, ToolResult

from .ask_user import (
    ASK_USER_SCHEMA,
    ASK_USER_TOOL_NAME,
    normalize_ask_user_questions,
)
from .errors import ToolDispatchError
from .history import completed_turn_prefix
from .llm import LLMMessage, LLMProvider
from .loop import CoreLoop, LoopConfig, LoopContext, LoopHooks, ToolExecutor
from .engines import AcpEngineSpec, AcpPermissionPolicy, AcpToolBridge
from .peer import PeerToolsExecutor, peer_schemas
from .pool import (
    AgentPool,
    LoopFactory,
    OrchestrationBudgetExceeded,
    OrchestrationConfig,
)

#: ``profile`` label on lifecycle events for a delegation that named no
#: ``subagent_type`` — mirrors the tool schema's "default general-purpose
#: profile" wording.
DEFAULT_PROFILE_LABEL = "general-purpose"

logger = logging.getLogger(__name__)
#: Child-only coordination tool. A child reports missing user-owned input to
#: its parent instead of opening an interactive question card itself.
PARENT_INPUT_TOOL_NAME = "request_parent_input"


def parent_input_tool_descriptor() -> dict[str, Any]:
    """OpenAI schema for a child to return structured questions to its parent."""
    return {
        "type": "function",
        "function": {
            "name": PARENT_INPUT_TOOL_NAME,
            "description": (
                "Report information that only the user can provide to the "
                "parent agent. Do not call ask_user from a sub-agent. After "
                "calling this tool, stop and let the parent ask the user, then "
                "re-delegate a self-contained task with the answers."
            ),
            "parameters": ASK_USER_SCHEMA,
        },
    }


@dataclass(frozen=True, slots=True)
class SubagentConfig:
    """Tunables for the delegation tool exposed by ``SubagentExecutor``.

    ``tool_filter`` narrows the child's tool domain (dsh's
    ``toolFilter`` → ``tools.restrict()`` counterpart): a frozenset of tool
    names the child may call, everything else fails closed with
    ``tool_not_delegated``. ``None`` keeps the legacy whole-domain hand-off
    (and ``allow_tools=False`` still means no tools at all). A read-only
    research sub-agent is ``tool_filter=frozenset({...read tools...})`` —
    it cannot reach the parent's write/shell tools *by construction*, which
    is what breaks the private-data + untrusted-content + egress trifecta.

    ``model`` selects a different model for the child (CC's Agent-tool
    ``model`` parity): the executor must be built with a
    ``provider_factory`` or the request fails closed. ``concurrent`` lifts
    the never-batch rule so several delegations in one round run their
    child loops in parallel (CC's concurrent-subagents parity) — each child
    is a pooled child run, so a same-round batch executes concurrently up
    to the pool's budget and the overflow delegation fails closed with
    ``orchestration_budget_exceeded``. ``max_parallel`` sizes the
    executor's own pool; it is inert once a shared pool is attached (the
    shared pool's config governs).
    """

    tool_name: str = "delegate_subagent"
    max_rounds: int = 8
    #: Consecutive tool-error breaker for the child loop. Sidecar fills this
    #: from the parent ``LoopConfig`` so a child is not silently tighter
    #: than the parent (CoreLoop's own default is 3).
    max_tool_errors: int = 3
    allow_tools: bool = True
    tool_filter: frozenset[str] | None = None
    model: str | None = None
    #: Reasoning effort for this profile's children (CC Agent-tool parity with
    #: the chat picker's per-request knob). ``None`` inherits the parent's
    #: request, which is what an unpinned profile must do: a role that did not
    #: ask for a level should reason exactly like the agent that spawned it.
    #: Honoring it needs the host's ``provider_factory``, same as ``model``.
    reasoning_effort: str | None = None
    concurrent: bool = False
    max_parallel: int = 4
    #: Profile system prompt (CC ``.claude/agents`` body parity): seeded as
    #: the child loop's first message, ahead of the task. ``None`` runs the
    #: child with no system prompt at all — the legacy behavior.
    system_prompt: str | None = None
    #: Seed this profile's children with the parent's answered transcript
    #: instead of a bare task. A profile is the right place for this default
    #: because "this kind of work continues the conversation" is a property of
    #: the role (a reviewer verifying findings), not of one call. The tool's
    #: ``context`` argument overrides it per call.
    fork_context: bool = False
    #: Run this profile's children on an external agent process instead of a
    #: local loop. ``None`` keeps the local engine. The spec carries the
    #: command; the policy and bridge say what that process may reach.
    acp_engine: AcpEngineSpec | None = None
    acp_permission: AcpPermissionPolicy | None = None
    acp_tool_bridge: AcpToolBridge | None = None
    description: str = (
        "Delegate a self-contained subtask to a sub-agent with its own "
        "reasoning loop. Good for parallelizable or context-heavy subtasks; "
        "the sub-agent returns only its final answer. If it returns status "
        "needs_input, ask the user the returned questions and then delegate "
        "again with the answers included in the task."
    )


class SubagentRegistry:
    """Named sub-agent profiles (CC ``subagent_type`` / ``.claude/agents``
    parity): a name → ``SubagentConfig`` mapping the model picks from.

    The delegation tool's schema advertises the registered names as the
    ``subagent_type`` enum; a call naming one runs the child with that
    profile's tool domain, model, and round bound. An unknown name fails
    closed listing the registered ones — never a silent fall-back to the
    default profile, which would hide a typo'd delegation.
    """

    def __init__(self) -> None:
        self._profiles: dict[str, SubagentConfig] = {}

    def register(self, name: str, config: SubagentConfig) -> None:
        if not name or not name.strip():
            raise ValueError("subagent profile name must be non-empty")
        self._profiles[name] = config

    def get(self, name: str) -> SubagentConfig | None:
        return self._profiles.get(name)

    def names(self) -> list[str]:
        return sorted(self._profiles)


def subagent_tool_descriptor(
    config: SubagentConfig | None = None,
    *,
    registry: SubagentRegistry | None = None,
    fork_available: bool = False,
) -> dict[str, Any]:
    """OpenAI tool schema to append to the parent loop's tools list.

    With a ``registry``, the schema gains a ``subagent_type`` enum of the
    registered profile names (CC ``subagent_type`` parity); without one the
    tool takes only ``task`` and runs the default profile.

    ``fork_available`` advertises the ``context`` parameter; the caller sets
    it only when the executor was given the parent transcript, so the schema
    never offers a mode that would fail.
    """
    config = config or SubagentConfig()
    properties: dict[str, Any] = {
        "task": {
            "type": "string",
            "description": (
                "Complete, self-contained instructions for the "
                "sub-agent — it sees none of this conversation unless "
                "context is \"fork\"."
            ),
        },
    }
    description = config.description
    # Advertise `context` only when a fork is actually reachable: the executor
    # cannot seed a child without the parent transcript, and offering a
    # parameter that always fails is worse than omitting it.
    if fork_available:
        properties["context"] = {
            "type": "string",
            "enum": ["fresh", "fork"],
            "description": (
                "\"fresh\" (default) starts the child with only the task. "
                "\"fork\" seeds it with this conversation's completed turns so "
                "it can continue an investigation without being retold."
            ),
        }
    if registry is not None and registry.names():
        properties["subagent_type"] = {
            "type": "string",
            "enum": registry.names(),
            "description": (
                "Named sub-agent profile to run the task with; omit for "
                "the default general-purpose profile."
            ),
        }
        # CC Agent-tool parity: the model picks a profile by what it is
        # for, not by name alone — advertise each profile's description
        # alongside its name in the tool description.
        roster = "\n".join(
            f"- {name}: {(registry.get(name) or config).description}"
            for name in registry.names()
        )
        description = f"{description}\n\nAvailable subagent_type profiles:\n{roster}"
    return {
        "type": "function",
        "function": {
            "name": config.tool_name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": ["task"],
                "additionalProperties": False,
            },
        },
    }


class _NoTools:
    """Child executor when ``allow_tools=False``: every call fails closed."""

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        return ToolResult(
            success=False,
            error="this sub-agent has no tools; answer from reasoning only",
        )


class FilteredToolsExecutor:
    """Child executor for ``tool_filter``: only the named tools delegate.

    Filtered-out calls fail closed with ``tool_not_delegated`` and the
    delegated set named, so the child can re-issue with a tool it actually
    has instead of concluding the tool is broken. Shared by the depth-1
    delegation seam and the orchestration pool.
    """

    def __init__(self, inner: ToolExecutor, allowed: frozenset[str]) -> None:
        self._inner = inner
        self._allowed = allowed

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        if call.name not in self._allowed:
            return ToolResult(
                success=False,
                error=(
                    f"tool_not_delegated: '{call.name}' is outside this "
                    f"sub-agent's tool domain; delegated tools: "
                    f"{', '.join(sorted(self._allowed)) or '(none)'}"
                ),
                needsFollowup=True,
                data={"toolNotDelegated": call.name},
            )
        return await self._inner.execute(call, ctx)

    def concurrency_safe(self, call: ToolCall) -> bool:
        inner_safe = getattr(self._inner, "concurrency_safe", None)
        return bool(inner_safe and inner_safe(call))


class _ParentInputExecutor:
    """Keep user interaction at the parent while recording child questions."""

    def __init__(
        self,
        inner: ToolExecutor,
        on_request: Callable[[dict[str, Any]], None],
    ) -> None:
        self._inner = inner
        self._on_request = on_request

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        if call.name == ASK_USER_TOOL_NAME:
            return ToolResult(
                success=False,
                error=(
                    "sub-agents cannot call ask_user directly; call "
                    f"{PARENT_INPUT_TOOL_NAME} so the parent agent can ask"
                ),
                needsFollowup=True,
            )
        if call.name != PARENT_INPUT_TOOL_NAME:
            return await self._inner.execute(call, ctx)
        intro = str(call.arguments.get("intro") or "").strip()
        if not intro:
            return ToolResult(
                success=False,
                error=f"{PARENT_INPUT_TOOL_NAME}: intro must be non-empty",
                needsFollowup=True,
            )
        try:
            questions = normalize_ask_user_questions(call.arguments.get("questions"))
        except ToolDispatchError as exc:
            return ToolResult(
                success=False,
                error=str(exc),
                needsFollowup=True,
            )
        payload = {
            "status": "needs_input",
            "intro": intro,
            "questions": questions,
            **(
                {"outro": str(call.arguments["outro"])}
                if call.arguments.get("outro") is not None
                else {}
            ),
        }
        self._on_request(payload)
        return ToolResult(
            success=True,
            terminal=True,
            message=(
                "The parent-input request was recorded. Stop this subtask "
                "and return control to the parent agent."
            ),
            data={**payload, "terminal_status": "completed"},
        )

    def concurrency_safe(self, call: ToolCall) -> bool:
        if call.name in {ASK_USER_TOOL_NAME, PARENT_INPUT_TOOL_NAME}:
            return False
        inner_safe = getattr(self._inner, "concurrency_safe", None)
        return bool(inner_safe and inner_safe(call))


def _schema_name(schema: dict[str, Any]) -> str:
    function = schema.get("function")
    if isinstance(function, dict) and function.get("name"):
        return str(function["name"])
    return str(schema.get("name") or "")


class SubagentExecutor:
    """ToolExecutor decorator: ``config.tool_name`` calls run a child loop.

    The child runs as a pooled child (``AgentPool.run``): the tool contract
    stays synchronous — the call returns the child's final answer — while
    execution, budgeting, and lifecycle events are the pool's. ``pool``
    injects a shared pool (the orchestration family's, when both surfaces
    are on); absent one the executor runs its own, sized by
    ``config.max_parallel``.

    ``provider_factory`` maps a model name onto a provider for children
    whose profile sets ``model`` (CC's per-subagent model parity); without
    one, a ``model``-bearing profile fails closed at dispatch. ``registry``
    carries the named profiles the tool schema advertises. ``tools`` is the
    parent loop's advertised schemas — children advertise the subset their
    profile delegates (minus the delegation tool itself); without it
    children run reasoning-only.

    ``history_store`` + ``record_id_prefix`` give each child its own durable
    record so a host can read the delegation's process back; both are needed
    or children stay storage-free.
    """

    def __init__(
        self,
        inner: ToolExecutor,
        provider: LLMProvider,
        config: SubagentConfig | None = None,
        *,
        hooks: LoopHooks | None = None,
        registry: SubagentRegistry | None = None,
        provider_factory: Any = None,
        tools: list[dict[str, Any]] | None = None,
        event_sink: Callable[[str, dict[str, Any]], None] | None = None,
        pool: AgentPool | None = None,
        history_store: Any = None,
        record_id_prefix: str | None = None,
        child_registry: Any = None,
        parent_projection: Callable[[], list[LLMMessage]] | None = None,
        acp_tool_bridge: AcpToolBridge | None = None,
    ) -> None:
        self._inner = inner
        self._provider = provider
        self._config = config or SubagentConfig()
        self._hooks = hooks
        self._registry = registry
        self._provider_factory = provider_factory
        self._parent_tools = list(tools or [])
        self._history_store = history_store
        self._record_id_prefix = record_id_prefix
        #: Kept for the needs-input notice: the pool owns the sink that lands
        #: `child_spawned`/`child_completed`, and a child asking its parent for
        #: input has to surface on that same channel or the panel cannot say
        #: which row is waiting on the user.
        self._event_sink = event_sink
        #: Where an external child's file and terminal requests land. ``None``
        #: means this host grants none (a bridge with no capabilities refuses        #: everything), which is the safe default for a spawned process.
        self._acp_tool_bridge = acp_tool_bridge
        #: The parent's model-visible transcript, read at delegation time.
        #: ``None`` means this host cannot fork, and the tool schema omits the
        #: parameter rather than offering one that always fails.
        self._parent_projection = parent_projection
        self._parent_input_requests: dict[str, dict[str, Any]] = {}
        #: Delegation-only hosts (orchestration off) never attach a pool that
        #: already knows about the index, so the executor's own pool needs it
        #: too — otherwise a delegated child leaves no durable row and cannot
        #: be listed or resumed after the turn.
        self._pool = pool or AgentPool(
            config=OrchestrationConfig(max_parallel=self._config.max_parallel),
            depth=0,
            lineage="0",
            event_sink=event_sink,
            registry=child_registry,
            parent_record_id=record_id_prefix,
        )

    def attach_pool(self, pool: AgentPool) -> None:
        """Adopt a shared pool — wire-time only, before the first delegation.

        The sidecar calls this with the orchestration executor's pool when
        the six-tool family is also enabled, so both multi-agent surfaces
        share one ``max_parallel`` budget and one lineage space (delegate
        children then appear in ``agent_list`` too).
        """
        self._pool = pool

    @property
    def pool(self) -> AgentPool:
        """This executor's child pool — exposed so a host can report the
        children's usage alongside the turn's own bill."""
        return self._pool

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        if call.name != self._config.tool_name:
            return await self._inner.execute(call, ctx)
        task = str(call.arguments.get("task") or "").strip()
        if not task:
            return ToolResult(success=False, error="empty task")
        config = self._config
        type_name = str(call.arguments.get("subagent_type") or "").strip()
        if type_name:
            if self._registry is None:
                return ToolResult(
                    success=False,
                    error="subagent_type given but no profiles are registered",
                    needsFollowup=True,
                )
            profile = self._registry.get(type_name)
            if profile is None:
                return ToolResult(
                    success=False,
                    error=(
                        f"unknown subagent_type {type_name!r}; registered: "
                        f"{', '.join(self._registry.names()) or '(none)'}"
                    ),
                    needsFollowup=True,
                )
            config = profile
        raw_context = str(call.arguments.get("context") or "").strip().lower()
        if raw_context and raw_context not in ("fresh", "fork"):
            return ToolResult(
                success=False,
                error=f'unknown context {raw_context!r}; expected "fresh" or "fork"',
                needsFollowup=True,
            )
        # The call's explicit choice wins; otherwise the profile decides. A
        # profile declares `fork_context` because "this role continues the
        # conversation" is a property of the role, not of one call.
        want_fork = (raw_context == "fork") if raw_context else config.fork_context
        seed: list[LLMMessage] | None = None
        if want_fork:
            if self._parent_projection is None:
                return ToolResult(
                    success=False,
                    error=(
                        'context="fork" needs the parent transcript, which this '
                        "host did not wire; use \"fresh\""
                    ),
                    needsFollowup=True,
                )
            fork_seed = completed_turn_prefix(self._parent_projection())
            # The profile's own system prompt replaces the parent's, so two
            # instructions never compete for the child's role definition.
            seed = [m for m in fork_seed if m.role != "system"] or None
        if config.model is not None and self._provider_factory is None:
            return ToolResult(
                success=False,
                error=(
                    f"sub-agent profile requests model {config.model!r} "
                    "but this host has no provider factory"
                ),
            )
        if config.reasoning_effort is not None and self._provider_factory is None:
            return ToolResult(
                success=False,
                error=(
                    f"sub-agent profile requests reasoning effort "
                    f"{config.reasoning_effort!r} but this host has no "
                    "provider factory"
                ),
            )
        try:
            outcome = await self._pool.run(
                task,
                config.tool_filter,
                loop_factory=self._loop_factory_for(config),
                event_extra={"profile": type_name or DEFAULT_PROFILE_LABEL},
                system_prompt=config.system_prompt,
                # The durable index records the resolved profile so a resumed
                # child is rebuilt with the domain it was created under. The
                # label matches what ``child_spawned`` reports, so the event
                # stream and the index never disagree about which profile ran.
                profile=type_name or DEFAULT_PROFILE_LABEL,
                seed=seed,
                **(
                    {
                        "engine": "acp",
                        "acp_engine": config.acp_engine,
                        # A profile may pin its own policy; otherwise the
                        # engine runs under the reject-by-default one.
                        "acp_permission": config.acp_permission,
                        "acp_tool_bridge": self._acp_tool_bridge,
                    }
                    if config.acp_engine is not None
                    else {}
                ),
            )
        except OrchestrationBudgetExceeded as exc:
            return ToolResult(
                success=False,
                error=f"orchestration_budget_exceeded: {exc}",
                needsFollowup=True,
            )
        parent_input = self._parent_input_requests.pop(outcome.child_id, None)
        if parent_input is not None:
            # R7-3: the panel marks the row 「等待你的回答」, and the question
            # card names the child it came from. Both read this event; neither
            # has to correlate a delegation result with a question card.
            self._emit_child_needs_input(outcome.child_id, parent_input)
            return ToolResult(
                success=True,
                message=json.dumps(parent_input, ensure_ascii=False),
                data=parent_input,
                needsFollowup=True,
                nextAction=(
                    "Parent agent: call ask_user with these questions, then "
                    "delegate again with the answers in the task."
                ),
            )
        if outcome.status != "completed":
            return ToolResult(
                success=False,
                error=f"sub-agent ended with status: {outcome.status}",
                message=outcome.answer or None,
            )
        return ToolResult(
            success=True,
            message=outcome.answer or "(sub-agent returned no text)",
        )

    def _emit_child_needs_input(
        self, child_id: str, request: dict[str, Any]
    ) -> None:
        """Announce that a child is blocked on the user.

        Carries the child's intro so the question card can say which agent is
        asking, without the host having to join a tool result against a card
        by position. Best-effort: a host without a sink still gets the
        `needs_input` tool result, which is the functional path.
        """
        if self._event_sink is None:
            return
        try:
            self._event_sink(
                "child_needs_input",
                {
                    "childId": child_id,
                    "intro": str(request.get("intro") or ""),
                },
            )
        except Exception as exc:  # noqa: BLE001 — an event never fails a run
            logger.warning("child needs-input event failed: %s", exc)

    def _loop_factory_for(self, config: SubagentConfig) -> LoopFactory:
        """Per-spawn child builder resolving the profile's provider, tool
        domain, and round bound (profiles differ per call, so the pool's
        constructor default cannot carry this)."""

        def factory(
            child_id: str, tool_filter: frozenset[str] | None
        ) -> tuple[CoreLoop, list[dict[str, Any]] | None]:
            provider = self._provider
            if config.model is not None or config.reasoning_effort is not None:
                # execute() fails closed before the spawn when a pinned
                # profile has no provider factory, so both are reachable here.
                provider = self._provider_factory(
                    config.model, config.reasoning_effort
                )
            schemas: list[dict[str, Any]] = []
            if config.allow_tools:
                schemas = [
                    schema
                    for schema in self._parent_tools
                    if _schema_name(schema) != self._config.tool_name
                    and _schema_name(schema) != ASK_USER_TOOL_NAME
                    and _schema_name(schema) != PARENT_INPUT_TOOL_NAME
                    and (tool_filter is None or _schema_name(schema) in tool_filter)
                ]
            schemas.append(parent_input_tool_descriptor())
            base: ToolExecutor = _ParentInputExecutor(
                self._child_executor(config),
                lambda payload: self._parent_input_requests.__setitem__(
                    child_id, payload
                ),
            )
            # A delegated child is a member of the turn's job: it registers in
            # the same tree the orchestration children do (the pool's
            # ``_join_tree`` does that), so it can hand a finding to a sibling
            # or answer the parent instead of routing everything back through
            # the tool result. Read from the pool rather than a constructor
            # argument because ``attach_pool`` adopts the shared pool after
            # construction — the tree is whatever that pool has.
            tree = self._pool.tree
            if tree is not None:
                # Same names as the orchestration family: a delegated child
                # and an orchestration child are one kind of peer.
                peer_config = OrchestrationConfig(
                    max_parallel=self._config.max_parallel
                )
                base = PeerToolsExecutor(
                    base, tree, peer_config, lineage=child_id
                )
                schemas = [*schemas, *peer_schemas(peer_config)]
            # A child writes its own durable record when the host gave us a
            # store and a prefix, so the delegation's process can be read
            # back afterwards (`<parent record>:child:<lineage id>`). The
            # record is the child's alone — the parent's transcript still
            # sees only the returned answer.
            record_id = (
                f"{self._record_id_prefix}:child:{child_id}"
                if self._history_store is not None and self._record_id_prefix
                else None
            )
            return (
                CoreLoop(
                    provider,
                    base,
                    LoopConfig(
                        max_rounds=config.max_rounds,
                        max_tool_errors=config.max_tool_errors,
                    ),
                    hooks=self._hooks,
                    history_store=self._history_store if record_id else None,
                    record_id=record_id,
                ),
                schemas,
            )

        return factory

    def _child_executor(self, config: SubagentConfig) -> ToolExecutor:
        if not config.allow_tools:
            return _NoTools()
        if config.tool_filter is not None:
            return FilteredToolsExecutor(self._inner, config.tool_filter)
        return self._inner

    async def shutdown(self) -> None:
        """Wind down children still running when the parent turn ends —
        hosts call this on stream teardown (a no-op twice, so a shared
        pool may also be shut down via the orchestration executor)."""
        await self._pool.shutdown()
        self._parent_input_requests.clear()

    def concurrency_safe(self, call: ToolCall) -> bool:
        # Delegation spawns a full child loop — batched with siblings only
        # when the resolved profile opts into concurrency; other calls defer
        # to the inner executor's own judgement.
        if call.name == self._config.tool_name:
            config = self._config
            type_name = str(call.arguments.get("subagent_type") or "").strip()
            if type_name and self._registry is not None:
                config = self._registry.get(type_name) or config
            return config.concurrent
        inner_safe = getattr(self._inner, "concurrency_safe", None)
        return bool(inner_safe and inner_safe(call))
