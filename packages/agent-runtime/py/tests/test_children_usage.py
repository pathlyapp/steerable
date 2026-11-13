"""What the pool reports as the children's share of a turn's bill.

A host recording the turn's cost needs three things the parent's own usage
cannot give: the children's totals, a per-child split, and how many children
reported nothing at all. The last one is the easy one to get wrong — folding a
token-less external-engine child in as zero makes a partial bill look complete.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import CoreLoop, LoopConfig, RouterToolExecutor, ToolRouter
from steerable_agent_runtime.llm import LLMStreamChunk, LLMUsage
from steerable_agent_runtime.orchestration import (
    AgentPool,
    OrchestrationConfig,
    OrchestrationExecutor,
)

PARENT = "chat/p"


class _BillProvider:
    """One request billing a fixed number of tokens."""

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
                usage=LLMUsage(
                    prompt_tokens=total, completion_tokens=0, total_tokens=total
                )
            )

        return _gen()


class _SilentProvider:
    """Reports no usage at all — the shape an external engine has."""

    name = "fake"
    model = "fake-model"

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            yield LLMStreamChunk(content_delta="ok")

        return _gen()


def _executor(provider: Any, *, max_parallel: int = 4) -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(max_parallel=max_parallel),
    )


async def _spawn(
    executor: OrchestrationExecutor, task: str, call_id: str, **extra: Any
) -> None:
    result = await executor.execute(
        ToolCall(id=call_id, name="agent_spawn", arguments={"task": task, **extra}),
        None,  # type: ignore[arg-type]
    )
    assert result.success is True, result.error


@pytest.mark.asyncio
async def test_a_settled_child_reports_its_bill() -> None:
    executor = _executor(_BillProvider(120))

    await _spawn(executor, "task", "s1")
    await executor.pool.wait("0.1", 5)

    entries, unknown = executor.pool.children_usage()
    await executor.shutdown()

    assert unknown == 0
    assert [entry["childId"] for entry in entries] == ["0.1"]
    assert entries[0]["promptTokens"] == 120
    assert entries[0]["totalTokens"] == 120


@pytest.mark.asyncio
async def test_every_child_gets_its_own_entry() -> None:
    """Per-childId attribution is the point: 'the turn cost 40k' is not actionable."""
    executor = _executor(_BillProvider(100), max_parallel=2)

    await _spawn(executor, "task one", "s1")
    await _spawn(executor, "task two", "s2")
    await executor.pool.wait("0.1", 5)
    await executor.pool.wait("0.2", 5)

    entries, _unknown = executor.pool.children_usage()
    await executor.shutdown()

    assert sorted(entry["childId"] for entry in entries) == ["0.1", "0.2"]
    assert sum(int(entry["totalTokens"]) for entry in entries) == 200


@pytest.mark.asyncio
async def test_a_child_still_running_is_not_counted_yet() -> None:
    """It has not reported a bill; inventing one would overstate the turn."""
    executor = _executor(_BillProvider(100))

    await _spawn(executor, "task", "s1")
    entries, unknown = executor.pool.children_usage()
    await executor.shutdown()

    assert entries == []
    assert unknown == 0


@pytest.mark.asyncio
async def test_a_local_child_that_reports_nothing_is_a_known_zero() -> None:
    """A CoreLoop that reports no usage is a real zero, not an unknown."""
    executor = _executor(_SilentProvider())

    await _spawn(executor, "task", "s1")
    await executor.pool.wait("0.1", 5)

    entries, unknown = executor.pool.children_usage()
    await executor.shutdown()

    assert unknown == 0
    assert entries[0]["totalTokens"] == 0


@pytest.mark.asyncio
async def test_an_external_engine_counts_as_unknown_not_zero() -> None:
    """The distinction a host needs to mark its total as partial.

    An ACP child reports no token bill at all. Folding it in as zero would make
    a partial turn total look like a complete one.
    """
    pool = AgentPool(config=OrchestrationConfig(), depth=0, lineage="0")

    def factory(
        _child_id: str, _tool_filter: frozenset[str] | None
    ) -> tuple[CoreLoop, list[dict[str, Any]] | None]:
        return (
            CoreLoop(
                _SilentProvider(),
                RouterToolExecutor(ToolRouter()),
                LoopConfig(max_rounds=2),
            ),
            None,
        )

    handle = pool.spawn("task", None, loop_factory=factory, engine="acp")
    await pool.wait(handle.child_id, 5)

    entries, unknown = pool.children_usage()
    await pool.shutdown()

    assert entries == []
    assert unknown == 1


@pytest.mark.asyncio
async def test_a_child_declared_unknown_is_not_also_counted_as_tokens() -> None:
    executor = _executor(_BillProvider(50))
    await _spawn(executor, "task one", "s1")
    await executor.pool.wait("0.1", 5)

    # Rewrite the settled handle into the external-engine shape: it ran, and
    # the engine reports no tokens at all.
    handle = executor.pool.get("0.1")
    assert handle is not None
    handle.usage_known = False

    entries, unknown = executor.pool.children_usage()
    await executor.shutdown()

    assert entries == []
    assert unknown == 1


@pytest.mark.asyncio
async def test_the_split_carries_the_profile_when_one_was_resolved() -> None:
    executor = _executor(_BillProvider(10))

    await _spawn(executor, "task", "s1", subagent_type="explore")
    await executor.pool.wait("0.1", 5)

    entries, _unknown = executor.pool.children_usage()
    await executor.shutdown()

    assert entries[0]["profile"] == "explore"
