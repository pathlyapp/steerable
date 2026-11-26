"""Phase 10 S1/S2 compaction, byte-budget, 413 tail shedding, partial compaction,
and crash-safe write-ahead journal tests (T-CMP-01..04, T-TXN-01)."""

from __future__ import annotations

import base64
import struct
from typing import Any

import pytest
from steerable_agent_runtime import (
    ChainHooks,
    CompactionHooks,
    CoreLoop,
    LoopContext,
    RetryHooks,
    RouterToolExecutor,
    ToolRouter,
    estimate_image_tokens,
    estimate_wire_bytes,
    load_history_transcript,
    recover_dangling_compaction,
)
from steerable_agent_runtime.llm import (
    ImagePart,
    LLMMessage,
    LLMStreamChunk,
    LLMUsage,
    TextPart,
)
from steerable_agent_runtime.llm.errors import LLMError


def _make_png_b64(width: int, height: int, pad_bytes: int = 0) -> str:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + (b"X" * pad_bytes)
    return base64.b64encode(raw).decode("ascii")


class _StubSummarizer:
    def __init__(self, reply: str = "Summarized middle context.") -> None:
        self.reply = reply
        self.calls: list[list[LLMMessage]] = []

    async def complete(
        self, messages: list[LLMMessage], **_kw: Any
    ) -> tuple[LLMMessage, LLMUsage]:
        self.calls.append(list(messages))
        return LLMMessage.text_of("assistant", self.reply), LLMUsage()


class _InMemoryHistoryStore:
    def __init__(self) -> None:
        self.rows: dict[str, list[dict[str, Any]]] = {}

    async def append_history(self, record_id: str, entries: list[dict[str, Any]]) -> None:
        bucket = self.rows.setdefault(record_id, [])
        bucket.extend(dict(e) for e in entries)

    async def list_history(
        self,
        record_id: str,
        *,
        after_seq: int = -1,
        until_seq: int | None = None,
        limit: int | None = None,
        reverse: bool = False,
    ) -> list[dict[str, Any]]:
        bucket = [
            dict(e)
            for e in self.rows.get(record_id, [])
            if int(e["seq"]) > after_seq
            and (until_seq is None or int(e["seq"]) <= until_seq)
        ]
        bucket.sort(key=lambda r: int(r["seq"]), reverse=reverse)
        if limit is not None:
            bucket = bucket[:limit]
        return bucket


def test_tile_aware_image_tokens_and_wire_bytes() -> None:
    small_part = ImagePart.from_base64(_make_png_b64(256, 256), media_type="image/png")
    retina_part = ImagePart.from_base64(
        _make_png_b64(3024, 1964, pad_bytes=600_000), media_type="image/png"
    )
    assert estimate_image_tokens(small_part) >= 1024
    retina_tokens = estimate_image_tokens(retina_part)
    assert retina_tokens > 1500

    msg = LLMMessage(
        role="user",
        content=[
            TextPart("Inspect this screenshot"),
            retina_part,
        ],
    )
    wire = estimate_wire_bytes([msg], tools=[{"name": "bash", "description": "run"}])
    assert wire > 800_000


@pytest.mark.asyncio
async def test_pre_step_byte_budget_triggers_compaction_and_tail_image_offload() -> None:
    """T-CMP-02: Even when max_context_tokens=1_000_000 (tokens < 50k), exceeding
    max_request_bytes * 0.85 triggers pre_step compaction + tail image shedding
    so the wire payload drops under max_request_bytes."""
    summarizer = _StubSummarizer("Summary of earlier browser steps.")
    max_bytes = 200_000
    hooks = CompactionHooks(
        max_context_tokens=1_000_000,
        max_request_bytes=max_bytes,
        summarizer=summarizer,
    )
    big_part = ImagePart.from_base64(
        _make_png_b64(1920, 1080, pad_bytes=120_000), media_type="image/png"
    )
    messages = [
        LLMMessage.text_of("system", "You are a helpful assistant."),
        LLMMessage(
            role="user",
            content=[
                TextPart("Here are two huge screenshots"),
                big_part,
                big_part,
            ],
        ),
        LLMMessage.text_of("assistant", "Checking now."),
        LLMMessage(
            role="user",
            content=[
                TextPart("And another big tail screenshot"),
                big_part,
            ],
        ),
    ]
    assert estimate_wire_bytes(messages) > max_bytes

    action = await hooks.pre_step(messages, LoopContext())
    assert action.kind == "proceed"
    assert action.rewrite is not None
    after_bytes = estimate_wire_bytes(list(action.rewrite.messages))
    assert after_bytes <= max_bytes


