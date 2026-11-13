"""`agent_spawn` with `context: "fork"`: a child that inherits the work so far.

The point of forking is "keep going from what I already found". These tests
pin the two halves of that contract:

- the child actually receives the parent's answered transcript, so it can
  answer about earlier findings without being told again;
- it never receives an unanswerable transcript — an in-flight tool round is
  excluded, and when nothing has been answered yet the spawn degrades to a
  fresh child instead of pretending it has context.
"""

from __future__ import annotations

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
from steerable_agent_runtime.history import ContextManager
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk
from steerable_agent_runtime.orchestration import (
    OrchestrationConfig,
    OrchestrationExecutor,
)
from steerable_agent_runtime.storage import InMemoryStorage

PARENT = "chat/p"


class _RecordingProvider:
    """Answers by phrase; records every transcript it is asked about."""

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


def _call(call_id: str, name: str = "work") -> ToolCall:
    return ToolCall(id=call_id, name=name, arguments={})


def _parent_transcript(*, dangling: bool = False) -> list[LLMMessage]:
    """A parent that investigated a version number and reported it."""
    messages = [
        LLMMessage.text_of("system", "parent system prompt"),
        LLMMessage.text_of("user", "which keel version is pinned?"),
        LLMMessage.text_of("assistant", "", tool_calls=[_call("c1", "grep")]),
        LLMMessage.text_of("tool", "rust-artifacts.lock.json: 1.0.8", tool_call_id="c1"),
        LLMMessage.text_of("assistant", "keel is pinned at 1.0.8."),
    ]
    if dangling:
        messages.append(LLMMessage.text_of("assistant", "", tool_calls=[_call("c2", "grep")]))
    return messages


def _executor(
    provider: Any,
    *,
    projection: list[LLMMessage] | None,
    max_depth: int = 1,
    fork_turns: int | None = None,
) -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(max_depth=max_depth, fork_turns=fork_turns),
        registry=ChildRegistry(InMemoryStorage()),
        parent_record_id=PARENT,
        parent_projection=(lambda: list(projection)) if projection is not None else None,
    )


async def _spawn(executor: OrchestrationExecutor, args: dict[str, Any]) -> dict[str, Any]:
    result = await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments=args), None  # type: ignore[arg-type]
    )
    assert result.success is True, result.error
    return json.loads(result.message or "{}")


@pytest.mark.asyncio
async def test_fork_seeds_the_child_with_the_parent_transcript() -> None:
    provider = _RecordingProvider({"version": "it is 1.0.8"})
    executor = _executor(provider, projection=_parent_transcript())

    payload = await _spawn(
        executor,
        {"task": "confirm the version you found", "context": "fork"},
    )
    await executor._pool.wait(payload["childId"], 5)
    await executor.shutdown()

    assert provider.transcripts, "the child never ran"
    child = provider.transcripts[0]
    joined = "\n".join(m.content_text for m in child)
    # The earlier investigation is present — including the tool result, which
    # is what makes the conclusion verifiable rather than remembered.
    assert "which keel version is pinned?" in joined
    assert "1.0.8" in joined
    # And the new task is still the last thing the child is asked.
    assert "confirm the version you found" in joined
    assert child[-1].role == "user"


@pytest.mark.asyncio
async def test_fork_excludes_the_parent_system_prompt() -> None:
    """The child's own system prompt replaces the parent's; two would fight."""
    provider = _RecordingProvider({"task": "ok"})
    executor = _executor(provider, projection=_parent_transcript())

    await _spawn(executor, {"task": "task", "context": "fork"})
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    child = provider.transcripts[0]
    system_texts = [m.content_text for m in child if m.role == "system"]
    assert "parent system prompt" not in system_texts


@pytest.mark.asyncio
async def test_fork_drops_the_in_flight_round() -> None:
    """A dangling tool call cannot be replayed, so it must not be seeded."""
    provider = _RecordingProvider({"task": "ok"})
    executor = _executor(provider, projection=_parent_transcript(dangling=True))

    await _spawn(executor, {"task": "task", "context": "fork"})
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    child = provider.transcripts[0]
    for message in child:
        for call in message.tool_calls or []:
            # Every call in the seed has a matching result.
            assert any(
                other.role == "tool" and other.tool_call_id == call.id for other in child
            ), f"seeded a dangling call {call.id}"


@pytest.mark.asyncio
async def test_fork_with_nothing_answered_behaves_like_fresh() -> None:
    """No answered turn means nothing to inherit — not a fabricated context."""
    provider = _RecordingProvider({"task": "ok"})
    executor = _executor(
        provider,
        projection=[LLMMessage.text_of("user", "brand new question")],
    )

    await _spawn(executor, {"task": "task", "context": "fork"})
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    child = provider.transcripts[0]
    joined = "\n".join(m.content_text for m in child)
    assert "brand new question" not in joined
    assert "task" in joined


@pytest.mark.asyncio
async def test_fresh_ignores_the_parent_transcript() -> None:
    provider = _RecordingProvider({"task": "ok"})
    executor = _executor(provider, projection=_parent_transcript())

    await _spawn(executor, {"task": "task"})
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    assert "which keel version is pinned?" not in joined


@pytest.mark.asyncio
async def test_fork_without_a_wired_projection_fails_closed() -> None:
    """Silently degrading to fresh would make the child claim context it lacks."""
    provider = _RecordingProvider({"task": "ok"})
    executor = _executor(provider, projection=None)

    result = await executor.execute(
        ToolCall(
            id="s1",
            name="agent_spawn",
            arguments={"task": "task", "context": "fork"},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "fork" in (result.error or "")
    assert "fresh" in (result.error or "")


@pytest.mark.asyncio
async def test_an_unknown_context_is_refused() -> None:
    provider = _RecordingProvider({"task": "ok"})
    executor = _executor(provider, projection=_parent_transcript())

    result = await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "t", "context": "all"}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "unknown context" in (result.error or "")


@pytest.mark.asyncio
async def test_fork_turns_limits_the_inherited_span() -> None:
    """The over-long-conversation escape hatch keeps only recent requests."""
    provider = _RecordingProvider({"task": "ok"})
    transcript = [
        LLMMessage.text_of("user", "oldest question"),
        LLMMessage.text_of("assistant", "oldest answer"),
        LLMMessage.text_of("user", "newest question"),
        LLMMessage.text_of("assistant", "newest answer"),
    ]
    executor = _executor(provider, projection=transcript, fork_turns=1)

    await _spawn(executor, {"task": "task", "context": "fork"})
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    joined = "\n".join(m.content_text for m in provider.transcripts[0])
    assert "newest question" in joined
    assert "oldest question" not in joined


@pytest.mark.asyncio
async def test_a_forked_child_still_cannot_spawn_when_depth_forbids_it() -> None:
    """Forking must not be a way around the depth budget."""
    provider = _RecordingProvider({"task": "ok"})
    executor = _executor(provider, projection=_parent_transcript(), max_depth=1)

    await _spawn(executor, {"task": "task", "context": "fork"})
    await executor._pool.wait("0.1", 5)
    await executor.shutdown()

    _, schemas = executor._child_loop("0.1", None, depth=1)
    names = {schema["function"]["name"] for schema in (schemas or [])}
    assert "agent_spawn" not in names
