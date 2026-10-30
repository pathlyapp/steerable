"""Approval algebra: 8-variant decisions, three persistence scopes, Approver seam.

Reference: codex-rs ``protocol/src/approvals.rs`` ``ReviewDecision`` — the same
algebra: allow/deny across request/session/durable scopes, ``Denied{reason}``
fed back to the model as a tool result while the run continues, ``Abort``
ending the turn, and a fail-closed timeout variant. The framework generalizes
codex's policy-amendment variants into the durable scope (``allow_always`` /
``deny_always``) keyed by category.

Semantics of the three scopes:

- **request** (``*_once``): applies to this call only; nothing is cached.
- **session** (``*_for_session``): cached per category in a
  ``SessionApprovalCache``; the host defines "session" by the cache instance's
  lifetime (one chat, one sidecar process, …).
- **durable** (``*_always``): persisted per category in an ``ApprovalStore``
  and applied across sessions.

``ApprovalExecutor`` is a ``ToolExecutor`` decorator, so the algebra works in
front of any dispatch path — in-process router, host reverse channel, or MCP
invoker — instead of being baked into one registry.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Protocol, cast, runtime_checkable

from steerable_agent_harness.policy import ToolMode, decide_tool_mode
from steerable_agent_protocol.generated import ToolCall, ToolResult

from .errors import ApprovalAborted
from .sandboxed import DEFAULT_SHELL_TOOLS

if TYPE_CHECKING:
    from .loop import LoopContext, ToolExecutor

logger = logging.getLogger(__name__)

__all__ = [
    "APPROVAL_KINDS",
    "ApprovalDecision",
    "ApprovalExecutor",
    "ApprovalKind",
    "ApprovalRequest",
    "ApprovalStore",
    "Approver",
    "AutoApprover",
    "WorkspaceAutoApprover",
    "declared_resolver",
    "InMemoryApprovalStore",
    "JsonApprovalStore",
    "SessionApprovalCache",
]

#: The 8 decision variants. Codex's ``ApprovedExecpolicyAmendment`` /
#: ``ApprovedMcpPolicyAmendment`` / ``NetworkPolicyAmendment`` are codex's
#: policy machinery; the framework's durable scope covers their semantics
#: without the amendment payloads.
ApprovalKind = Literal[
    "allow_once",
    "allow_for_session",
    "allow_always",
    "deny_once",
    "deny_for_session",
    "deny_always",
    "abort",
    "timed_out",
]

_ALLOW_KINDS = frozenset({"allow_once", "allow_for_session", "allow_always"})
_SESSION_KINDS = frozenset({"allow_for_session", "deny_for_session"})
_DURABLE_KINDS = frozenset({"allow_always", "deny_always"})
#: All valid kinds — wire decoders validate against this set.
APPROVAL_KINDS = frozenset(
    _ALLOW_KINDS | _SESSION_KINDS | _DURABLE_KINDS | {"abort", "timed_out"}
)


@dataclass(frozen=True, slots=True)
class ApprovalDecision:
    """One approval verdict. ``reason`` is model-visible on deny/abort."""

    kind: ApprovalKind
    reason: str = ""

    @property
    def allowed(self) -> bool:
        """Whether the call may execute (any allow variant)."""
        return self.kind in _ALLOW_KINDS


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    """What the approver decides on.

    ``category`` is the persistence key for session/durable variants — all
    calls sharing a category share a cached decision. It defaults to the tool
    name; hosts with parameterized risk (e.g. a shell tool) can pass a
    resolver that categorizes by command class instead.

    ``call_id`` is the originating tool call's id, for approver channels that
    correlate the prompt with the tool call in the UI (ACP
    ``session/request_permission`` requires it). Empty for synthesized
    requests.
    """

    tool_name: str
    arguments: dict[str, Any]
    mode: ToolMode
    category: str
    round_index: int = 0
    call_id: str = ""


@runtime_checkable
class Approver(Protocol):
    """The approval seam: given a request, return a decision.

    Implementations must not raise for ordinary denials — return a deny
    variant. Raising is reserved for infrastructure failure and surfaces as a
    tool error, not a denial.
    """

    async def approve(self, request: ApprovalRequest) -> ApprovalDecision: ...


_PATH_ARG_TOOLS = {
    "local_read_file": "path",
    "local_write_file": "path",
    "local_edit_file": "path",
    "view_image": "path",
}


def _front_load_markers(
    data: dict[str, Any] | None, approval_marker: dict[str, Any] | None
) -> dict[str, Any]:
    """Put sandbox and approval markers ahead of the tool payload.

    A published loop keeps only the first 300 characters of the result
    preview and, for a sibling that finished before a terminal tool in
    the same batch, does not copy those markers onto the event. They
    have to be readable from that prefix.
    """
    body = dict(data or {})
    sandbox = body.pop("_sandbox", None)
    approval = (
        approval_marker.get("_approval")
        if approval_marker is not None
        else body.get("_approval")
    )
    body.pop("_approval", None)
    ordered: dict[str, Any] = {}
    if isinstance(sandbox, dict):
        ordered["_sandbox"] = sandbox
    if isinstance(approval, dict):
        ordered["_approval"] = approval
    ordered.update(body)
    return ordered


def declared_target_paths(request: ApprovalRequest) -> list[str] | None:
    """Filesystem targets of a path-scoped tool, or None when the call is not one.

    ``None`` means this approver cannot prove the call from its path
    arguments. Shell commands are judged separately, from the sandbox and
    the working directory, not from the command text.
    """
    if request.tool_name == "present_files":
        files = request.arguments.get("files")
        if not isinstance(files, list) or not files:
            return None
        paths: list[str] = []
        for item in files:
            if not isinstance(item, dict):
                return None
            raw = item.get("path")
            if not isinstance(raw, str) or not raw.strip():
                return None
            paths.append(raw.strip())
        return paths
    key = _PATH_ARG_TOOLS.get(request.tool_name)
    if key is None:
        return None
    raw = request.arguments.get(key)
    if not isinstance(raw, str) or not raw.strip():
        return None
    return [raw.strip()]


def path_inside_writable_roots(
    raw: str,
    roots: list[str],
    *,
    pathmod: Any | None = None,
    base: str | None = None,
) -> bool:
    """True when ``raw`` is the configured directory or one of its subdirectories.

    Relative paths are project-relative. When ``base`` is the project home,
    they are joined to that directory and then compared like absolute paths,
    so a symlink inside the project that points outside is not inside.
    Without ``base``, a relative path is inside unless it starts with ``..``.
    Absolute paths must sit under one of ``roots`` after symbolic links are
    resolved, so ``/tmp`` and ``/private/tmp`` are the same directory.
    Windows compares paths without letter case, so
    ``c:\\work\\repo\\a.txt`` is inside ``C:\\Work\\Repo``. ``pathmod`` selects
    the path implementation; production uses ``os.path``.
    """
    paths = os.path if pathmod is None else pathmod
    expanded = paths.expanduser(raw.strip())
    if not paths.isabs(expanded):
        if isinstance(base, str) and base.strip():
            expanded = paths.normpath(paths.join(paths.expanduser(base.strip()), expanded))
        else:
            normalized = paths.normpath(expanded)
            return normalized != ".." and not normalized.startswith(".." + paths.sep)
    target = paths.realpath(expanded)
    for root in roots:
        if not isinstance(root, str) or not root.strip():
            continue
        root_abs = paths.realpath(paths.expanduser(root.strip()))
        try:
            common = paths.commonpath([target, root_abs])
        except ValueError:
            continue
        if paths.normcase(common) == paths.normcase(root_abs):
            return True
    return False


def shell_stays_in_workspace(
    request: ApprovalRequest,
    roots: list[str],
    *,
    base: str | None = None,
) -> bool:
    """True when a shell call's working directory is inside a writable root.

    The command text is not parsed. Confinement is the OS sandbox's job:
    writes outside the roots fail there. An omitted cwd uses the host's
    project directory. An explicit cwd outside the roots, or one that
    climbs out with ``..``, still needs a prompt.
    """
    if request.tool_name not in DEFAULT_SHELL_TOOLS or not roots:
        return False
    cwd = request.arguments.get("cwd")
    if cwd is None:
        return True
    if not isinstance(cwd, str) or not cwd.strip():
        return True
    return path_inside_writable_roots(cwd, roots, base=base)


class WorkspaceAutoApprover:
    """Skip the host prompt for work the workspace sandbox already confines.

    Embedders may also name host-owned control tools whose effects are limited
    to internal session state and therefore need no interactive consent.
    A ``read`` mode call with no filesystem target skips the prompt. Path-scoped
    tools (``local_write_file``, ``local_edit_file``, reads, ``present_files``)
    still skip only when every declared path is inside a writable root — a
    ``read`` declaration does not open a path outside those roots. Shell tools
    skip only when the OS exec sandbox is on and the working directory is
    inside those roots. The allow is request-scoped. The next call is judged
    again. Anything else falls through to the inner approver.
    """

    def __init__(
        self,
        inner: Approver,
        writable_roots: list[str],
        *,
        sandbox_enforced: bool = False,
        auto_allow_tools: tuple[str, ...] = (),
        path_base: str | None = None,
    ) -> None:
        self._inner = inner
        self._roots = [root for root in writable_roots if isinstance(root, str) and root.strip()]
        self._sandbox_enforced = sandbox_enforced
        self._auto_allow_tools = frozenset(auto_allow_tools)
        self._path_base = path_base.strip() if isinstance(path_base, str) and path_base.strip() else None

    def set_sandbox_enforced(self, enforced: bool) -> None:
        """Match a mid-turn sandbox toggle.

        Shell auto-approval is only valid while the OS sandbox is actually
        confining the command. Full access turns that off, so the next shell
        call has to ask again.
        """
        self._sandbox_enforced = enforced

    async def approve(self, request: ApprovalRequest) -> ApprovalDecision:
        if request.tool_name in self._auto_allow_tools:
            return ApprovalDecision("allow_once", "trusted host control tool")
        paths = declared_target_paths(request)
        if (
            self._roots
            and paths is not None
            and all(
                path_inside_writable_roots(path, self._roots, base=self._path_base)
                for path in paths
            )
        ):
            return ApprovalDecision("allow_once", "path is inside a writable project root")
        if request.mode == "read" and paths is None:
            return ApprovalDecision("allow_once", "declared read-only tool")
        if self._sandbox_enforced and shell_stays_in_workspace(
            request, self._roots, base=self._path_base
        ):
            return ApprovalDecision("allow_once", "command stays inside the workspace sandbox")
        return await self._inner.approve(request)


class AutoApprover:
    """Headless approver: never blocks, decides by tool mode.

    Modes in ``allow_modes`` auto-approve once; everything else auto-denies
    once with ``deny_reason`` — per-category automatic denial is what keeps a
    headless run from hanging on a prompt nobody will answer.
    """

    def __init__(
        self,
        *,
        allow_modes: tuple[ToolMode, ...] = ("read", "safe_write"),
        deny_reason: str = "no interactive approver is attached (headless run)",
    ) -> None:
        self._allow_modes = frozenset(allow_modes)
        self._deny_reason = deny_reason

    async def approve(self, request: ApprovalRequest) -> ApprovalDecision:
        if request.mode in self._allow_modes:
            return ApprovalDecision("allow_once")
        return ApprovalDecision("deny_once", self._deny_reason)


class SessionApprovalCache:
    """Session scope: per-category decisions for the cache instance's lifetime."""

    def __init__(self) -> None:
        self._decisions: dict[str, ApprovalKind] = {}

    def get(self, category: str) -> ApprovalKind | None:
        return self._decisions.get(category)

    def put(self, category: str, kind: ApprovalKind) -> None:
        if kind not in _SESSION_KINDS:
            raise ValueError(f"not a session-scope kind: {kind}")
        self._decisions[category] = kind


