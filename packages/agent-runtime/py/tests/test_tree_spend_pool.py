"""The pool records each child's spend into the shared tree counter.

Two behaviours matter here and only here:

- a child's usage reaches the tree counter (not just its own registry row), so
  the host reads one number for the turn instead of adding up loops;
- nothing is refused for spending too much: the counter reports, it does not
  gate. A previous design refused the next spawn once the tree overflowed, and
  left children stopped mid-task at ``budget_exhausted``.
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
    TreeSpend,
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
    """Reports a fixed token bill so the tree counter has something to record."""

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
    provider: Any, *, spend: TreeSpend | None, max_parallel: int = 4
) -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(max_parallel=max_parallel),
        registry=ChildRegistry(InMemoryStorage()),
        parent_record_id=PARENT,
        spend=spend,
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
async def test_a_child_records_into_the_tree_counter() -> None:
    spend = TreeSpend()
    executor = _executor(_UsageProvider(120), spend=spend)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    report = spend.report()
    assert report.spent >= 120
    assert report.by_agent.get("0.1", 0) >= 120


@pytest.mark.asyncio
async def test_two_children_share_one_counter() -> None:
    spend = TreeSpend()
    executor = _executor(_UsageProvider(100), spend=spend, max_parallel=4)

    for call_id in ("s1", "s2"):
        result = await executor.execute(
            ToolCall(id=call_id, name="agent_spawn", arguments={"task": "task"}),
            None,  # type: ignore[arg-type]
        )
        assert result.success is True
    await executor._pool.wait("0.1", 5)
    await executor._pool.wait("0.2", 5)
    await executor.shutdown()

    report = spend.report()
    # Both children are attributed separately, and the total is their sum.
    assert set(report.by_agent) >= {"0.1", "0.2"}
    assert report.spent >= 200


@pytest.mark.asyncio
async def test_a_huge_spend_does_not_refuse_the_next_child() -> None:
    """Reporting is not gating: the turn keeps working and the host sees the bill.

    The old behaviour refused this spawn with ``orchestration_budget_exceeded``
    once the tree crossed its limit. That stopped a task the user had already
    paid for partway through, for a limit nobody had asked to enforce.
    """
    spend = TreeSpend()
    executor = _executor(_UsageProvider(500_000), spend=spend)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)

    result = await executor.execute(
        ToolCall(id="s2", name="agent_spawn", arguments={"task": "another"}),
        None,  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.2", 5)
    await executor.shutdown()

    assert result.success is True, result.error
    assert spend.report().spent >= 1_000_000


@pytest.mark.asyncio
async def test_without_a_counter_nothing_is_recorded() -> None:
    """A bare pool (tests, hosts without a tree) keeps working unchanged."""
    executor = _executor(_UsageProvider(9_999), spend=None)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)
    result = await executor.execute(
        ToolCall(id="s2", name="agent_spawn", arguments={"task": "another"}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is True
    assert executor.pool.spend_report() is None


@pytest.mark.asyncio
async def test_spend_report_exposes_the_split_for_a_host() -> None:
    spend = TreeSpend()
    executor = _executor(_UsageProvider(400), spend=spend)

    await _spawn(executor)
    await executor._pool.wait("0.1", 5)

    report = executor.pool.spend_report()
    await executor.shutdown()

    assert report is not None
    assert report.spent >= 400
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
