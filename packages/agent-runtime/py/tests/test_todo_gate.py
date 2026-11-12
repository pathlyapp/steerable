"""TodoCompletionGate: veto `completed` while the chat's todos are unfinished."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from steerable_agent_protocol.generated import ToolCall, ToolResult
from steerable_agent_runtime import TodoCompletionGate, TodoPlanningNudge, TodoStore
from steerable_agent_runtime.hooks import CompletionDraft
from steerable_agent_runtime.reminders import TodoPlanningReminder


def _draft(status: str = "completed") -> CompletionDraft:
    return CompletionDraft(
        status=status,
        reason="stop",
        content="接下来做第 14 页",
        round_index=3,
        had_tool_calls=False,
        tool_calls_used=5,
        tool_successes=5,
    )


def _ctx(chat_id: str = "c1") -> SimpleNamespace:
    # The gate reads only chat_id off the loop context.
    return SimpleNamespace(chat_id=chat_id)


def _seed(store: TodoStore, chat_id: str, statuses: list[str]) -> None:
    store.set(
        chat_id,
        [
            {"id": f"t{i}", "content": f"task {i}", "status": status}
            for i, status in enumerate(statuses)
        ],
    )


class TestTodoCompletionGate:
    @pytest.mark.asyncio
    async def test_no_list_allows_completion(self) -> None:
        gate = TodoCompletionGate(TodoStore())
        action = await gate.before_completion(_draft(), _ctx())
        assert action.kind == "accept"

    @pytest.mark.asyncio
    async def test_all_completed_allows_completion(self) -> None:
        store = TodoStore()
        _seed(store, "c1", ["completed", "completed"])
        gate = TodoCompletionGate(store)
        action = await gate.before_completion(_draft(), _ctx())
        assert action.kind == "accept"

    @pytest.mark.asyncio
    async def test_pending_items_force_retry(self) -> None:
        store = TodoStore()
        _seed(store, "c1", ["completed", "pending", "in_progress"])
        gate = TodoCompletionGate(store)
        action = await gate.before_completion(_draft(), _ctx())
        assert action.kind == "retry"
        assert action.message is not None
        assert "2 unfinished" in action.message
        assert "task 1" in action.message
        assert "task 2" in action.message
        assert "task 0" not in action.message  # completed items are not listed

    @pytest.mark.asyncio
    async def test_budget_exhausted_is_not_gated(self) -> None:
        store = TodoStore()
        _seed(store, "c1", ["pending"])
        gate = TodoCompletionGate(store)
        action = await gate.before_completion(_draft(status="budget_exhausted"), _ctx())
        assert action.kind == "accept"

    @pytest.mark.asyncio
    async def test_other_chats_do_not_gate(self) -> None:
        store = TodoStore()
        _seed(store, "other-chat", ["pending"])
        gate = TodoCompletionGate(store)
        action = await gate.before_completion(_draft(), _ctx("c1"))
        assert action.kind == "accept"

    @pytest.mark.asyncio
    async def test_long_list_is_capped_but_counted(self) -> None:
        store = TodoStore()
        _seed(store, "c1", ["pending"] * 15)
        gate = TodoCompletionGate(store)
        action = await gate.before_completion(_draft(), _ctx())
        assert action.kind == "retry"
        assert action.message is not None
        assert "15 unfinished" in action.message
        assert "task 9" in action.message
        assert "task 10" not in action.message  # listing capped at 10


async def _call(nudge: TodoPlanningNudge, name: str, ctx: SimpleNamespace) -> None:
    await nudge.post_tool_result(
        ToolResult(success=True, data={}),
        ToolCall(id=name, name=name, arguments={}),
        ctx,
    )


class TestTodoPlanningNudge:
    @pytest.mark.asyncio
    async def test_fires_once_after_threshold(self) -> None:
        nudge = TodoPlanningNudge(TodoStore(), after_calls=3)
        ctx = _ctx()
        for _ in range(2):
            await _call(nudge, "local_read_file", ctx)
        assert not (await nudge.pre_step([], ctx)).appends
        await _call(nudge, "local_exec_shell", ctx)
        action = await nudge.pre_step([], ctx)
        assert action.appends is not None
        assert action.append_action == "reminder"
        fragment = action.appends[0].fragment
        assert isinstance(fragment, TodoPlanningReminder)
        assert "3 tool calls into this turn" in fragment.render()
        assert fragment.matches_text(fragment.render())
        await _call(nudge, "local_exec_shell", ctx)
        assert not (await nudge.pre_step([], ctx)).appends

    @pytest.mark.asyncio
    async def test_todo_write_this_turn_silences(self) -> None:
        nudge = TodoPlanningNudge(TodoStore(), after_calls=2)
        ctx = _ctx()
        await _call(nudge, "todo_write", ctx)
        for _ in range(5):
            await _call(nudge, "local_exec_shell", ctx)
        assert not (await nudge.pre_step([], ctx)).appends

    @pytest.mark.asyncio
    async def test_unfinished_list_carried_over_silences(self) -> None:
        store = TodoStore()
        _seed(store, "c1", ["completed", "pending"])
        nudge = TodoPlanningNudge(store, after_calls=2)
        ctx = _ctx()
        for _ in range(3):
            await _call(nudge, "local_exec_shell", ctx)
        assert not (await nudge.pre_step([], ctx)).appends

    @pytest.mark.asyncio
    async def test_finished_list_carried_over_still_nudges(self) -> None:
        store = TodoStore()
        _seed(store, "c1", ["completed", "completed"])
        nudge = TodoPlanningNudge(store, after_calls=2)
        ctx = _ctx()
        for _ in range(2):
            await _call(nudge, "local_exec_shell", ctx)
        assert (await nudge.pre_step([], ctx)).appends