@runtime_checkable
class ApprovalStore(Protocol):
    """Durable scope: per-category decisions persisted across sessions."""

    def load(self) -> dict[str, ApprovalKind]:
        """All persisted ``category → kind`` entries (empty on first use)."""
        ...

    def put(self, category: str, kind: ApprovalKind) -> None:
        """Persist one entry, replacing any existing decision for the category."""
        ...


class InMemoryApprovalStore:
    """Non-durable ``ApprovalStore`` for tests and ephemeral hosts."""

    def __init__(self) -> None:
        self._decisions: dict[str, ApprovalKind] = {}

    def load(self) -> dict[str, ApprovalKind]:
        return dict(self._decisions)

    def put(self, category: str, kind: ApprovalKind) -> None:
        if kind not in _DURABLE_KINDS:
            raise ValueError(f"not a durable-scope kind: {kind}")
        self._decisions[category] = kind


class JsonApprovalStore:
    """File-backed durable store: one JSON object ``{category: kind}``.

    Writes are atomic (tmp file + rename) so a crash mid-write cannot leave a
    truncated file that would fail every future load.
    """

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    def load(self) -> dict[str, ApprovalKind]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError) as exc:
            # A corrupt store must fail closed, not crash the run: treating it
            # as empty re-asks the approver instead of auto-allowing.
            logger.warning("approval store %s unreadable (%s); ignoring", self._path, exc)
            return {}
        return {
            str(category): kind
            for category, kind in raw.items()
            if kind in _DURABLE_KINDS
        }

    def put(self, category: str, kind: ApprovalKind) -> None:
        if kind not in _DURABLE_KINDS:
            raise ValueError(f"not a durable-scope kind: {kind}")
        decisions = self.load()
        decisions[category] = kind
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(decisions, handle, ensure_ascii=False, indent=1)
            os.replace(tmp, self._path)
        except BaseException:
            os.unlink(tmp)
            raise


