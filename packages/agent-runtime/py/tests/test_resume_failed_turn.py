"""P1-01: can a *failed* turn be resumed from the durable record?

The desktop's 「继续」 button reuses W7-1's `resume` channel, which replays
the record's projection as the loop seed. That channel was built for turns a
crash cut off, so this file answers the two questions a failed turn raises:

1. Does the record hold everything the turn completed before it failed? The
   loop flushes before every model request and after every tool batch, so a
   turn that failed while asking the model for round N must have rounds
   1..N-1 — their assistant text, tool calls and tool results — on disk.
2. Does resuming from that record re-run any completed tool? It must not: the
   user pressed Continue to finish the task, not to repeat side effects.

A "no" to either would make the button wrong to ship. Both hold today, and
these tests pin both so a later change to flush points or projection cannot
silently break Continue.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall

from steerable_agent_runtime import (
    CoreLoop,
    LLMMessage,
    RouterToolExecutor,
    ToolRouter,
    load_history_transcript,
    tool,
)
from steerable_agent_runtime.hooks import NoopHooks
from steerable_agent_runtime.llm import LLMStreamChunk
from steerable_agent_runtime.llm.errors import LLMError
from steerable_agent_runtime.storage import InMemoryStorage


class _RoundProvider:
    """Plays fixed rounds; raises a transport error on chosen 1-based rounds."""

    name = "fake"
    model = "fake-model"

    def __init__(self, script: list[dict[str, Any]], fail_on: set[int] | None = None):
        self._script = script
        self._fail_on = fail_on or set()
        self._round = 1
        self.calls: list[list[LLMMessage]] = []

    async def complete(self, messages, *, tools=None, **kw):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages, *, tools=None, **kw) -> AsyncIterator[LLMStreamChunk]:
        self.calls.append(list(messages))
        round_index = self._round
        self._round += 1
        entry = self._script[min(round_index - 1, len(self._script) - 1)]
        fail = round_index in self._fail_on

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            if fail:
                raise LLMError(
                    "openai_compat: transport error: ConnectError",
                    kind="transport",
                )
            if entry.get("content"):
                yield LLMStreamChunk(content_delta=entry["content"])
            for call in entry.get("tool_calls", []):
                yield LLMStreamChunk(tool_call_delta=call)
            yield LLMStreamChunk(
                finish_reason="tool_calls" if entry.get("tool_calls") else "stop"
            )

        return _gen()


def _counting_router(counter: dict[str, int]) -> ToolRouter:
    router = ToolRouter()

    @tool(router=router, description="Read a file")
    async def read_file(path: str) -> dict[str, str]:
        counter["read_file"] = counter.get("read_file", 0) + 1
        return {"content": f"contents of {path}"}

    @tool(router=router, description="Write a file")
    async def write_file(path: str, text: str) -> dict[str, str]:
        counter["write_file"] = counter.get("write_file", 0) + 1
        return {"path": path, "bytes": str(len(text))}

    return router


async def _drain(run: AsyncIterator[Any]) -> list[Any]:
    return [event async for event in run]


@pytest.mark.asyncio
async def test_record_holds_every_completed_round_of_a_failed_turn() -> None:
    """Question 1: the record must be complete up to the failure.

    Without this, Continue would resume from a transcript missing the work the
    user already paid for — the model would either redo it or answer as if it
    had never happened.
    """
    counter: dict[str, int] = {}
    storage = InMemoryStorage()
    provider = _RoundProvider(
        [
            {"tool_calls": [ToolCall(id="c1", name="read_file", arguments={"path": "a"})]},
            {
                "tool_calls": [
                    ToolCall(
                        id="c2",
                        name="write_file",
                        arguments={"path": "b", "text": "hello"},
                    )
                ]
            },
            {"content": "never reached"},
        ],
        fail_on={3},
    )
    loop = CoreLoop(
        provider,
        RouterToolExecutor(_counting_router(counter)),
        hooks=NoopHooks(),
        history_store=storage,
        record_id="chat_1",
    )

    events = await _drain(loop.run([LLMMessage.text_of("user", "整理资料")], chat_id="chat_1"))

    assert [e for e in events if e.kind == "completion"][-1].data["status"] == "failed"
    assert counter == {"read_file": 1, "write_file": 1}

    transcript = await load_history_transcript(storage, "chat_1")
    assert transcript is not None
    roles = [message.role for message in transcript]
    assert roles == ["user", "assistant", "tool", "assistant", "tool"], (
        f"record should hold both completed rounds, got {roles}"
    )
    # The tools' results are recorded, not just their calls: that is what
    # makes the resumed model able to continue instead of re-asking.
    assert "contents of a" in transcript[2].content_text
    assert "bytes" in transcript[4].content_text


@pytest.mark.asyncio
async def test_resuming_a_failed_turn_does_not_rerun_completed_tools() -> None:
    """Question 2: Continue finishes the turn; it does not repeat side effects.

    Resume seeds the loop with the record's projection, so the model sees its
    own completed rounds and asks for the next one. A write_file that already
    ran must not run twice.
    """
    counter: dict[str, int] = {}
    storage = InMemoryStorage()

    first = _RoundProvider(
        [
            {"tool_calls": [ToolCall(id="c1", name="read_file", arguments={"path": "a"})]},
            {
                "tool_calls": [
                    ToolCall(
                        id="c2",
                        name="write_file",
                        arguments={"path": "b", "text": "hello"},
                    )
                ]
            },
            {"content": "never reached"},
        ],
        fail_on={3},
    )
    first_loop = CoreLoop(
        first,
        RouterToolExecutor(_counting_router(counter)),
        hooks=NoopHooks(),
        history_store=storage,
        record_id="chat_1",
    )
    await _drain(first_loop.run([LLMMessage.text_of("user", "整理资料")], chat_id="chat_1"))
    assert counter == {"read_file": 1, "write_file": 1}

    # Continue: the record is the seed, exactly as the sidecar's resume path
    # builds it (`load_history_transcript` + a fresh run).
    record_seed = await load_history_transcript(storage, "chat_1")
    assert record_seed is not None

    second = _RoundProvider([{"content": "整理完成"}])
    second_loop = CoreLoop(
        second,
        RouterToolExecutor(_counting_router(counter)),
        hooks=NoopHooks(),
        history_store=storage,
        record_id="chat_1",
    )
    resumed_events = await _drain(second_loop.run(record_seed, chat_id="chat_1"))

    assert [e for e in resumed_events if e.kind == "completion"][-1].data["status"] == "completed"
    assert counter == {"read_file": 1, "write_file": 1}, (
        f"Continue re-ran a completed tool: {counter}"
    )
    # The model was handed the earlier rounds, not a blank slate.
    sent = second.calls[0]
    assert [message.role for message in sent] == [
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
    ]


@pytest.mark.asyncio
async def test_resume_after_a_first_round_failure_still_has_the_user_turn() -> None:
    """A turn that failed before any tool ran is resumable too.

    The common case in the field is the very first request dying (proxy, DNS).
    The record then holds the user message alone, and Continue must still have
    something to seed from — otherwise the button 409s exactly where users
    need it most.
    """
    storage = InMemoryStorage()
    provider = _RoundProvider([{"content": "never reached"}], fail_on={1})
    loop = CoreLoop(
        provider,
        RouterToolExecutor(_counting_router({})),
        hooks=NoopHooks(),
        history_store=storage,
        record_id="chat_2",
    )
    await _drain(loop.run([LLMMessage.text_of("user", "写个总结")], chat_id="chat_2"))

    record_seed = await load_history_transcript(storage, "chat_2")
    assert record_seed is not None
    assert [message.role for message in record_seed] == ["user"]
    assert record_seed[0].content_text == "写个总结"


@pytest.mark.asyncio
async def test_a_failure_that_emitted_partial_text_resumes_without_duplicating_it() -> None:
    """A turn can fail after streaming some text. Continue must not replay it.

    The record holds the abandoned attempt's text only if the loop flushed it;
    what the retry path withdrew was the *display*, not the record. Either way
    the resumed transcript must contain the text at most once — the model
    re-answering after a duplicate would contradict what it already said.
    """
    storage = InMemoryStorage()

    class _PartialThenFail:
        name = "fake"
        model = "fake-model"

        def __init__(self) -> None:
            self._round = 0

        async def complete(self, messages, *, tools=None, **kw):  # pragma: no cover
            raise NotImplementedError

        def stream(self, messages, *, tools=None, **kw) -> AsyncIterator[LLMStreamChunk]:
            self._round += 1

            async def _gen() -> AsyncIterator[LLMStreamChunk]:
                if self._round == 1:
                    yield LLMStreamChunk(content_delta="我先看一下文件")
                    raise LLMError(
                        "openai_compat: transport error: connection reset",
                        kind="transport",
                    )
                yield LLMStreamChunk(content_delta="完成")

            return _gen()

    loop = CoreLoop(
        _PartialThenFail(),
        RouterToolExecutor(_counting_router({})),
        hooks=NoopHooks(),
        history_store=storage,
        record_id="chat_3",
    )
    await _drain(loop.run([LLMMessage.text_of("user", "看看文件")], chat_id="chat_3"))

    transcript = await load_history_transcript(storage, "chat_3")
    assert transcript is not None
    text = "\n".join(message.content_text for message in transcript)
    assert text.count("我先看一下文件") <= 1, f"partial text duplicated: {text}"
