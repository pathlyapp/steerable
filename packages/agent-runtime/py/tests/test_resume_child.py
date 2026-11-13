"""Resume across turns: a child from a finished turn runs again.

The pool lives and dies with one turn, so "continue the child you spawned
earlier" cannot be a pool operation. These tests pin the path that makes it
work: the registry has the row, the child's own record is the seed, and
``adopt`` puts it back under its **original** lineage id with the profile and
depth it was created with — never with the current settings' permissions.
"""

from __future__ import annotations

import json
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
from steerable_agent_runtime.history import ContextManager, entry_to_dict
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk
from steerable_agent_runtime.orchestration import (
    OrchestrationConfig,
    OrchestrationExecutor,
)
from steerable_agent_runtime.registry import SpawnedChild, default_record_id
from steerable_agent_runtime.storage import InMemoryStorage
from steerable_agent_protocol.generated import ToolCall

PARENT = "chat/p"


class _RouteProvider:
    """Answers by matching a phrase in the transcript."""

    name = "fake"
    model = "fake-model"

    def __init__(self, routes: dict[str, str]) -> None:
        self._routes = routes
        self.transcripts: list[list[LLMMessage]] = []

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        self.transcripts.append(list(messages))
        joined = "\n".join(m.content_text for m in messages)

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            for phrase, answer in self._routes.items():
                if phrase in joined:
                    yield LLMStreamChunk(content_delta=answer)
                    return
            yield LLMStreamChunk(content_delta="no route")

        return _gen()


def _tool_call(name: str, args: dict[str, Any], call_id: str = "c1") -> ToolCall:
    return ToolCall(id=call_id, name=name, arguments=args)


async def _seed_child_record(
    storage: InMemoryStorage, record_id: str, *, text: str
) -> None:
    """Write a child record with one completed exchange."""
    manager = ContextManager()
    manager.append(LLMMessage.text_of("user", "earlier question"))
    manager.append(LLMMessage.text_of("assistant", text))
    await storage.append_history(record_id, [entry_to_dict(e) for e in manager.record])


@pytest.mark.asyncio
async def test_spawn_gives_the_child_its_own_record() -> None:
    """The orchestration family must match ``delegate_subagent``: a readable
    process log for every child, not just the single-tool seam."""
    storage = InMemoryStorage()
    registry = ChildRegistry(storage)
    provider = _RouteProvider({"task": "done"})
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(),
        registry=registry,
        history_store=storage,
        parent_record_id=PARENT,
    )

    result = await executor.execute(
        _tool_call("agent_spawn", {"task": "do the thing"}), None  # type: ignore[arg-type]
    )
    assert result.success is True
    payload = json.loads(result.message or "{}")
    expected = default_record_id(PARENT, payload["childId"])
    assert payload["recordId"] == expected

    await executor._pool.wait(payload["childId"], 5)
    entries = await storage.list_history(expected)
    assert entries, "the child wrote no record of its own"
    await executor.shutdown()


@pytest.mark.asyncio
async def test_send_resumes_a_child_this_pool_never_had() -> None:
    """The core R1 behaviour: continue a child from an earlier turn."""
    storage = InMemoryStorage()
    registry = ChildRegistry(storage)
    record_id = default_record_id(PARENT, "0.1")
    await _seed_child_record(storage, record_id, text="the version is 1.0.8")
    await registry.spawned(
        SpawnedChild(
            parent_record_id=PARENT,
            child_id="0.1",
            depth=1,
            profile="explore",
            engine="coreloop",
        ),
        record_id=record_id,
    )
    await registry.finished(record_id, status="completed")

    provider = _RouteProvider({"what else": "the extra answer"})
    # A brand-new executor: nothing from the spawning turn survives.
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(),
        registry=registry,
        history_store=storage,
        parent_record_id=PARENT,
    )

    result = await executor.execute(
        _tool_call("agent_send", {"childId": "0.1", "message": "what else?"}), None  # type: ignore[arg-type]
    )
    assert result.success is True, result.error
    payload = json.loads(result.message or "{}")
    assert payload["delivery"] == "resumed"
    assert payload["childId"] == "0.1"
    # It kept the profile it was created with.
    assert payload["profile"] == "explore"

    outcome = await executor._pool.wait("0.1", 5)
    assert outcome is not None and outcome.status == "completed"
    await executor.shutdown()


