"""An external agent process driven over ACP as a sub-agent.

Two properties are load-bearing and only observable against a real peer
process:

- **The peer decides what it does.** It asks for permission in its own words
  and with its own tool titles. The policy answers from the ACP tool *kind*
  alone, and none of that prose reaches the parent's record or events.
- **A peer that stops early is not a conclusion.** Only `end_turn` (or an
  unspecified reason) counts as finished; a refusal is an `error` carrying the
  reason, so the parent does not present a truncated answer as the answer.

The peer is `tests/acp_peer.py`: the smallest agent that exercises those
paths, so these tests need no API key and no network.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from steerable_agent_runtime.engines import (
    AcpEngineSpec,
    AcpPermissionPolicy,
    AcpToolBridge,
    AcpUnavailable,
    run_acp_child,
)

PEER = Path(__file__).parent / "acp_peer.py"

#: A PATH is required: the peer imports `acp`, and the launcher uses
#: `sys.executable`, so the child only needs to find its own interpreter.
_ENV = {"PATH": "/usr/bin:/bin:/usr/local/bin"}


def _spec(mode: str, *, timeout_s: float = 30.0) -> AcpEngineSpec:
    return AcpEngineSpec(
        command=sys.executable,
        args=(str(PEER),),
        cwd=str(PEER.parent),
        env={**_ENV, "ACP_PEER_MODE": mode},
        timeout_s=timeout_s,
    )


class _Recorder:
    """Collects the events the bridge forwards."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def __call__(self, event: dict[str, Any]) -> None:
        self.events.append(event)

    def kinds(self) -> list[str]:
        return [str(event.get("kind")) for event in self.events]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.events if event.get("kind") == kind]


@pytest.mark.asyncio
async def test_a_plain_peer_returns_its_answer() -> None:
    recorder = _Recorder()

    outcome = await run_acp_child(
        _spec("plain"),
        "summarize the change",
        tool_bridge=AcpToolBridge(),
        permission=AcpPermissionPolicy(),
        on_event=recorder,
    )

    assert outcome.status == "completed"
    assert "summarize the change" in outcome.answer
    assert outcome.stop_reason == "end_turn"
    # Progress is mapped onto the pool's vocabulary, so a host that renders a
    # local child's progress needs no second one.
    assert "child_message" in recorder.kinds()
    assert "child_reasoning" in recorder.kinds()


@pytest.mark.asyncio
async def test_a_rejected_exec_is_not_run_and_names_the_kind() -> None:
    """The default policy refuses; the peer stops; the parent sees why."""
    recorder = _Recorder()

    outcome = await run_acp_child(
        _spec("ask_exec"),
        "run the tests",
        tool_bridge=AcpToolBridge(),
        permission=AcpPermissionPolicy(),
        on_event=recorder,
    )

    assert outcome.status == "error"
    assert "refusal" in (outcome.error or "")
    decisions = recorder.of("child_permission")
    assert decisions == [
        {
            "kind": "child_permission",
            "toolKind": "execute",
            "decision": "reject",
            "matchedBy": "default",
        }
    ]


@pytest.mark.asyncio
async def test_an_allowed_exec_completes() -> None:
    recorder = _Recorder()

    outcome = await run_acp_child(
        _spec("ask_exec"),
        "run the tests",
        tool_bridge=AcpToolBridge(),
        permission=AcpPermissionPolicy(default="allow"),
        on_event=recorder,
    )

    assert outcome.status == "completed"
    assert recorder.of("child_permission")[0]["decision"] == "allow"


@pytest.mark.asyncio
async def test_a_kind_specific_rule_beats_the_default() -> None:
    """`read` allowed, everything else still rejected."""
    recorder = _Recorder()

    outcome = await run_acp_child(
        _spec("ask_read"),
        "look at the file",
        tool_bridge=AcpToolBridge(),
        permission=AcpPermissionPolicy(by_kind={"read": "allow"}),
        on_event=recorder,
    )

    assert outcome.status == "completed"
    assert recorder.of("child_permission")[0] == {
        "kind": "child_permission",
        "toolKind": "read",
        "decision": "allow",
        "matchedBy": "kind",
    }