def _default_resolver(call: ToolCall, ctx: LoopContext) -> ApprovalRequest:
    """Classify by tool name via the harness policy table; category = name."""
    return ApprovalRequest(
        tool_name=call.name,
        arguments=call.arguments or {},
        mode=decide_tool_mode(call.name),
        category=call.name,
        round_index=ctx.round_index,
        call_id=call.id,
    )


#: Modes a host may declare on a tool. A declared value in this set is kept.
#: Missing or unknown values fall back to ``decide_tool_mode``. Keeping a
#: declared ``external`` stops a ``get_`` prefix from widening the call to read.
TOOL_MODES = frozenset(
    {
        "read",
        "safe_write",
        "destructive",
        "other",
        "external",
        "local",
        "ui",
        "synthetic",
        "auto_local",
    }
)


def _tool_declared_name(tool: dict[str, Any]) -> str | None:
    name = tool.get("name")
    if isinstance(name, str) and name:
        return name
    function = tool.get("function")
    if isinstance(function, dict):
        nested = function.get("name")
        if isinstance(nested, str) and nested:
            return nested
    return None


def _tool_declared_field(tool: dict[str, Any], key: str) -> Any:
    if key in tool:
        return tool.get(key)
    function = tool.get("function")
    if isinstance(function, dict) and key in function:
        return function.get(key)
    return None


