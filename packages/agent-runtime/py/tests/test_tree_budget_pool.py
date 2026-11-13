"""The pool charges the shared tree budget, and reports it.

Two behaviours matter here and only here:

- a child's usage reaches the tree counter (not just its own registry row);
- a tree with nothing left refuses to start a child, rather than letting it
  run to its own wall and fail afterwards — the run would cost tokens for an
  answer that gets thrown away.
"""

from __future__ import annotations

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
    TreeBudget,
)
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk, LLMUsage
from steerable_agent_runtime.orchestration import (
    OrchestrationConfig,
    OrchestrationExecutor,
)
from steerable_agent_runtime.registry import default_record_id
from steerable_agent_runtime.storage import InMemoryStorage

PARENT = "chat/p"


class _UsageProvider:
    """Reports a fixed token bill so the tree counter has something to charge."""

    name = "fake"
    model = "fake-model"

    def __init__(self, total: int) -> None:
        self._total = total

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        total = self._total

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            yield LLMStreamChunk(content_delta="ok")
            yield LLMStreamChunk(
                usage=LLMUsage(prompt_tokens=total, completion_tokens=0, total_tokens=total)
            )

        return _gen()


def _executor(
    provider: Any, *, budget: TreeBudget | None, max_parallel: int = 4
) -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(max_parallel=max_parallel),
        registry=ChildRegistry(InMemoryStorage()),
        parent_record_id=PARENT,
        budget=budget,
    )


async def _spawn(executor: OrchestrationExecutor, task: str = "task") -> dict[str, Any]:
    import json

    result = await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": task}),
        None,  # type: ignore[arg-type]
    )
    assert result.success is True, result.error
    return json.loads(result.message or "{}")


@pytest.mark.asyncio
async def test_a_child_charges_the_tree_budget() -> None:
    budget = TreeBudget(limit=10_000)
    executor = _executor(_UsageProvider(120), budget=budget)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    report = budget.report()
    assert report.spent >= 120
    assert report.by_agent.get("0.1", 0) >= 120


@pytest.mark.asyncio
async def test_two_children_both_charge_the_same_counter() -> None:
    budget = TreeBudget(limit=10_000)
    executor = _executor(_UsageProvider(100), budget=budget, max_parallel=4)

    for call_id in ("s1", "s2"):
        result = await executor.execute(
            ToolCall(id=call_id, name="agent_spawn", arguments={"task": "task"}),
            None,  # type: ignore[arg-type]
        )
        assert result.success is True
    await executor._pool.wait("0.1", 5)
    await executor._pool.wait("0.2", 5)
    await executor.shutdown()

    report = budget.report()
    # Both children are attributed separately, and the total is their sum.
    assert set(report.by_agent) >= {"0.1", "0.2"}
    assert report.spent >= 200


@pytest.mark.asyncio
async def test_an_exhausted_tree_refuses_a_new_child() -> None:
    """Starting a child that cannot finish costs tokens for nothing."""
    budget = TreeBudget(limit=10)
    executor = _executor(_UsageProvider(500), budget=budget)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)

    result = await executor.execute(
        ToolCall(id="s2", name="agent_spawn", arguments={"task": "another"}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "orchestration_budget_exceeded" in (result.error or "")
    assert "tokens" in (result.error or "")


@pytest.mark.asyncio
async def test_without_a_budget_nothing_is_charged_or_refused() -> None:
    """A host that did not ask for a tree limit keeps the old behaviour."""
    executor = _executor(_UsageProvider(9_999), budget=None)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)
    result = await executor.execute(
        ToolCall(id="s2", name="agent_spawn", arguments={"task": "another"}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is True


@pytest.mark.asyncio
async def test_budget_report_is_none_without_a_budget() -> None:
    """'No limit' must be distinguishable from 'nothing spent'."""
    executor = _executor(_UsageProvider(10), budget=None)
    assert executor.pool.budget_report() is None
    await executor.shutdown()


@pytest.mark.asyncio
async def test_budget_report_exposes_the_split_for_a_host() -> None:
    budget = TreeBudget(limit=5_000)
    executor = _executor(_UsageProvider(400), budget=budget)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)

    report = executor.pool.budget_report()
    await executor.shutdown()

    assert report is not None
    assert report.limit == 5_000
    assert report.by_agent.get("0.1", 0) >= 400


@pytest.mark.asyncio
async def test_the_child_event_carries_usage() -> None:
    """A host rendering the child list needs the bill without a second read."""
    events: list[tuple[str, dict[str, Any]]] = []
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _UsageProvider(250),
        OrchestrationConfig(),
        registry=ChildRegistry(InMemoryStorage()),
        parent_record_id=PARENT,
        event_sink=lambda kind, data: events.append((kind, data)),
    )

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    completed = next(data for kind, data in events if kind == "child_completed")
    usage = completed["usage"]
    assert usage["totalTokens"] >= 250
    assert usage["promptTokens"] >= 250


@pytest.mark.asyncio
async def test_the_registry_row_records_the_same_numbers() -> None:
    storage = InMemoryStorage()
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _UsageProvider(300),
        OrchestrationConfig(),
        registry=ChildRegistry(storage),
        parent_record_id=PARENT,
    )

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    row = await storage.get_child(default_record_id(PARENT, "0.1"))
    assert row is not None
    assert (row.prompt_tokens or 0) >= 300