@pytest.mark.asyncio
async def test_413_with_fat_tail_images_sheds_tail_and_recovers_in_one_retry() -> None:
    """T-CMP-01 + T-CMP-03: Nginx 413 HTML response triggers context_overflow,
    and even when the transcript is short (only tail images), CompactionHooks
    sheds the oversized tail base64 image and succeeds on the next attempt."""
    big_part = ImagePart.from_base64(
        _make_png_b64(2560, 1440, pad_bytes=300_000), media_type="image/png"
    )

    class _GatewayWithBodyCap:
        model = "fake"

        def __init__(self, cap_bytes: int) -> None:
            self.cap_bytes = cap_bytes
            self.attempts = 0

        async def stream(self, messages: list[LLMMessage], **_kw: Any):
            self.attempts += 1
            if estimate_wire_bytes(messages) > self.cap_bytes:
                raise LLMError(
                    "HTTP 413: <html>413 Request Entity Too Large</html>",
                    kind="context_overflow",
                    status_code=413,
                )
            yield LLMStreamChunk(content_delta="Recovered cleanly!", finish_reason="stop")

    provider = _GatewayWithBodyCap(cap_bytes=100_000)
    hooks = ChainHooks(
        CompactionHooks(
            max_context_tokens=1_000_000,
            max_request_bytes=2_000_000,  # let the first request hit 413 directly
        ),
        RetryHooks(),
    )
    loop = CoreLoop(provider, RouterToolExecutor(ToolRouter()), hooks=hooks)
    messages = [
        LLMMessage.text_of("user", "Start"),
        LLMMessage(
            role="user",
            content=[
                TextPart("Huge screenshot in tail"),
                big_part,
            ],
        ),
        LLMMessage.text_of("assistant", "Looking"),
        LLMMessage.text_of("user", "Please finish"),
    ]
    events = [e async for e in loop.run(messages)]
    assert provider.attempts == 2
    assert events[-1].data["status"] == "completed"


@pytest.mark.asyncio
async def test_partial_compaction_focus_and_head_tail_preservation() -> None:
    """R3: compact_now accepts focus, keep_head_turns, keep_tail_messages."""
    summarizer = _StubSummarizer("Focused summary: SQL schema & port 5432.")
    hooks = CompactionHooks(max_context_tokens=100_000, summarizer=summarizer)
    messages = [
        LLMMessage.text_of("system", "sys"),
        LLMMessage.text_of("user", "u1"),
        LLMMessage.text_of("assistant", "a1"),
        LLMMessage.text_of("user", "u2"),
        LLMMessage.text_of("assistant", "a2"),
        LLMMessage.text_of("user", "u3"),
        LLMMessage.text_of("assistant", "a3"),
        LLMMessage.text_of("user", "u4"),
    ]
    action = await hooks.compact_now(
        messages,
        LoopContext(),
        focus="保留所有 SQL 表名与端口号",
        keep_head_turns=1,
        keep_tail_messages=2,
    )
    assert action.rewrite is not None
    assert len(summarizer.calls) == 1
    prompt_sent = summarizer.calls[0][-1].content_text
    assert "保留所有 SQL 表名与端口号" in prompt_sent
    rewritten = list(action.rewrite.messages)
    # sys + u1 (head 1 turn) + summary + a3 + u4 (tail 2 messages)
    assert rewritten[0].content_text == "sys"
    assert rewritten[1].content_text == "u1"
    assert "Focused summary" in rewritten[2].content_text
    assert rewritten[3].content_text == "a3"
    assert rewritten[4].content_text == "u4"

    # With keep_head_turns=2: keeps sys + u1 + a1 + u2 + a2 verbatim
    action2 = await hooks.compact_now(
        messages,
        LoopContext(),
        focus="保留所有 SQL 表名与端口号",
        keep_head_turns=2,
        keep_tail_messages=1,
    )
    assert action2.rewrite is not None
    rewritten2 = list(action2.rewrite.messages)
    assert [m.content_text for m in rewritten2[:5]] == ["sys", "u1", "a1", "u2", "a2"]
    assert "Focused summary" in rewritten2[5].content_text
    assert rewritten2[6].content_text == "u4"


