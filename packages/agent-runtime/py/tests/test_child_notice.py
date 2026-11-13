"""Child terminal notices: the parent is told, not left to poll.

Polling ``agent_wait`` costs a model round per check and depends on the model
remembering to look. This hook appends a notice at the parent's next round
boundary instead.

What the tests pin is mostly what the notice must **not** be:

- not a user message (nothing about it came from the user);
- not a carrier for the child's answer (``agent_wait`` still owns that, so the
  answer is not duplicated into the parent's context);
- not repeated (a settled child notifies once, not on every later step).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import (
    CHILD_NOTICE_KIND,
    ChildNoticeHooks,
    ChildRegistry,
    CoreLoop,
    LoopConfig,
    RouterToolExecutor,
    ToolRouter,
    render_child_notice,
)
from steerable_agent_runtime.hooks import ChainHooks, NoopHooks
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk
from steerable_agent_runtime.loop import LoopContext
from steerable_agent_runtime.orchestration import (
    OrchestrationConfig,
    OrchestrationExecutor,
)
from steerable_agent_runtime.storage import InMemoryStorage

PARENT = "chat/p"


class _Provider:
    name = "fake"
    model = "fake-model"

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            yield LLMStreamChunk(content_delta="ok")

        return _gen()


def _executor() -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _Provider(),
        OrchestrationConfig(),
        registry=ChildRegistry(InMemoryStorage()),
        parent_record_id=PARENT,
    )


def test_the_notice_is_a_system_message_naming_the_child() -> None:
    text = render_child_notice("0.2", "completed", "the answer")
    assert "0.2" in text
    assert "finished" in text
    # The answer must not travel with the notice.
    assert "the answer" not in text
    # And it points at the tool that does carry it.
    assert "agent_wait" in text


def test_a_non_completed_status_is_named_verbatim() -> None:
    text = render_child_notice("0.3", "budget_exhausted", "")
    assert "budget_exhausted" in text


@pytest.mark.asyncio
async def test_a_finished_child_produces_one_notice() -> None:
    executor = _executor()
    await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "task"}),
        None,  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.1", 5)

    notices = executor._pool.drain_notices()

    assert len(notices) == 1
    child_id, status, _answer = notices[0]
    assert child_id == "0.1"
    assert status == "completed"
    await executor.shutdown()


@pytest.mark.asyncio
async def test_draining_is_destructive() -> None:
    """A settled child must not re-notify on every later step."""
    executor = _executor()
    await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "task"}),
        None,  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.1", 5)

    assert len(executor._pool.drain_notices()) == 1
    assert executor._pool.drain_notices() == []
    await executor.shutdown()


@pytest.mark.asyncio
async def test_the_failed_child_also_notifies() -> None:
    """A failure is news too — otherwise the parent waits for an answer that
    will never come."""

    class _Raising:
        name = "fake"
        model = "fake-model"

        async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
            raise NotImplementedError

        def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
            async def _gen() -> AsyncIterator[LLMStreamChunk]:
                raise RuntimeError("boom")
                yield LLMStreamChunk()  # pragma: no cover

            return _gen()

    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _Raising(),
        OrchestrationConfig(),
        registry=ChildRegistry(InMemoryStorage()),
        parent_record_id=PARENT,
    )
    await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "task"}),
        None,  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.1", 5)

    notices = executor._pool.drain_notices()
    assert len(notices) == 1
    assert notices[0][1] == "failed"
    await executor.shutdown()


@pytest.mark.asyncio
async def test_the_hook_appends_a_system_message_with_its_own_kind() -> None:
    executor = _executor()
    await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "task"}),
        None,  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.1", 5)

    hooks = ChildNoticeHooks(executor.pool)
    action = await hooks.pre_step([LLMMessage.text_of("user", "go")], LoopContext())

    assert action.kind == "proceed"
    assert action.append_action == "child_notice"
    assert action.appends is not None and len(action.appends) == 1
    appended = action.appends[0]
    # System role: the model must not read this as something the user said.
    assert appended.message.role == "system"
    assert appended.kind == CHILD_NOTICE_KIND
    await executor.shutdown()


@pytest.mark.asyncio
async def test_the_hook_is_silent_when_nothing_settled() -> None:
    executor = _executor()
    hooks = ChildNoticeHooks(executor.pool)

    action = await hooks.pre_step([], LoopContext())

    assert action.kind == "proceed"
    assert action.appends is None
    await executor.shutdown()


@pytest.mark.asyncio
async def test_the_hook_delivers_each_notice_once_across_steps() -> None:
    """Two children settling produce two notices, then nothing."""
    executor = _executor()
    for call_id in ("s1", "s2"):
        await executor.execute(
            ToolCall(id=call_id, name="agent_spawn", arguments={"task": "task"}),
            None,  # type: ignore[arg-type]
        )
    await asyncio.gather(
        executor._pool.wait("0.1", 5), executor._pool.wait("0.2", 5)
    )

    hooks = ChildNoticeHooks(executor.pool)
    first = await hooks.pre_step([], LoopContext())
    second = await hooks.pre_step([], LoopContext())

    assert first.appends is not None and len(first.appends) == 2
    assert second.appends is None
    await executor.shutdown()


@pytest.mark.asyncio
async def test_notices_survive_without_a_registry() -> None:
    """A host with no storage adapter still gets told a child finished."""
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _Provider(),
        OrchestrationConfig(),
    )
    await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "task"}),
        None,  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.1", 5)

    notices = executor._pool.drain_notices()
    assert len(notices) == 1
    await executor.shutdown()


@pytest.mark.asyncio
async def test_the_hook_composes_with_other_hooks() -> None:
    """Hosts install several hooks; this one only ever appends."""
    executor = _executor()
    await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "task"}),
        None,  # type: ignore[arg-type]
    )
    await executor._pool.wait("0.1", 5)

    chain = ChainHooks(NoopHooks(), ChildNoticeHooks(executor.pool))
    action = await chain.pre_step([], LoopContext())

    assert action.appends is not None and len(action.appends) == 1
    await executor.shutdown()
