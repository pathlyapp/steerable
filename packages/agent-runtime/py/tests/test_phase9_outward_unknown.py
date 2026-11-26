"""Phase 9 S2 tests: Sealed RejectedBeforeEffect, outward checkpoint, outcome_unknown lock & policyDigest."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime.approval import (
    TOOL_MODES,
    ApprovalDecision,
    ApprovalExecutor,
    ApprovalRequest,
    AutoApprover,
    JsonApprovalStore,
    RejectedBeforeEffectError,
    SessionApprovalCache,
    compute_policy_digest,
)
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk, LLMUsage
from steerable_agent_runtime.loop import CoreLoop, LoopConfig, LoopContext, RouterToolExecutor
from steerable_agent_runtime.tools import ToolRouter


class _ScriptedApprover:
    def __init__(self, decision: ApprovalDecision) -> None:
        self.decision = decision
        self.calls: list[ApprovalRequest] = []

    async def approve(self, request: ApprovalRequest) -> ApprovalDecision:
        self.calls.append(request)
        return self.decision


class _TwoStepProvider:
    name = "fake"
    model = "fake-model"

    def __init__(self, calls_per_round: list[list[ToolCall]]) -> None:
        self._rounds = list(calls_per_round)
        self.seen_messages: list[list[Any]] = []

    async def complete(self, messages: Any, **kwargs: Any) -> tuple[LLMMessage, LLMUsage]:
        self.seen_messages.append(list(messages))
        if self._rounds:
            next_calls = self._rounds.pop(0)
            return LLMMessage.text_of("assistant", "", tool_calls=next_calls), LLMUsage()
        return LLMMessage.text_of("assistant", "Done."), LLMUsage()

    async def stream(self, messages: Any, **kwargs: Any):
        msg, usage = await self.complete(messages, **kwargs)
        if msg.content_text:
            yield LLMStreamChunk(content_delta=msg.content_text)
        for tc in msg.tool_calls or []:
            yield LLMStreamChunk(tool_call_delta=tc)
        yield LLMStreamChunk(finish_reason="stop", usage=usage)


@pytest.mark.asyncio
async def test_t_out_02_sealed_rejected_before_effect_vs_handler_exceptions() -> None:
    """T-OUT-02: Handlers cannot forge RejectedBeforeEffectError or effect='none'; pre-dispatch schema/deny settles as effect='none'."""
    with pytest.raises(TypeError, match="sealed"):
        RejectedBeforeEffectError("forged", "forged")

    router = ToolRouter()

    async def flaky_submit(batch_id: str) -> dict[str, Any]:
        if batch_id == "try-forge-none":
            return {"success": False, "error": "fake pre-dispatch", "effect": "none"}
        raise RuntimeError("socket reset after sending HTTP POST")

    router.register(
        flaky_submit,
        name="flaky_submit",
        mode="external",
        idempotent=False,
        schema={
            "type": "object",
            "required": ["batch_id"],
            "properties": {"batch_id": {"type": "string"}},
        },
    )

    session = SessionApprovalCache()
    exec_layer = ApprovalExecutor(
        RouterToolExecutor(router),
        _ScriptedApprover(ApprovalDecision("allow_once")),
        session=session,
    )
    ctx = LoopContext(chat_id="s-1", round_index=0)

    # 1. Schema validation failure BEFORE handler -> effect='none', NO lock
    bad_schema = await exec_layer.execute(
        ToolCall(id="c1", name="flaky_submit", arguments={}),
        ctx,
    )
    assert bad_schema.success is False
    assert bad_schema.effect == "none"
    assert bad_schema.outcomeUnknown is not True
    assert session.get_pending_reconciliation("flaky_submit") is None

    # 2. Local handler returning effect='none' after running is stripped and settled as outcome_unknown!
    forged = await exec_layer.execute(
        ToolCall(id="c2", name="flaky_submit", arguments={"batch_id": "try-forge-none"}),
        ctx,
    )
    assert forged.success is False
    assert forged.effect == "unknown"
    assert forged.outcomeUnknown is True
    assert forged.retryable is False
    assert forged.reconciliationId is not None
    assert session.get_pending_reconciliation("flaky_submit") == forged.reconciliationId

    # Clear lock and verify unhandled handler exception also settles as outcome_unknown
    session.clear_reconciliation("flaky_submit")
    crashed = await exec_layer.execute(
        ToolCall(id="c3", name="flaky_submit", arguments={"batch_id": "B-9"}),
        ctx,
    )
    assert crashed.effect == "unknown"
    assert crashed.outcomeUnknown is True
    assert crashed.reconciliationId is not None


@pytest.mark.asyncio
async def test_t_out_03_outward_bypasses_auto_and_cached_approvals(tmp_path: Path) -> None:
    """T-OUT-03: checkpoint='outward' never reuses allow_always/allow_for_session and is denied under unattended AutoApprover."""
    router = ToolRouter()
    invocations = 0

    async def publish_notice(title: str) -> dict[str, Any]:
        nonlocal invocations
        invocations += 1
        return {"published": title}

    router.register(
        publish_notice,
        name="publish_notice",
        mode="external",
        idempotent=False,
        checkpoint="outward",
        schema={"type": "object", "properties": {"title": {"type": "string"}}},
    )

    # 1. AutoApprover(allow_modes=TOOL_MODES) refuses outward tools with outward_confirmation_required
    unattended = ApprovalExecutor(
        RouterToolExecutor(router),
        AutoApprover(allow_modes=TOOL_MODES),
        session=SessionApprovalCache(),
    )
    denied = await unattended.execute(
        ToolCall(id="c1", name="publish_notice", arguments={"title": "Notice A"}),
        LoopContext(chat_id="s-auto", round_index=0),
    )
    assert denied.success is False
    assert denied.effect == "none"
    assert denied.error == "outward_confirmation_required"
    assert invocations == 0

    # 2. Even if an approver returns 'allow_always', outward downgrades to single-shot and prompts again next call!
    store = JsonApprovalStore(tmp_path / "approvals.json", policy_digest="deadbeef" * 4)
    session = SessionApprovalCache()
    approver = _ScriptedApprover(ApprovalDecision("allow_always"))
    interactive = ApprovalExecutor(
        RouterToolExecutor(router),
        approver,
        session=session,
        store=store,
    )

    r1 = await interactive.execute(
        ToolCall(id="c2", name="publish_notice", arguments={"title": "Notice 1"}),
        LoopContext(chat_id="s-int", round_index=0),
    )
    r2 = await interactive.execute(
        ToolCall(id="c3", name="publish_notice", arguments={"title": "Notice 2"}),
        LoopContext(chat_id="s-int", round_index=1),
    )
    assert r1.success is True
    assert r1.effect == "committed"
    assert r2.success is True
    assert len(approver.calls) == 2
    assert session.get("publish_notice") is None
    assert store.load() == {}


@pytest.mark.asyncio
async def test_t_out_04_coreloop_tool_timeout_marks_outcome_unknown_and_blocks_retry() -> None:
    """T-OUT-04: CoreLoop per-tool timeout on idempotent=False settles as outcomeUnknown=True and blocks same-session retry."""
    router = ToolRouter()
    started_count = 0

    async def slow_replay(card_id: str) -> dict[str, Any]:
        nonlocal started_count
        started_count += 1
        await asyncio.sleep(5.0)
        return {"card": card_id}

    router.register(
        slow_replay,
        name="cf_replay",
        mode="external",
        idempotent=False,
        schema={"type": "object", "properties": {"card_id": {"type": "string"}}},
    )

    session = SessionApprovalCache()
    executor = ApprovalExecutor(
        RouterToolExecutor(router),
        _ScriptedApprover(ApprovalDecision("allow_once")),
        session=session,
    )
    provider = _TwoStepProvider(
        [
            [ToolCall(id="tc-1", name="cf_replay", arguments={"card_id": "card-1"})],
            [ToolCall(id="tc-2", name="cf_replay", arguments={"card_id": "card-1"})],
        ]
    )
    loop = CoreLoop(
        provider=provider,
        executor=executor,
        config=LoopConfig(tool_timeout_ms=60, tool_dedup=False),
    )

    events = [
        ev
        async for ev in loop.run(
            [LLMMessage.text_of("user", "Run replay")],
            tools=router.describe_model(),
            chat_id="s-timeout",
        )
    ]
    result_events = [e for e in events if e.kind == "tool_call_result"]
    assert len(result_events) == 2

    # Round 1 timed out -> outcomeUnknown=True, started_count == 1
    first_data = result_events[0].data
    assert started_count == 1
    rec_id = session.get_pending_reconciliation("cf_replay")
    assert rec_id is not None
    assert "outcome_unknown" in str(first_data.get("error", ""))

    # Round 2 model attempted retry -> blocked BEFORE handler (started_count stays 1!)
    second_data = result_events[1].data
    assert started_count == 1
    assert second_data.get("error") == "reconciliation_required"

    # Syncing empty pendingReconciliations from host after confirmed_not_executed unlocks
    session.sync_pending_reconciliations({})
    assert session.get_pending_reconciliation("cf_replay") is None


def test_t_out_09_policy_digest_partitions_json_approval_store(tmp_path: Path) -> None:
    """T-OUT-09: JsonApprovalStore partitions allow_always by policy_digest."""
    d1 = compute_policy_digest(
        approval_mode="host",
        sandbox_enforced=True,
        writable_roots=["/workspace/a"],
        allowed_hosts=["api.internal"],
        model="m1",
    )
    d2 = compute_policy_digest(
        approval_mode="host",
        sandbox_enforced=True,
        writable_roots=["/workspace/a"],
        allowed_hosts=["api.internal"],
        model="m2",
    )
    d3 = compute_policy_digest(
        approval_mode="host",
        sandbox_enforced=False,
        writable_roots=["/workspace/a"],
        allowed_hosts=["api.internal"],
    )
    assert d1 == d2
    assert d1 != d3

    path = tmp_path / "durable.json"
    s1 = JsonApprovalStore(path, policy_digest=d1)
    s1.put("shell", "allow_always")
    assert JsonApprovalStore(path, policy_digest=d2).load() == {"shell": "allow_always"}
    assert JsonApprovalStore(path, policy_digest=d3).load() == {}
