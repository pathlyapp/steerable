"""Sub-agents that are not our own CoreLoop: an external agent over ACP.

A child pool so far has meant "a second CoreLoop on the same provider". This
module is the other kind: the parent hands a task to a separate agent process
— Codex, Claude Code, another Steerable — and gets back only its final answer.
The protocol is the Agent Client Protocol (ACP), which the sidecar already
speaks as a server, so the same adapter can be spawned as the peer.

Three decisions shape this module:

- **The parent waits for one answer.** Streamed agent text and tool calls are
  mapped onto the pool's child events so a host can render progress, but the
  child's outcome is the answer text plus the prompt's stop reason.
- **Permissions are a fixed, engine-level policy.** The tool titles and option
  labels a foreign agent sends are its own prose, not our tool names, so
  routing them to the user's approval UI would ask the user to authorize text
  nobody validated. The policy reads only the ACP tool *kind* (`read`,
  `execute`, …) and answers allow or reject.
- **No token bill.** The engine does not report tokens, so the child's usage
  is unknown, never zero — the turn's total is then honestly partial instead
  of quietly smaller.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

__all__ = [
    "AcpEngineSpec",
    "AcpOutcome",
    "AcpPermissionPolicy",
    "AcpToolBridge",
    "AcpUnavailable",
    "PermissionDiagnostic",
    "run_acp_child",
]

logger = logging.getLogger(__name__)

#: How long the handshake (spawn → initialize → new session) may take before
#: the spawn is treated as failed. A command that does not answer is a broken
#: configuration, and the user needs that error now, not after a task timeout.
HANDSHAKE_TIMEOUT_S = 60.0

#: Grace between `cancel` and killing the process. The protocol says a cancel
#: is cooperative; a peer that ignores it must not hold the turn open.
CANCEL_GRACE_S = 5.0

#: Stop reasons that mean "the peer finished its answer". Anything else
#: (a refusal, a token limit, a cancel) is reported as an error so the parent
#: does not treat a truncated answer as a conclusion.
_COMPLETED_STOP_REASONS = frozenset({"", "end_turn", "max_turn_requests"})


class AcpUnavailable(Exception):
    """The external engine could not be started or failed its handshake.

    Raised at spawn time so the caller fails the spawn (no empty child is
    created) and reports the command.
    """


@dataclass(frozen=True, slots=True)
class AcpEngineSpec:
    """How to launch and drive one external agent process.

    ``timeout_s`` bounds a whole prompt: an external agent that never answers
    would otherwise hold the parent's turn open until the host gives up, and
    the parent has no way to tell "still working" from "wedged".
    """

    command: str
    args: tuple[str, ...] = ()
    env: Mapping[str, str] = field(default_factory=dict)
    cwd: str | None = None
    timeout_s: float = 1800.0


@dataclass(frozen=True, slots=True)
class AcpOutcome:
    """One external run's terminal result.

    ``status`` uses the pool's vocabulary so an ACP child and a CoreLoop child
    arrive at the same call sites: ``completed`` / ``error`` / ``interrupted``.
    """

    status: str
    answer: str
    error: str | None = None
    stop_reason: str | None = None


#: What the policy decides for one permission request.
PermissionDecision = Literal["allow", "reject"]


@dataclass(frozen=True, slots=True)
class AcpPermissionPolicy:
    """The engine-level answer to a foreign agent's permission request.

    Deliberately not the parent's ``ApprovalExecutor``: an ACP request carries
    the *peer's* tool title and option text, which are prose we did not write
    and cannot validate. Judging permission from untrusted text is worse than
    a fixed policy, so the only input is the ACP tool kind — a closed enum of
    ten values the protocol defines.

    ``default`` applies to kinds not listed in ``by_kind``; ``reject`` is the
    default because a foreign engine running with our user's privileges must
    opt in, not out.
    """

    default: PermissionDecision = "reject"
    by_kind: Mapping[str, PermissionDecision] = field(default_factory=dict)

    def decide(self, kind: str | None) -> PermissionDecision:
        """The decision for one tool kind (``None`` when the peer omitted it)."""
        if kind is None:
            return self.default
        return self.by_kind.get(kind, self.default)

    def matched_by(self, kind: str | None) -> Literal["kind", "default"]:
        """Whether ``decide`` used a kind-specific rule or the default."""
        if kind is None or kind not in self.by_kind:
            return "default"
        return "kind"


@dataclass(frozen=True, slots=True)
class PermissionDiagnostic:
    """One permission decision, in fixed vocabulary only.

    Deliberately excludes the peer's title and option labels: they are the
    foreign engine's prose and must not enter the parent's record or events.
    What is recorded is what we decided and why.
    """

    kind: str | None
    decision: PermissionDecision
    matched_by: Literal["kind", "default"]


class AcpToolBridge:
    """Forwards the peer's file and terminal requests into our tool domain.

    A foreign agent that asks to read a file or run a command is asking *us*
    to do it — the protocol routes those through the client. Passing them to
    the parent's tool executor keeps one confinement story: the project fence
    and the egress allow-list apply to an ACP child exactly as they do to a
    local one. Permission and confinement stay separate questions: the policy
    says whether the call may happen at all, the fence says how far it may
    reach.

    A bridge with no executor refuses every request: an external agent is not
    granted filesystem access by being spawned.
    """

    def __init__(
        self,
        *,
        read_text_file: Callable[[str, int | None, int | None], Any] | None = None,
        write_text_file: Callable[[str, str], Any] | None = None,
        create_terminal: Callable[
            [str, list[str], Mapping[str, str] | None], Any
        ]
        | None = None,
    ) -> None:
        self._read = read_text_file
        self._write = write_text_file
        self._terminal = create_terminal

    async def read_text_file(
        self, path: str, line: int | None = None, limit: int | None = None
    ) -> str:
        """Read through the parent's tool domain, or refuse.

        Raises:
            AcpUnavailable: when no read capability was wired.
        """
        if self._read is None:
            raise AcpUnavailable(
                f"fs/read_text_file refused: this host grants no file access "
                f"to external agents (requested {path!r})"
            )
        return str(await self._read(path, line, limit))

    async def write_text_file(self, path: str, content: str) -> None:
        """Write through the parent's tool domain, or refuse.

        Raises:
            AcpUnavailable: when no write capability was wired.
        """
        if self._write is None:
            raise AcpUnavailable(
                f"fs/write_text_file refused: this host grants no file access "
                f"to external agents (requested {path!r})"
            )
        await self._write(path, content)

    async def create_terminal(
        self, command: str, args: list[str], env: Mapping[str, str] | None = None
    ) -> Any:
        """Run a command through the parent's tool domain, or refuse.

        Raises:
            AcpUnavailable: when no terminal capability was wired.
        """
        if self._terminal is None:
            raise AcpUnavailable(
                f"terminal/create refused: this host grants no command "
                f"execution to external agents (requested {command!r})"
            )
        return await self._terminal(command, args, env)


def _text_of(update: Any) -> str:
    """The text of one streamed content chunk, or empty.

    ACP content is a union of text, image and embedded-resource blocks; only
    text contributes to the answer, and a block whose shape we do not know is
    dropped rather than stringified into the transcript.
    """
    content = getattr(update, "content", None)
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(_text_of(part) for part in content)
    text = getattr(content, "text", None)
    return str(text) if isinstance(text, str) else ""


def _answer_from_events(events: list[dict[str, Any]]) -> str:
    """The child's final answer: the last contiguous block of agent text.

    Working rounds narrate progress; the last run of agent text is what the
    parent should read as the conclusion — the same rule the local pool applies
    to a child's final request.
    """
    blocks: list[str] = []
    current: list[str] = []
    for event in events:
        if event.get("kind") == "child_message":
            current.append(str(event.get("text") or ""))
        elif current:
            blocks.append("".join(current))
            current = []
    if current:
        blocks.append("".join(current))
    return (blocks[-1].strip() if blocks else "")


async def run_acp_child(
    spec: AcpEngineSpec,
    task: str,
    *,
    tool_bridge: AcpToolBridge,
    permission: AcpPermissionPolicy,
    on_event: Callable[[dict[str, Any]], None] | None = None,
) -> AcpOutcome:
    """Spawn an external ACP agent, run one prompt, return its final answer.

    The peer's streamed updates are mapped onto the pool's child event names
    (``child_message`` / ``child_reasoning`` / ``child_tool``), so a host that
    already renders a sub-agent's progress needs no second vocabulary.
    Permission requests are answered by ``permission`` — a fixed policy over
    the tool kind, never the parent's approval UI.

    Args:
        spec: How to launch and bound the peer.
        task: The self-contained instructions for it.
        tool_bridge: Where its file and terminal requests land.
        permission: The engine-level permission policy.
        on_event: Optional synchronous sink for progress events.

    Returns:
        The run's terminal outcome. A peer that stops without finishing is an
        ``error`` with the stop reason named, never a truncated answer passed
        off as a conclusion.

    Raises:
        AcpUnavailable: when the peer cannot be launched or fails its
            handshake — the caller must fail the spawn rather than create an
            empty child.
    """
    import acp

    events: list[dict[str, Any]] = []

    def emit(event: dict[str, Any]) -> None:
        events.append(event)
        if on_event is not None:
            with contextlib.suppress(Exception):
                on_event(event)

    class _Client(acp.Client):
        async def request_permission(
            self, session_id: str, tool_call: Any, options: list[Any], **kwargs: Any
        ) -> Any:
            raw_kind = getattr(tool_call, "kind", None)
            kind = str(raw_kind) if raw_kind is not None else None
            decision = permission.decide(kind)
            # Fixed vocabulary only: the peer's title and option labels never
            # leave this method (they are its prose, not our tool names).
            diagnostic = PermissionDiagnostic(
                kind=kind,
                decision=decision,
                matched_by=permission.matched_by(kind),
            )
            emit(
                {
                    "kind": "child_permission",
                    "toolKind": diagnostic.kind,
                    "decision": diagnostic.decision,
                    "matchedBy": diagnostic.matched_by,
                }
            )
            if decision == "allow":
                for option in options:
                    if getattr(option, "kind", None) in ("allow_once", "allow_always"):
                        return acp.RequestPermissionResponse(
                            outcome=acp.schema.AllowedOutcome(
                                outcome="selected", option_id=option.option_id
                            )
                        )
            # No allow option, or the policy rejects: the peer must not
            # continue this call.
            return acp.RequestPermissionResponse(
                outcome=acp.schema.DeniedOutcome(outcome="cancelled")
            )

        async def session_update(
            self, session_id: str, update: Any, **kwargs: Any
        ) -> None:
            kind = getattr(update, "session_update", "")
            if kind == "agent_message_chunk":
                emit({"kind": "child_message", "text": _text_of(update)})
            elif kind == "agent_thought_chunk":
                emit({"kind": "child_reasoning", "text": _text_of(update)})
            elif kind == "tool_call":
                emit(
                    {
                        "kind": "child_tool",
                        "toolCallId": str(getattr(update, "tool_call_id", "")),
                        # The peer's title is its own prose; the kind is the
                        # protocol's closed vocabulary, which is what a host
                        # may render as a category.
                        "toolKind": getattr(update, "kind", None),
                    }
                )
            elif kind == "tool_call_update":
                emit(
                    {
                        "kind": "child_tool_done",
                        "toolCallId": str(getattr(update, "tool_call_id", "")),
                        "status": getattr(update, "status", None),
                    }
                )

        async def read_text_file(
            self,
            path: str,
            session_id: str,
            line: int | None = None,
            limit: int | None = None,
            **kwargs: Any,
        ) -> Any:
            text = await tool_bridge.read_text_file(path, line, limit)
            return acp.ReadTextFileResponse(content=text)

        async def write_text_file(
            self, path: str, content: str, session_id: str, **kwargs: Any
        ) -> Any:
            await tool_bridge.write_text_file(path, content)
            return None

        async def create_terminal(
            self,
            command: str,
            session_id: str,
            args: list[str] | None = None,
            env: Mapping[str, str] | None = None,
            **kwargs: Any,
        ) -> Any:
            return await tool_bridge.create_terminal(command, list(args or []), env)

    context = acp.spawn_agent_process(
        lambda _agent: _Client(),
        spec.command,
        *spec.args,
        env=dict(spec.env) if spec.env else None,
        cwd=spec.cwd or None,
    )
    try:
        connection, process = await asyncio.wait_for(
            context.__aenter__(), timeout=HANDSHAKE_TIMEOUT_S
        )
    except FileNotFoundError as exc:
        raise AcpUnavailable(
            f"cannot launch ACP engine {spec.command!r}: no such command"
        ) from exc
    except OSError as exc:
        raise AcpUnavailable(
            f"cannot launch ACP engine {spec.command!r}: {exc}"
        ) from exc
    except asyncio.TimeoutError as exc:
        raise AcpUnavailable(
            f"ACP engine {spec.command!r} did not start within "
            f"{HANDSHAKE_TIMEOUT_S:.0f}s"
        ) from exc

    session_id: str | None = None
    try:
        try:
            await asyncio.wait_for(
                connection.initialize(protocol_version=acp.PROTOCOL_VERSION),
                timeout=HANDSHAKE_TIMEOUT_S,
            )
            session = await asyncio.wait_for(
                connection.new_session(cwd=spec.cwd or "", mcp_servers=[]),
                timeout=HANDSHAKE_TIMEOUT_S,
            )
            session_id = session.session_id
        except asyncio.TimeoutError as exc:
            raise AcpUnavailable(
                f"ACP engine {spec.command!r} did not complete its handshake "
                f"within {HANDSHAKE_TIMEOUT_S:.0f}s"
            ) from exc
        except Exception as exc:  # noqa: BLE001 — any handshake failure
            raise AcpUnavailable(
                f"ACP engine {spec.command!r} refused the handshake: {exc}"
            ) from exc

        try:
            response = await asyncio.wait_for(
                connection.prompt(
                    session_id=session_id,
                    prompt=[acp.schema.TextContentBlock(type="text", text=task)],
                ),
                timeout=spec.timeout_s,
            )
        except asyncio.TimeoutError:
            return AcpOutcome(
                status="error",
                answer=_answer_from_events(events),
                error=(
                    f"ACP engine {spec.command!r} did not finish within "
                    f"{spec.timeout_s:.0f}s"
                ),
            )
        except asyncio.CancelledError:
            # The parent cancelled the turn (or the pool is winding down).
            await _cancel(connection, session_id)
            raise
        except Exception as exc:  # noqa: BLE001 — a peer failure is data
            return AcpOutcome(
                status="error",
                answer=_answer_from_events(events),
                error=f"ACP engine {spec.command!r} failed: {exc}",
            )

        stop_reason = str(getattr(response, "stop_reason", "") or "")
        answer = _answer_from_events(events)
        if stop_reason in _COMPLETED_STOP_REASONS:
            return AcpOutcome(
                status="completed",
                answer=answer,
                stop_reason=stop_reason or None,
            )
        # A truncated answer is not a conclusion: report why it stopped so the
        # parent can decide to resume or take the task elsewhere.
        return AcpOutcome(
            status="error",
            answer=answer,
            stop_reason=stop_reason,
            error=f"ACP engine stopped with {stop_reason!r}",
        )
    finally:
        with contextlib.suppress(Exception):
            await context.__aexit__(None, None, None)
        with contextlib.suppress(Exception):
            if process.returncode is None:
                process.kill()


async def _cancel(connection: Any, session_id: str) -> None:
    """Ask the peer to stop, then leave the caller to kill it.

    The protocol's cancel is cooperative. A peer that keeps generating after
    the parent gave up would burn its own budget for an answer nobody reads.
    """
    with contextlib.suppress(Exception):
        await connection.cancel(session_id=session_id)
    await asyncio.sleep(CANCEL_GRACE_S)
