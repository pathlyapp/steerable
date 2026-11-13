"""An ACP child inside the pool: capacity, lineage, and honest accounting.

The pool's job does not change when a child is an external process — it still
owns ``max_parallel``, the lineage id and the registry row. What changes is
what can be known about the child: no local loop, no token bill, and an answer
that arrives only at the end.

These tests drive the real peer process, so they need no API key.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from steerable_agent_runtime import AgentPool
from steerable_agent_runtime.engines import AcpEngineSpec, AcpPermissionPolicy, AcpToolBridge
from steerable_agent_runtime.orchestration import OrchestrationConfig

PEER = Path(__file__).parent / "acp_peer.py"


def _engine(mode: str = "plain", *, timeout_s: float = 30.0) -> AcpEngineSpec:
    return AcpEngineSpec(
        command=sys.executable,
        args=(str(PEER),),
        cwd=str(PEER.parent),
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "ACP_PEER_MODE": mode},
        timeout_s=timeout_s,
    )


def _pool(*, max_parallel: int = 4) -> AgentPool:
    return AgentPool(
        config=OrchestrationConfig(max_parallel=max_parallel), depth=0, lineage="0"
    )


@pytest.mark.asyncio
async def test_an_acp_child_completes_and_returns_its_answer() -> None:
    pool = _pool()

    handle = pool.spawn(
        "answer the question",
        None,
        engine="acp",
        acp_engine=_engine(),
        acp_permission=AcpPermissionPolicy(),
        acp_tool_bridge=AcpToolBridge(),
    )
    await pool.wait(handle.child_id, 30)
    outcome = handle.outcome
    await pool.shutdown()

    assert outcome is not None
    assert outcome.status == "completed"
    assert "answer the question" in outcome.answer
    # It is a real child of this pool: lineage id allocated as usual.
    assert handle.child_id == "0.1"


@pytest.mark.asyncio
async def test_an_acp_child_has_no_local_loop_and_unknown_usage() -> None:
    pool = _pool()

    handle = pool.spawn("task", None, engine="acp", acp_engine=_engine())
    await pool.wait(handle.child_id, 30)
    await pool.shutdown()

    assert handle.loop is None
    # Unknown, not zero: the turn's total must be markable as partial.
    assert handle.usage is None
    assert handle.usage_known is False
    entries, unknown = pool.children_usage()
    assert entries == []
    assert unknown == 1


@pytest.mark.asyncio
async def test_an_acp_child_counts_against_the_parallel_cap() -> None:
    """It is a real running child, so capacity is reserved like any other."""
    pool = _pool(max_parallel=1)

    first = pool.spawn("one", None, engine="acp", acp_engine=_engine("slow", timeout_s=30))
    with pytest.raises(Exception) as excinfo:
        pool.spawn("two", None, engine="acp", acp_engine=_engine())
    await pool.close(first.child_id)
    await pool.shutdown()

    assert "parallel cap" in str(excinfo.value)


@pytest.mark.asyncio
async def test_a_broken_command_fails_the_child_with_a_reason() -> None:
    """No empty child that "completed" without running anything."""
    pool = _pool()

    handle = pool.spawn(
        "task",
        None,
        engine="acp",
        acp_engine=AcpEngineSpec(command="definitely-not-a-real-acp-agent-xyz"),
    )
    await pool.wait(handle.child_id, 30)
    await pool.shutdown()

    assert handle.outcome is not None
    assert handle.outcome.status == "error"
    assert "cannot launch" in handle.outcome.answer


@pytest.mark.asyncio
async def test_an_acp_child_reports_its_engine_on_the_spawn_event() -> None:
    """A host rendering the child list must see it is not one of ours."""
    events: list[tuple[str, dict[str, Any]]] = []
    pool = AgentPool(
        config=OrchestrationConfig(),
        depth=0,
        lineage="0",
        event_sink=lambda kind, data: events.append((kind, data)),
    )

    handle = pool.spawn("task", None, engine="acp", acp_engine=_engine())
    await pool.wait(handle.child_id, 30)
    await pool.shutdown()

    spawned = next(data for kind, data in events if kind == "child_spawned")
    assert spawned["engine"] == "acp"
    completed = next(data for kind, data in events if kind == "child_completed")
    # No `usage` at all, which is what tells a host the bill is partial.
    assert "usage" not in completed


@pytest.mark.asyncio
async def test_a_rejected_permission_surfaces_as_a_failed_child() -> None:
    pool = _pool()

    handle = pool.spawn(
        "run the tests",
        None,
        engine="acp",
        acp_engine=_engine("ask_exec"),
        acp_permission=AcpPermissionPolicy(),
        acp_tool_bridge=AcpToolBridge(),
    )
    await pool.wait(handle.child_id, 30)
    await pool.shutdown()

    assert handle.outcome is not None
    assert handle.outcome.status == "error"
