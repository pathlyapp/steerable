"""Phase 10 R3 sidecar tests for authoritative agent.session.compact and
agent.session.context_status RPCs."""

from __future__ import annotations

import pytest
from steerable_agent_runtime.history import ContextManager, entry_to_dict
from steerable_agent_runtime.llm import LLMMessage
from steerable_sidecar.sidecar import Sidecar, SidecarConfig


@pytest.mark.asyncio
async def test_session_compact_and_context_status_rpc(tmp_path) -> None:
    app = Sidecar(
        config=SidecarConfig(
            storage_path=str(tmp_path / "sessions.db"),
            install_signal_handlers=False,
        )
    )
    record_id = "rec-p10-compact"
    seed = [
        LLMMessage.text_of("user", "Initial goal: migrate Postgres schema"),
        LLMMessage.text_of("assistant", "Step 1 done " + ("detail " * 80)),
        LLMMessage.text_of("user", "Run migration v2"),
        LLMMessage.text_of("assistant", "Step 2 done " + ("detail " * 80)),
        LLMMessage.text_of("user", "Check table users on port 5432"),
        LLMMessage.text_of("assistant", "Step 3 done " + ("detail " * 80)),
        LLMMessage.text_of("user", "Verify indexes"),
        LLMMessage.text_of("assistant", "Indexes verified"),
    ]
    mgr = ContextManager(seed, first_seq=0)
    await app.storage.append_history(
        record_id, [entry_to_dict(e) for e in mgr.drain_pending()]
    )

    status_before = await app._handle_session_context_status({"recordId": record_id})
    assert status_before["recordExists"] is True
    assert status_before["messageCount"] == 8
    assert status_before["estimatedTokens"] > 100
    assert status_before["compactionCount"] == 0

    compacted = await app._handle_session_compact(
        {
            "recordId": record_id,
            "focus": "preserve port 5432 and users table",
            "keepHeadTurns": 1,
            "keepTailMessages": 2,
        }
    )
    assert compacted["recordExists"] is True
    assert compacted["compacted"] > 0
    assert compacted["postTokens"] < compacted["preTokens"]
    # Head + summary + 2 tail messages = 4 messages
    assert len(compacted["messages"]) == 4
    assert "Initial goal" in compacted["messages"][0]["content"]
    assert "[context compacted:" in compacted["messages"][1]["content"]
    assert compacted["messages"][-1]["content"] == "Indexes verified"

    status_after = await app._handle_session_context_status({"recordId": record_id})
    assert status_after["messageCount"] == 4
    assert status_after["compactionCount"] >= 1
    assert status_after["estimatedTokens"] == compacted["postTokens"]
