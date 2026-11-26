"""Phase 9 R7 tests for SideCallPort & PromisedActionContinuationHooks (T-SC-01..04)."""

from __future__ import annotations

import asyncio
import time
import pytest

from steerable_agent_runtime import (
    DEFAULT_HEAD_CHARS,
    DEFAULT_TAIL_CHARS,
    PromisedActionContinuationHooks,
    SideCallPort,
    SideCallSecretRedactor,
    SideCallSpec,
)
from steerable_agent_runtime.hooks import CompletionDraft
from steerable_agent_runtime.llm import LLMMessage
from steerable_agent_runtime.loop import LoopContext


@pytest.mark.asyncio
async def test_sidecall_window_redaction_and_independent_usage() -> None:
    """T-SC-01: SideCallPort slices to 2000+8000 chars, scrubs secrets, and tags usage `sidecall:<caller>`."""
    secret = "custom-tenant-secret-445566"
    redactor = SideCallSecretRedactor([secret])

    async def fake_completer(messages: list[dict[str, str]]) -> tuple[str, tuple[int, int]]:
        return '{"promised": true, "reason": "ok"}', (120, 14)

    port = SideCallPort(fake_completer, redactor=redactor)
    huge_user = f"token={secret} sk-abcdef1234567890abcdef " + ("U" * 6_000)
    huge_assistant = ("A" * 18_000) + " Authorization: Bearer supersecretjwt9876543210"

    spec = SideCallSpec(
        caller="promised_action",
        system_prompt="classify",
        response_schema={"type": "object", "required": ["promised"]},
        fallback_value={"promised": False},
    )
    out = await port.invoke(spec, user_input=huge_user, assistant_output=huge_assistant)
    assert out.ok is True
    assert out.value == {"promised": True, "reason": "ok"}
    assert len(port.usage_records) == 1
    assert port.usage_records[0].caller == "sidecall:promised_action"
    assert port.usage_records[0].prompt_tokens == 120

    assert port.last_dispatched_messages is not None
    sent_body = port.last_dispatched_messages[1]["content"]
    assert secret not in sent_body
    assert "sk-abcdef1234567890abcdef" not in sent_body
    assert "supersecretjwt9876543210" not in sent_body
    assert len(sent_body) <= DEFAULT_HEAD_CHARS + DEFAULT_TAIL_CHARS + 80


@pytest.mark.asyncio
async def test_sidecall_cancel_linkage_and_timeout_degradation() -> None:
    """T-SC-02 & T-SC-03: Aborting main turn cancels sidecall in <50ms; timeout/500 degrades silently."""
    cancel_ev = asyncio.Event()

    async def hanging_completer(_messages: list[dict[str, str]]) -> tuple[str, tuple[int, int]]:
        await asyncio.sleep(10.0)
        return "{}", (0, 0)

    port = SideCallPort(hanging_completer, cancel_event=cancel_ev)
    spec = SideCallSpec(
        caller="before_completion",
        system_prompt="guard",
        timeout_s=5.0,
        fallback_value={"allow": True},
    )

    async def trigger_cancel() -> None:
        await asyncio.sleep(0.01)
        cancel_ev.set()

    started = time.perf_counter()
    asyncio.create_task(trigger_cancel())
    cancelled = await port.invoke(spec, user_input="hi", assistant_output="reply")
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    assert cancelled.status == "cancelled"
    assert elapsed_ms < 120.0
    assert cancelled.value == {"allow": True}

    # Timeout fallback
    timeout_port = SideCallPort(hanging_completer)
    short_spec = SideCallSpec(
        caller="before_completion",
        system_prompt="guard",
        timeout_s=0.03,
        fallback_value={"allow": True},
    )
    timed_out = await timeout_port.invoke(short_spec, user_input="u", assistant_output="a")
    assert timed_out.status == "timeout"
    assert timed_out.value == {"allow": True}

    # Upstream HTTP 500 error fallback
    async def failing_completer(_messages: list[dict[str, str]]) -> tuple[str, tuple[int, int]]:
        raise RuntimeError("HTTP 500 Internal Server Error")

    err_port = SideCallPort(failing_completer)
    degraded = await err_port.invoke(short_spec, user_input="u", assistant_output="a")
    assert degraded.status == "error"
    assert degraded.value == {"allow": True}


@pytest.mark.asyncio
async def test_promised_action_single_shot_nudge_never_loops() -> None:
    """T-SC-04: PromisedActionContinuationHooks triggers at most 1 retry per user turn."""
    calls = 0

    async def yes_completer(_messages: list[dict[str, str]]) -> tuple[str, tuple[int, int]]:
        nonlocal calls
        calls += 1
        return '{"promised": true, "reason": "promised tool"}', (40, 8)

    port = SideCallPort(yes_completer)
    hooks = PromisedActionContinuationHooks(
        port=port,
        user_question="请核对本月台账",
        tools_available=True,
    )

    draft = CompletionDraft(
        status="completed",
        reason="stop",
        content="好的，我现在调用接口核对台账。",
        round_index=0,
        had_tool_calls=False,
        tool_calls_used=0,
        tool_successes=0,
    )
    await hooks.pre_step([LLMMessage(role="user", content="请核对本月台账")], LoopContext())
    ctx = LoopContext(round_index=0, tool_calls_used=0)

    first = await hooks.before_completion(draft, ctx)
    assert first.kind == "retry"
    assert first.reason == "promised_action_nudge"
    assert calls == 1

    # Round 2: model still emits no tool_call -> MUST accept without calling SideCallPort again!
    second = await hooks.before_completion(draft, ctx)
    assert second.kind == "accept"
    assert calls == 1
