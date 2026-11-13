"""`delegate_subagent` with fork context.

The delegation seam and the six-tool family must agree about what forking
means, otherwise the same request behaves differently depending on which tool
the model happens to pick. Both seed the child with the parent's answered
transcript and both drop the parent's system prompt.

The profile default (`forkContext`) is tested here too: "this role continues
the conversation" belongs to the role, not to each individual call.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import (
    RouterToolExecutor,
    SubagentConfig,
    SubagentExecutor,
    SubagentRegistry,
    ToolRouter,
)
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk


class _RecordingProvider:
    name = "fake"
    model = "fake-model"

    def __init__(self) -> None:
        self.transcripts: list[list[LLMMessage]] = []

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        self.transcripts.append(list(messages))

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            yield LLMStreamChunk(content_delta="child answer")

        return _gen()


def _parent(*, answered: bool = True) -> list[LLMMessage]:
    messages = [
        LLMMessage.text_of("system", "parent system"),
        LLMMessage.text_of("user", "find the version"),
        LLMMessage.text_of("assistant", "it is 1.0.8"),
    ]
    if not answered:
        messages.append(LLMMessage.text_of("user", "and the next thing"))
    return messages


def _executor(
    provider: _RecordingProvider,
    *,
    projection: list[LLMMessage] | None,
    config: SubagentConfig | None = None,
    registry: SubagentRegistry | None = None,
) -> SubagentExecutor:
    return SubagentExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        config or SubagentConfig(),
        registry=registry,
        parent_projection=(lambda: list(projection)) if projection is not None else None,
    )


async def _delegate(executor: SubagentExecutor, args: dict[str, Any]) -> bool:
    result = await executor.execute(
        ToolCall(id="d1", name="delegate_subagent", arguments=args), None  # type: ignore[arg-type]
    )
    return result.success


@pytest.mark.asyncio
async def test_fork_seeds_the_delegated_child() -> None:
    provider = _RecordingProvider()
    executor = _executor(provider, projection=_parent())

    assert await _delegate(executor, {"task": "verify that version", "context": "fork"})
    await executor.shutdown()

    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    assert "it is 1.0.8" in joined
    assert "verify that version" in joined


@pytest.mark.asyncio
async def test_fresh_ignores_the_parent() -> None:
    provider = _RecordingProvider()
    executor = _executor(provider, projection=_parent())

    assert await _delegate(executor, {"task": "verify that version"})
    await executor.shutdown()

    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    assert "it is 1.0.8" not in joined


@pytest.mark.asyncio
async def test_fork_drops_the_parent_system_prompt() -> None:
    """The profile's prompt defines the child's role; the parent's would fight it."""
    provider = _RecordingProvider()
    executor = _executor(provider, projection=_parent())

    assert await _delegate(executor, {"task": "task", "context": "fork"})
    await executor.shutdown()

    systems = [m.content_text for m in provider.transcripts[0] if m.role == "system"]
    assert "parent system" not in systems


@pytest.mark.asyncio
async def test_a_profile_can_default_to_fork() -> None:
    """The role knows whether it continues the conversation; the call need not."""
    provider = _RecordingProvider()
    registry = SubagentRegistry()
    registry.register("reviewer", SubagentConfig(fork_context=True))
    executor = _executor(provider, projection=_parent(), registry=registry)

    assert await _delegate(
        executor, {"task": "check it", "subagent_type": "reviewer"}
    )
    await executor.shutdown()

    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    assert "it is 1.0.8" in joined


@pytest.mark.asyncio
async def test_an_explicit_fresh_overrides_the_profile_default() -> None:
    provider = _RecordingProvider()
    registry = SubagentRegistry()
    registry.register("reviewer", SubagentConfig(fork_context=True))
    executor = _executor(provider, projection=_parent(), registry=registry)

    assert await _delegate(
        executor,
        {"task": "check it", "subagent_type": "reviewer", "context": "fresh"},
    )
    await executor.shutdown()

    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    assert "it is 1.0.8" not in joined


@pytest.mark.asyncio
async def test_fork_without_a_wired_projection_fails() -> None:
    provider = _RecordingProvider()
    executor = _executor(provider, projection=None)

    assert not await _delegate(executor, {"task": "t", "context": "fork"})
    await executor.shutdown()
    assert provider.transcripts == []


@pytest.mark.asyncio
async def test_fork_with_nothing_answered_runs_fresh() -> None:
    provider = _RecordingProvider()
    executor = _executor(provider, projection=_parent(answered=False))

    assert await _delegate(executor, {"task": "t", "context": "fork"})
    await executor.shutdown()

    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    # The trailing unanswered question must not travel to the child.
    assert "and the next thing" not in joined


@pytest.mark.asyncio
async def test_an_unknown_context_is_refused() -> None:
    provider = _RecordingProvider()
    executor = _executor(provider, projection=_parent())

    assert not await _delegate(executor, {"task": "t", "context": "everything"})
    await executor.shutdown()