@pytest.mark.asyncio
async def test_txn_write_ahead_journal_and_crash_safe_summary_reuse() -> None:
    """T-TXN-01:
    Case A: compaction_start written BEFORE summarizer.complete(); if summarizer
            crashes, resume ignores orphan compaction_start and preserves full history.
    Case B: compaction_start + compaction_summary written, then crash BEFORE
            boundary; resume closes the bracket using the saved summary_text with
            ZERO extra LLM calls."""
    store = _InMemoryHistoryStore()
    order: list[str] = []

    class _OrderCheckingSummarizer:
        async def complete(
            self, messages: list[LLMMessage], **_kw: Any
        ) -> tuple[LLMMessage, LLMUsage]:
            # Verify compaction_start is ALREADY persisted in store BEFORE LLM runs!
            persisted = store.rows.get("rec-live", [])
            assert any(e.get("entry") == "compaction_start" for e in persisted)
            order.append("summarizer_called")
            return (
                LLMMessage.text_of("assistant", "Paid durable summary"),
                LLMUsage(),
            )

    class _SimpleProvider:
        model = "fake"

        async def stream(self, messages: list[LLMMessage], **_kw: Any):
            yield LLMStreamChunk(content_delta="done", finish_reason="stop")

    # Verify live CoreLoop writes compaction_start ahead of summarizer.complete()
    hooks = CompactionHooks(
        max_context_tokens=200,
        threshold_ratio=0.1,
        keep_last_messages=2,
        summarizer=_OrderCheckingSummarizer(),
    )
    loop = CoreLoop(
        _SimpleProvider(),
        RouterToolExecutor(ToolRouter()),
        hooks=hooks,
        history_store=store,
        record_id="rec-live",
    )
    seed_msgs = [
        LLMMessage.text_of("user", "turn 1 " + "x" * 200),
        LLMMessage.text_of("assistant", "reply 1 " + "y" * 200),
        LLMMessage.text_of("user", "turn 2 " + "z" * 200),
        LLMMessage.text_of("assistant", "reply 2 " + "w" * 200),
        LLMMessage.text_of("user", "turn 3 " + "q" * 200),
    ]
    _ = [e async for e in loop.run(seed_msgs, chat_id="rec-live")]
    assert order == ["summarizer_called"]
    entries = store.rows["rec-live"]
    kinds = [e["entry"] for e in entries]
    assert kinds.index("compaction_start") < kinds.index("compaction_summary")
    assert kinds.index("compaction_summary") < kinds.index("boundary")

    # Case A: Orphan compaction_start (crash during summarizer) -> harmless no-op
    await store.append_history(
        "rec-orphan-start",
        [
            {"seq": 0, "entry": "item", "kind": "user", "message": {"role": "user", "content": [{"type": "text", "text": "u1"}]}},
            {"seq": 1, "entry": "item", "kind": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "a1"}]}},
            {"seq": 2, "entry": "item", "kind": "user", "message": {"role": "user", "content": [{"type": "text", "text": "u2"}]}},
            {
                "seq": 3,
                "entry": "compaction_start",
                "compaction_id": "cmp_crash1",
                "reason": "manual compact",
                "action": "summarize",
                "span_start_index": 1,
                "span_end_index": 2,
                "timestamp_ms": 1000,
            },
        ],
    )
    recovered_a = await recover_dangling_compaction(store, "rec-orphan-start")
    assert recovered_a is False
    proj_a = await load_history_transcript(store, "rec-orphan-start")
    assert [m.content_text for m in proj_a] == ["u1", "a1", "u2"]

    # Case B: compaction_start + compaction_summary without boundary -> closes cleanly!
    await store.append_history(
        "rec-paid-summary",
        [
            {"seq": 0, "entry": "item", "kind": "user", "message": {"role": "user", "content": [{"type": "text", "text": "head"}]}},
            {"seq": 1, "entry": "item", "kind": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "mid1"}]}},
            {"seq": 2, "entry": "item", "kind": "user", "message": {"role": "user", "content": [{"type": "text", "text": "mid2"}]}},
            {"seq": 3, "entry": "item", "kind": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "tail"}]}},
            {
                "seq": 4,
                "entry": "compaction_start",
                "compaction_id": "cmp_crash2",
                "reason": "pressure compact",
                "action": "summarize",
                "span_start_index": 1,
                "span_end_index": 3,
                "pre_tokens": 500,
                "timestamp_ms": 1000,
            },
            {
                "seq": 5,
                "entry": "compaction_summary",
                "compaction_id": "cmp_crash2",
                "summary_text": "Recovered summary of mid1 and mid2",
                "timestamp_ms": 1050,
            },
        ],
    )
    recovered_b = await recover_dangling_compaction(store, "rec-paid-summary")
    assert recovered_b is True
    proj_b = await load_history_transcript(store, "rec-paid-summary")
    assert len(proj_b) == 3
    assert proj_b[0].content_text == "head"
    assert "Recovered summary of mid1 and mid2" in proj_b[1].content_text
    assert proj_b[2].content_text == "tail"
    # Idempotent on second call
    assert await recover_dangling_compaction(store, "rec-paid-summary") is False
