"""Fan-out: spawn several in one message, then collect with one wait.

Two properties make this work, and both are easy to lose:

- ``agent_spawn`` is batchable. It consumes the bounded pool, but
  ``AgentPool.spawn`` never yields, so capacity is reserved in call order and
  the call beyond the cap is the one that fails — deterministic.
- ``agent_wait`` settles on the **first** child, so one call collects one
  answer instead of blocking on a specific child that may be the slowest.

Nothing here adds a tool: the fan-out is the model emitting several spawns,
which is what Codex and DSH rely on too.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import (
    ChildRegistry,
    CoreLoop,
    LoopConfig,
    RouterToolExecutor,
    ToolRouter,
)
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk
from steerable_agent_runtime.orchestration import (
    OrchestrationConfig,
    OrchestrationExecutor,
)
from steerable_agent_runtime.storage import InMemoryStorage

PARENT = "chat/p"


class _PhraseProvider:
    """Answers per phrase, optionally holding a tag until released."""

    name = "fake"
    model = "fake-model"

    def __init__(self, routes: dict[str, str], gates: dict[str, asyncio.Event] | None = None) -> None:
        self._routes = routes
        self._gates = gates or {}

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        joined = "\n".join(m.content_text for m in messages)

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            for phrase, answer in self._routes.items():
                if phrase not in joined:
                    continue
                gate = self._gates.get(phrase)
                if gate is not None:
                    await gate.wait()
                yield LLMStreamChunk(content_delta=answer)
                return
            yield LLMStreamChunk(content_delta="no route")

        return _gen()


def _executor(provider: Any, *, max_parallel: int = 4) -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(max_parallel=max_parallel),
        registry=ChildRegistry(InMemoryStorage()),
        parent_record_id=PARENT,
    )


async def _call(
    executor: OrchestrationExecutor, name: str, args: dict[str, Any], call_id: str = "c1"
) -> dict[str, Any]:
    result = await executor.execute(
        ToolCall(id=call_id, name=name, arguments=args), None  # type: ignore[arg-type]
    )
    assert result.success is True, result.error
    return json.loads(result.message or "{}")


@pytest.mark.asyncio
async def test_spawn_is_batchable() -> None:
    """The whole fan-out hinges on this predicate being true."""
    executor = _executor(_PhraseProvider({"task": "ok"}))
    safe = executor.concurrency_safe(
        ToolCall(id="c1", name="agent_spawn", arguments={"task": "t"})
    )
    await executor.shutdown()
    assert safe is True


@pytest.mark.asyncio
async def test_lifecycle_mutations_stay_serial() -> None:
    """send/close/interrupt mutate a child; interleaving them is not defined."""
    executor = _executor(_PhraseProvider({"task": "ok"}))
    for name in ("agent_send", "agent_close", "agent_interrupt"):
        assert (
            executor.concurrency_safe(
                ToolCall(id="c1", name=name, arguments={"childId": "0.1"})
            )
            is False
        ), name
    await executor.shutdown()


@pytest.mark.asyncio
async def test_concurrent_spawns_all_succeed_under_the_cap() -> None:
    """Five spawns batched at once with room for five."""
    executor = _executor(_PhraseProvider({"task": "ok"}), max_parallel=5)

    results = await asyncio.gather(
        *(
            executor.execute(
                ToolCall(id=f"s{i}", name="agent_spawn", arguments={"task": "task"}),
                None,  # type: ignore[arg-type]
            )
            for i in range(5)
        )
    )
    ids = [json.loads(r.message or "{}")["childId"] for r in results if r.success]
    assert all(r.success for r in results)
    # Lineage ids are consecutive and distinct: reservation happened in order.
    assert sorted(ids) == ["0.1", "0.2", "0.3", "0.4", "0.5"]
    await executor.shutdown()


@pytest.mark.asyncio
async def test_the_call_beyond_the_cap_is_the_one_that_fails() -> None:
    """Capacity is reserved in call order, so the overflow is deterministic."""
    executor = _executor(_PhraseProvider({"task": "ok"}), max_parallel=2)

    results = await asyncio.gather(
        *(
            executor.execute(
                ToolCall(id=f"s{i}", name="agent_spawn", arguments={"task": "task"}),
                None,  # type: ignore[arg-type]
            )
            for i in range(4)
        )
    )
    succeeded = [r for r in results if r.success]
    failed = [r for r in results if not r.success]
    assert len(succeeded) == 2
    assert len(failed) == 2
    for result in failed:
        assert "orchestration_budget_exceeded" in (result.error or "")
    await executor.shutdown()


@pytest.mark.asyncio
async def test_wait_settles_on_the_first_child_that_finishes() -> None:
    """The fast child is returned even though the slow one is still running."""
    slow = asyncio.Event()
    provider = _PhraseProvider(
        {"fast task": "fast answer", "slow task": "slow answer"},
        gates={"slow task": slow},
    )
    executor = _executor(provider, max_parallel=4)

    first = await _call(executor, "agent_spawn", {"task": "slow task"}, "s1")
    second = await _call(executor, "agent_spawn", {"task": "fast task"}, "s2")

    payload = await _call(executor, "agent_wait", {}, "w1")

    assert payload["childId"] == second["childId"]
    assert payload["status"] == "completed"
    assert "fast answer" in payload["answer"]
    # The slow one is reported as pending rather than silently dropped.
    assert payload["pending"] == [first["childId"]]

    slow.set()
    await executor.shutdown()


@pytest.mark.asyncio
async def test_wait_returns_an_already_settled_child_without_delay() -> None:
    executor = _executor(_PhraseProvider({"task": "ok"}))

    spawned = await _call(executor, "agent_spawn", {"task": "task"}, "s1")
    await executor._pool.wait(spawned["childId"], 5)

    payload = await _call(executor, "agent_wait", {}, "w1")
    assert payload["childId"] == spawned["childId"]
    assert payload["status"] == "completed"
    await executor.shutdown()


@pytest.mark.asyncio
async def test_wait_reports_everyone_unknown_when_none_are_known() -> None:
    executor = _executor(_PhraseProvider({"task": "ok"}))

    result = await executor.execute(
        ToolCall(id="w1", name="agent_wait", arguments={"childIds": ["9.9"]}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "unknown_child" in (result.error or "")


@pytest.mark.asyncio
async def test_wait_refuses_childid_and_childids_together() -> None:
    executor = _executor(_PhraseProvider({"task": "ok"}))

    result = await executor.execute(
        ToolCall(
            id="w1",
            name="agent_wait",
            arguments={"childId": "0.1", "childIds": ["0.2"]},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "not both" in (result.error or "")


@pytest.mark.asyncio
async def test_each_wait_hands_back_a_different_child() -> None:
    """A fan-out must be able to collect every answer, not just the first.

    Without this, "spawn three, wait three times" returns the same child each
    time and the other two answers are unreachable — the fan-out looks like it
    worked while losing two thirds of the work.
    """
    executor = _executor(_PhraseProvider({"task": "ok"}), max_parallel=3)

    spawned = [
        (await _call(executor, "agent_spawn", {"task": "task"}, f"s{i}"))["childId"]
        for i in range(3)
    ]
    for child_id in spawned:
        await executor._pool.wait(child_id, 5)

    collected = [
        (await _call(executor, "agent_wait", {}, f"w{i}"))["childId"] for i in range(3)
    ]

    assert sorted(collected) == sorted(spawned)
    await executor.shutdown()


@pytest.mark.asyncio
async def test_an_explicit_child_id_can_be_read_again() -> None:
    """Asking for a specific child means asking again, not "whatever is left"."""
    executor = _executor(_PhraseProvider({"task": "ok"}))

    spawned = await _call(executor, "agent_spawn", {"task": "task"}, "s1")
    await executor._pool.wait(spawned["childId"], 5)

    first = await _call(executor, "agent_wait", {"childId": spawned["childId"]}, "w1")
    again = await _call(executor, "agent_wait", {"childId": spawned["childId"]}, "w2")

    assert first["childId"] == again["childId"] == spawned["childId"]
    await executor.shutdown()


@pytest.mark.asyncio
async def test_a_resumed_child_becomes_visible_to_wait_again() -> None:
    """Resume clears the reported mark: its next outcome is news."""
    executor = _executor(_PhraseProvider({"task": "ok"}))

    spawned = await _call(executor, "agent_spawn", {"task": "task"}, "s1")
    await executor._pool.wait(spawned["childId"], 5)
    first = await _call(executor, "agent_wait", {}, "w1")
    assert first["childId"] == spawned["childId"]

    # Nothing left to report.
    empty = await executor.execute(
        ToolCall(id="w2", name="agent_wait", arguments={"timeoutMs": 10}),
        None,  # type: ignore[arg-type]
    )
    assert json.loads(empty.message or "{}")["status"] == "running"

    await _call(
        executor, "agent_send", {"childId": spawned["childId"], "message": "go on"}, "d1"
    )
    again = await _call(executor, "agent_wait", {}, "w3")
    assert again["childId"] == spawned["childId"]
    await executor.shutdown()


@pytest.mark.asyncio
async def test_wait_on_a_specific_child_still_works() -> None:
    """The original single-child contract is unchanged."""
    executor = _executor(_PhraseProvider({"task": "ok"}))

    spawned = await _call(executor, "agent_spawn", {"task": "task"}, "s1")
    payload = await _call(
        executor, "agent_wait", {"childId": spawned["childId"]}, "w1"
    )

    assert payload["childId"] == spawned["childId"]
    assert payload["status"] == "completed"
    await executor.shutdown()