def declared_resolver(
    tools: list[Any] | None,
) -> Any:
    """Build an approval resolver from ``agent.chat.stream`` tools.

    Each tool may carry optional ``mode`` and ``approvalCategory``, either on
    the tool object or under ``function``. Tools without those fields, and
    calls whose name is absent from the list, use name inference and the tool
    name as the category. Old hosts that omit the fields keep the previous
    behavior.
    """
    declared: dict[str, tuple[Any, Any]] = {}
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        name = _tool_declared_name(tool)
        if name is None:
            continue
        declared[name] = (
            _tool_declared_field(tool, "mode"),
            _tool_declared_field(tool, "approvalCategory"),
        )

    def resolve(call: ToolCall, ctx: LoopContext) -> ApprovalRequest:
        mode, category = declared.get(call.name, (None, None))
        resolved_mode = (
            mode if isinstance(mode, str) and mode in TOOL_MODES else decide_tool_mode(call.name)
        )
        resolved_category = category if isinstance(category, str) and category else call.name
        return ApprovalRequest(
            tool_name=call.name,
            arguments=call.arguments or {},
            mode=cast(ToolMode, resolved_mode),
            category=resolved_category,
            round_index=ctx.round_index,
            call_id=call.id,
        )

    return resolve


class ToolTimeoutClock:
    """Pauses the loop's tool cap while an approval prompt is unanswered.

    The cap still covers the command after the user decides. The object is
    shared through a contextvar so the waiting tool and ``ApprovalExecutor``
    see the same clock.
    """

    def __init__(self) -> None:
        self._depth = 0
        self.resumed = asyncio.Event()
        self.resumed.set()
        self.paused = asyncio.Event()

    def suspend(self) -> None:
        self._depth += 1
        self.resumed.clear()
        self.paused.set()

    def resume(self) -> None:
        self._depth = max(0, self._depth - 1)
        if self._depth == 0:
            self.paused.clear()
            self.resumed.set()

    @property
    def suspended(self) -> bool:
        return self._depth > 0


tool_timeout_clock: contextvars.ContextVar[ToolTimeoutClock | None] = contextvars.ContextVar(
    "tool_timeout_clock", default=None
)