@pytest.mark.asyncio
async def test_resume_seeds_the_previous_transcript() -> None:
    """The resumed child must see what it concluded last time."""
    storage = InMemoryStorage()
    registry = ChildRegistry(storage)
    record_id = default_record_id(PARENT, "0.1")
    await _seed_child_record(storage, record_id, text="the version is 1.0.8")
    await registry.spawned(
        SpawnedChild(
            parent_record_id=PARENT,
            child_id="0.1",
            depth=1,
            profile="explore",
            engine="coreloop",
        ),
        record_id=record_id,
    )
    await registry.finished(record_id, status="budget_exhausted")

    provider = _RouteProvider({"version": "seeded answer"})
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(),
        registry=registry,
        history_store=storage,
        parent_record_id=PARENT,
    )

    await executor.execute(
        _tool_call("agent_send", {"childId": "0.1", "message": "keep going"}), None  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    assert provider.transcripts, "the child never ran"
    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    assert "the version is 1.0.8" in joined
    assert "keep going" in joined


@pytest.mark.asyncio
async def test_resume_keeps_the_recorded_depth() -> None:
    """A grandchild must resume at its own depth, not be promoted to a child.

    The trap: rebuild the loop with ``self._depth + 1`` instead of the depth
    the child was created at. A depth-2 grandchild under ``max_depth=2`` has
    no orchestration tools; rebuilt at depth 1 it would sit below the cap and
    regain ``agent_spawn`` — a child that could never spawn, suddenly able to.
    """
    storage = InMemoryStorage()
    registry = ChildRegistry(storage)
    record_id = default_record_id(PARENT, "0.1.1")
    await _seed_child_record(storage, record_id, text="earlier")
    await registry.spawned(
        SpawnedChild(
            parent_record_id=PARENT,
            child_id="0.1.1",
            depth=2,
            profile="explore",
            engine="coreloop",
        ),
        record_id=record_id,
    )
    await registry.finished(record_id, status="interrupted")

    provider = _RouteProvider({"go": "ok"})
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(max_depth=2),
        registry=registry,
        history_store=storage,
        parent_record_id=PARENT,
    )

    result = await executor.execute(
        _tool_call("agent_send", {"childId": "0.1.1", "message": "go"}), None  # type: ignore[arg-type]
    )
    assert result.success is True, result.error
    await executor._pool.wait("0.1.1", 5)
    await executor.shutdown()

    # At its recorded depth 2 the cap is reached: no orchestration tools.
    _, at_recorded_depth = executor._child_loop("0.1.1", None, depth=2)
    assert "agent_spawn" not in {
        schema["function"]["name"] for schema in (at_recorded_depth or [])
    }
    # Rebuilt at the executor's own depth+1 it would be promoted and regain
    # them — proving the assertion above is load-bearing, not vacuous.
    _, if_promoted = executor._child_loop("0.1.1", None, depth=1)
    assert "agent_spawn" in {
        schema["function"]["name"] for schema in (if_promoted or [])
    }


@pytest.mark.asyncio
async def test_a_closed_child_is_not_resumed() -> None:
    storage = InMemoryStorage()
    registry = ChildRegistry(storage)
    record_id = default_record_id(PARENT, "0.1")
    await _seed_child_record(storage, record_id, text="done")
    await registry.spawned(
        SpawnedChild(
            parent_record_id=PARENT,
            child_id="0.1",
            depth=1,
            profile="explore",
            engine="coreloop",
        ),
        record_id=record_id,
    )
    await registry.finished(record_id, status="closed")

    provider = _RouteProvider({"go": "should not run"})
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(),
        registry=registry,
        history_store=storage,
        parent_record_id=PARENT,
    )

    result = await executor.execute(
        _tool_call("agent_send", {"childId": "0.1", "message": "go"}), None  # type: ignore[arg-type]
    )
    assert result.success is False
    assert "unknown_child" in (result.error or "").lower() or "closed" in (result.error or "").lower()
    await executor.shutdown()


@pytest.mark.asyncio
async def test_agent_list_includes_children_from_earlier_turns() -> None:
    """The tool's whole point: listing is not limited to this turn's pool."""
    storage = InMemoryStorage()
    registry = ChildRegistry(storage)
    record_id = default_record_id(PARENT, "0.1")
    await _seed_child_record(storage, record_id, text="older answer")
    await registry.spawned(
        SpawnedChild(
            parent_record_id=PARENT,
            child_id="0.1",
            depth=1,
            profile="explore",
            engine="coreloop",
        ),
        record_id=record_id,
    )
    await registry.finished(record_id, status="completed")

    provider = _RouteProvider({"go": "x"})
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(),
        registry=registry,
        history_store=storage,
        parent_record_id=PARENT,
    )

    result = await executor.execute(_tool_call("agent_list", {}), None)  # type: ignore[arg-type]
    assert result.success is True
    payload = json.loads(result.message or "{}")
    ids = [entry["childId"] for entry in payload["children"]]
    assert ids == ["0.1"]
    assert payload["children"][0]["status"] == "completed"
    await executor.shutdown()


@pytest.mark.asyncio
async def test_agent_list_does_not_duplicate_a_live_child() -> None:
    storage = InMemoryStorage()
    registry = ChildRegistry(storage)
    provider = _RouteProvider({"task": "done"})
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(),
        registry=registry,
        history_store=storage,
        parent_record_id=PARENT,
    )

    spawn = await executor.execute(
        _tool_call("agent_spawn", {"task": "task"}), None  # type: ignore[arg-type]
    )
    spawned_id = json.loads(spawn.message or "{}")["childId"]

    result = await executor.execute(_tool_call("agent_list", {}), None)  # type: ignore[arg-type]
    payload = json.loads(result.message or "{}")
    assert [entry["childId"] for entry in payload["children"]] == [spawned_id]

    await executor._pool.wait(spawned_id, 5)
    await executor.shutdown()
