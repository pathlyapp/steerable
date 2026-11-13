"""AgentPool × ChildRegistry: durable rows for pooled children.

The pool answers "what is running now"; the registry answers "what did this
session spawn". These tests pin the seam between them:

- ``spawn`` notes a row synchronously, so ``agent_list`` sees the child in the
  same turn it was created;
- the row reaches disk before the child's first model request, so a crash
  afterwards leaves ``interrupted`` (resumable) rather than nothing;
- every terminal exit settles the row, including the hard-cancel path;
- ``adopt`` re-runs a child under its **existing** lineage id and consumes
  capacity like any other running child;
- a pool without a registry behaves exactly as it did before this seam.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_runtime import (
    ChildRegistry,
    CoreLoop,
    LoopConfig,
    RouterToolExecutor,
    ToolRouter,
)
from steerable_agent_runtime.llm import LLMMessage, LLMProvider, LLMStreamChunk
from steerable_agent_runtime.orchestration import OrchestrationConfig
from steerable_agent_runtime.pool import AgentPool, ChildOutcome
from steerable_agent_runtime.registry import default_record_id
from steerable_agent_runtime.storage import InMemoryStorage


class _ScriptedProvider:
    """Serves one answer per child, optionally gated on a shared event."""

    name = "fake"
    model = "fake-model"

    def __init__(self, *, gate: asyncio.Event | None = None) -> None:
        self._gate = gate
        self.requests = 0

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        self.requests += 1
        task = messages[-1].content_text

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            if self._gate is not None:
                await self._gate.wait()
            yield LLMStreamChunk(content_delta=f"answer to {task}")

        return _gen()


def _pool(
    *,
    registry: ChildRegistry | None,
    parent_record_id: str | None = "chat/p",
    max_parallel: int = 4,
    provider: LLMProvider | None = None,
) -> AgentPool:
    provider = provider or _ScriptedProvider()

    def loop_factory(child_id: str, tool_filter: frozenset[str] | None):
        return CoreLoop(provider, RouterToolExecutor(ToolRouter()), LoopConfig()), []

    return AgentPool(
        config=OrchestrationConfig(max_parallel=max_parallel),
        depth=0,
        lineage="0",
        loop_factory=loop_factory,
        registry=registry,
        parent_record_id=parent_record_id,
    )


@pytest.mark.asyncio
async def test_spawn_writes_a_row_for_the_child() -> None:
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider())

    handle = pool.spawn("look this up", None, profile="explore")
    assert handle.child_id == "0.1"

    # The row is durable once the child's run starts (it persists the noted
    # spawn before its first model request), so wait for it to settle.
    await pool.wait("0.1", 5)
    row = await store.get_child("chat/p:child:0.1")
    assert row is not None
    assert row.child_id == "0.1"
    assert row.depth == 1
    assert row.profile == "explore"
    assert row.engine == "coreloop"
    assert row.status == "completed"

    await pool.shutdown()


@pytest.mark.asyncio
async def test_spawn_is_visible_to_agent_list_immediately() -> None:
    """The pool must not make the registry wait for the child to finish."""
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider())

    pool.spawn("first", None, profile="explore")

    listed = await registry.list_for_parent("chat/p")
    assert [view.record.child_id for view in listed] == ["0.1"]
    assert listed[0].status == "running"

    await pool.wait("0.1", 5)
    await pool.shutdown()


@pytest.mark.asyncio
async def test_completion_settles_the_row_with_usage() -> None:
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider())

    pool.spawn("task", None)
    outcome = await pool.wait("0.1", 5)
    assert outcome is not None and outcome.status == "completed"

    view = await registry.get("chat/p:child:0.1")
    assert view is not None
    assert view.status == "completed"
    assert view.live is False
    assert view.resumable is True
    await pool.shutdown()


@pytest.mark.asyncio
async def test_a_child_interrupted_by_shutdown_is_not_terminal() -> None:
    """The parent turn ended mid-run: the row must stay resumable."""
    gate = asyncio.Event()
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider(gate=gate))

    pool.spawn("slow task", None)
    # Let the child reach its model request, then tear the pool down.
    await asyncio.sleep(0)
    await pool.shutdown()

    view = await registry.get("chat/p:child:0.1")
    assert view is not None
    assert view.status == "cancelled"
    gate.set()


@pytest.mark.asyncio
async def test_failed_child_settles_as_error() -> None:
    class _RaisingProvider:
        name = "fake"
        model = "fake-model"

        async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
            raise NotImplementedError

        def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
            async def _gen() -> AsyncIterator[LLMStreamChunk]:
                raise RuntimeError("provider exploded")
                yield LLMStreamChunk()  # pragma: no cover

            return _gen()

    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_RaisingProvider())

    pool.spawn("doomed", None)
    outcome = await pool.wait("0.1", 5)
    # The loop reports ``failed``; the registry records it as ``error`` so
    # one spelling reaches storage.
    assert outcome is not None and outcome.status == "failed"

    view = await registry.get("chat/p:child:0.1")
    assert view is not None
    assert view.status == "error"
    await pool.shutdown()


@pytest.mark.asyncio
async def test_adopt_keeps_the_lineage_id_and_consumes_capacity() -> None:
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    gate = asyncio.Event()
    provider = _ScriptedProvider(gate=gate)
    pool = _pool(registry=registry, provider=provider, max_parallel=1)

    # Pre-existing row: a child from a previous turn.
    await registry.spawned(
        _spawn_of("0.3"),
        record_id=default_record_id("chat/p", "0.3"),
    )

    def loop_factory(child_id: str, tool_filter: frozenset[str] | None):
        return CoreLoop(provider, RouterToolExecutor(ToolRouter()), LoopConfig()), []

    loop, schemas = loop_factory("0.3", None)
    handle = pool.adopt(
        child_id="0.3",
        loop=loop,
        schemas=schemas,
        seed=[LLMMessage.text_of("user", "resume me")],
        profile="explore",
        record_id=default_record_id("chat/p", "0.3"),
    )
    # Lineage id unchanged — resume never allocates a new sequence number.
    assert handle.child_id == "0.3"

    # It occupies the only slot, so a fresh spawn is refused.
    with pytest.raises(Exception):
        pool.spawn("another", None)

    gate.set()
    await pool.wait("0.3", 5)
    await pool.shutdown()


@pytest.mark.asyncio
async def test_a_pool_without_a_registry_still_runs() -> None:
    """Hosts with no storage adapter keep the pre-index behaviour exactly."""
    pool = _pool(registry=None, parent_record_id=None)

    pool.spawn("task", None)
    outcome = await pool.wait("0.1", 5)

    assert outcome == ChildOutcome("0.1", "completed", "answer to task")
    await pool.shutdown()


@pytest.mark.asyncio
async def test_two_children_get_distinct_rows() -> None:
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider())

    pool.spawn("a", None)
    pool.spawn("b", None)
    await asyncio.gather(pool.wait("0.1", 5), pool.wait("0.2", 5))
    await pool.shutdown()

    rows = await store.list_children("chat/p")
    assert [r.child_id for r in rows] == ["0.1", "0.2"]
    assert all(r.status == "completed" for r in rows)


def _spawn_of(child_id: str):
    from steerable_agent_runtime.registry import SpawnedChild

    return SpawnedChild(
        parent_record_id="chat/p",
        child_id=child_id,
        depth=1,
        profile="explore",
        engine="coreloop",
    )


# ---------------------------------------------------------------------------
# close is durable, not just in-process
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_writes_closed_onto_the_row() -> None:
    """Closing has to reach disk, or a later turn resumes a closed child.

    The in-memory ``closed`` flag lives on the handle, and the handle dies
    with the pool. `agent_send` decides whether a child is resumable by
    reading its **row**, so a close that only touched the handle left a
    closed child looking merely finished — and the observed behaviour was
    `delivery: "resumed"` after an explicit `agent_close`.
    """
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider())

    pool.spawn("look this up", None)
    await pool.wait("0.1", 5)
    assert (await store.get_child("chat/p:child:0.1")).status == "completed"

    await pool.close("0.1")

    assert (await store.get_child("chat/p:child:0.1")).status == "closed"
    await pool.shutdown()


@pytest.mark.asyncio
async def test_closing_a_running_child_does_not_settle_it_as_cancelled() -> None:
    """Close cancels the run, and that cancel must not overwrite the row.

    Cancelling to close produces ``cancelled`` from the loop. Writing that
    back would leave the row resumable again — the exact state close is
    supposed to end.
    """
    gate = asyncio.Event()
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider(gate=gate))

    pool.spawn("still running", None)
    await asyncio.sleep(0.05)

    await pool.close("0.1")

    row = await store.get_child("chat/p:child:0.1")
    assert row is not None
    assert row.status == "closed"
    gate.set()
    await pool.shutdown()


@pytest.mark.asyncio
async def test_a_closed_row_is_not_resumable() -> None:
    """The point of the durable ``closed``: the resume path reads it."""
    store = InMemoryStorage()
    registry = ChildRegistry(store)
    pool = _pool(registry=registry, provider=_ScriptedProvider())

    pool.spawn("one run", None)
    await pool.wait("0.1", 5)
    await pool.close("0.1")
    await pool.shutdown()

    # A fresh pool is what a later turn builds; it has no handle for 0.1, so
    # only the row can say the child is finished for good.
    view = await registry.find_child("chat/p", "0.1")
    assert view is not None
    assert view.record.status == "closed"
    assert view.resumable is False