@pytest.mark.asyncio
async def test_the_peers_own_words_never_reach_the_events() -> None:
    """Its title and option labels are prose we did not write.

    The peer sends "peer wants to run something" and "Sure, go ahead"; neither
    may appear anywhere a host could render it as ours — only the protocol's
    kind, our decision, and why.
    """
    recorder = _Recorder()

    await run_acp_child(
        _spec("ask_exec"),
        "run the tests",
        tool_bridge=AcpToolBridge(),
        permission=AcpPermissionPolicy(),
        on_event=recorder,
    )

    serialized = repr(recorder.events)
    assert "peer wants to run something" not in serialized
    assert "Sure, go ahead" not in serialized
    assert "No thanks" not in serialized
    # The tool call event carries the kind and id only.
    for event in recorder.of("child_tool"):
        assert set(event) <= {"kind", "toolCallId", "toolKind"}


@pytest.mark.asyncio
async def test_a_peer_that_stops_early_is_an_error_not_an_answer() -> None:
    outcome = await run_acp_child(
        _spec("stop"),
        "do the thing",
        tool_bridge=AcpToolBridge(),
        permission=AcpPermissionPolicy(),
    )

    assert outcome.status == "error"
    assert "refusal" in (outcome.error or "")
    assert outcome.stop_reason == "refusal"


@pytest.mark.asyncio
async def test_a_peer_that_never_answers_times_out() -> None:
    outcome = await run_acp_child(
        _spec("slow", timeout_s=1.0),
        "hang",
        tool_bridge=AcpToolBridge(),
        permission=AcpPermissionPolicy(),
    )

    assert outcome.status == "error"
    assert "did not finish" in (outcome.error or "")


@pytest.mark.asyncio
async def test_a_missing_command_fails_the_spawn() -> None:
    """No empty child may be created for a command that does not exist."""
    with pytest.raises(AcpUnavailable) as excinfo:
        await run_acp_child(
            AcpEngineSpec(command="definitely-not-a-real-acp-agent-xyz"),
            "task",
            tool_bridge=AcpToolBridge(),
            permission=AcpPermissionPolicy(),
        )

    assert "cannot launch" in str(excinfo.value)


@pytest.mark.asyncio
async def test_a_bridge_with_no_capability_refuses_file_access() -> None:
    """Being spawned does not grant filesystem access."""
    bridge = AcpToolBridge()

    with pytest.raises(AcpUnavailable, match="grants no file access"):
        await bridge.read_text_file("/etc/passwd")
    with pytest.raises(AcpUnavailable, match="grants no file access"):
        await bridge.write_text_file("/tmp/x", "y")
    with pytest.raises(AcpUnavailable, match="grants no command execution"):
        await bridge.create_terminal("rm", ["-rf", "/"])


@pytest.mark.asyncio
async def test_a_bridge_with_a_capability_forwards_the_request() -> None:
    """The call lands in the parent's domain, which enforces its own fence."""
    seen: list[tuple[str, Any]] = []

    async def read(path: str, line: int | None, limit: int | None) -> str:
        seen.append((path, (line, limit)))
        return "file contents"

    async def write(path: str, content: str) -> None:
        seen.append((path, content))

    async def terminal(
        command: str, args: list[str], env: Mapping[str, str] | None
    ) -> dict[str, Any]:
        seen.append((command, args))
        return {"terminalId": "t1"}

    bridge = AcpToolBridge(
        read_text_file=read, write_text_file=write, create_terminal=terminal
    )

    assert await bridge.read_text_file("/a", 1, 5) == "file contents"
    await bridge.write_text_file("/b", "data")
    assert await bridge.create_terminal("ls", ["-la"], None) == {"terminalId": "t1"}
    assert seen == [("/a", (1, 5)), ("/b", "data"), ("ls", ["-la"])]


def test_the_policy_reports_which_rule_matched() -> None:
    """A host logging a decision needs to know if it was a rule or the default."""
    policy = AcpPermissionPolicy(default="reject", by_kind={"read": "allow"})

    assert policy.decide(None) == "reject"
    assert policy.matched_by(None) == "default"
    assert policy.decide("read") == "allow"
    assert policy.matched_by("read") == "kind"
    assert policy.decide("execute") == "reject"
    assert policy.matched_by("execute") == "default"