class ApprovalExecutor:
    """``ToolExecutor`` decorator enforcing the approval algebra.

    Resolution order per call: durable store → session cache → approver.
    Session/durable variants are persisted on first decision and short-circuit
    later calls in the same category. Deny variants return a failed
    ``ToolResult`` (the model sees ``Denied{reason}`` and the run continues);
    ``abort`` raises ``ApprovalAborted``; ``timed_out`` fails closed as a
    denial that keeps the variant name for observability.

    On allow, ``ctx.consent_granted`` is set so a downstream
    ``RouterToolExecutor``'s ``require_consent`` gate recognizes the approval
    instead of double-gating. Every call still passes through this decorator
    first, so the bridge cannot bypass approval.
    """

    def __init__(
        self,
        inner: ToolExecutor,
        approver: Approver,
        *,
        session: SessionApprovalCache | None = None,
        store: ApprovalStore | None = None,
        resolve: Any | None = None,
        timeout_s: float | None = None,
    ) -> None:
        self._inner = inner
        self._approver = approver
        self._session = session
        self._store = store
        self._resolve = resolve or _default_resolver
        self._timeout_s = timeout_s
        self._durable: dict[str, ApprovalKind] | None = None

    def concurrency_safe(self, call: ToolCall) -> bool:
        check = getattr(self._inner, "concurrency_safe", None)
        return bool(check is not None and check(call))

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        request = self._resolve(call, ctx)
        stored = self._stored_decision(request)
        decision = stored
        # A fresh decision records the wait so the trace can show approval
        # latency. A session allow reused from the cache carries `cached`
        # instead, so the tool row can say the call was already allowed.
        waited_ms: int | None = None
        if decision is None:
            ask_started = time.monotonic()
            decision = await self._ask(request)
            waited_ms = int((time.monotonic() - ask_started) * 1000)
            self._persist(request, decision)

        if stored is not None and stored.kind == "allow_for_session":
            approval_marker = {
                "_approval": {
                    "kind": "allow_for_session",
                    "category": request.category,
                    "cached": True,
                }
            }
        elif waited_ms is not None:
            approval_marker = {
                "_approval": {
                    "kind": decision.kind,
                    "category": request.category,
                    "waitMs": waited_ms,
                }
            }
        else:
            approval_marker = None

        if decision.kind == "abort":
            raise ApprovalAborted(
                decision.reason or f"tool call '{request.tool_name}' aborted by approval"
            )
        if not decision.allowed:
            reason = decision.reason or "denied by approval policy"
            return ToolResult(
                success=False,
                error="approval_denied",
                needsFollowup=True,
                data={
                    "approval": decision.kind,
                    "category": request.category,
                    "reason": reason,
                    **(approval_marker or {}),
                    "message": (
                        f"Tool call '{request.tool_name}' was denied "
                        f"({decision.kind}): {reason}"
                    ),
                },
            )
        ctx.consent_granted = True
        result = await self._inner.execute(call, ctx)
        data = result.data if isinstance(result.data, dict) else None
        if approval_marker is not None or (data is not None and "_sandbox" in data):
            result = result.model_copy(
                update={"data": _front_load_markers(data, approval_marker)}
            )
        return result

    def _stored_decision(self, request: ApprovalRequest) -> ApprovalDecision | None:
        """Durable wins over session: it is the stronger commitment."""
        durable = self._durable_decisions().get(request.category)
        if durable is not None:
            return ApprovalDecision(
                durable, f"persisted decision for category '{request.category}'"
            )
        if self._session is not None:
            session_kind = self._session.get(request.category)
            if session_kind is not None:
                return ApprovalDecision(
                    session_kind,
                    f"session decision for category '{request.category}'",
                )
        return None

    def _durable_decisions(self) -> dict[str, ApprovalKind]:
        if self._store is None:
            return {}
        if self._durable is None:
            self._durable = self._store.load()
        return self._durable

    async def _ask(self, request: ApprovalRequest) -> ApprovalDecision:
        # No timeout means wait until the user decides. That wait is not
        # part of the tool cap; the command after the decision still is.
        clock = tool_timeout_clock.get() if self._timeout_s is None else None
        if clock is not None:
            clock.suspend()
        try:
            if self._timeout_s is None:
                return await self._approver.approve(request)
            try:
                return await asyncio.wait_for(
                    self._approver.approve(request), timeout=self._timeout_s
                )
            except (TimeoutError, asyncio.TimeoutError):
                # Fail closed, keeping the variant for observability (codex's
                # TimedOut semantics: no decision arrived, do not execute).
                return ApprovalDecision(
                    "timed_out", f"approval request timed out after {self._timeout_s}s"
                )
        finally:
            if clock is not None:
                clock.resume()

    def _persist(self, request: ApprovalRequest, decision: ApprovalDecision) -> None:
        if decision.kind in _SESSION_KINDS and self._session is not None:
            self._session.put(request.category, decision.kind)
        elif decision.kind in _DURABLE_KINDS:
            if self._store is not None:
                self._store.put(request.category, decision.kind)
                if self._durable is not None:
                    self._durable[request.category] = decision.kind
            elif self._session is not None:
                # A host approver returned a durable variant without wiring a
                # store — degrade to session scope loudly rather than silently
                # dropping the persistence the user asked for.
                logger.warning(
                    "no ApprovalStore configured; degrading %s for category %r "
                    "to session scope",
                    decision.kind,
                    request.category,
                )
                self._session.put(
                    request.category,
                    "allow_for_session"
                    if decision.kind == "allow_always"
                    else "deny_for_session",
                )
