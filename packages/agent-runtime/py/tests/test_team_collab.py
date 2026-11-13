"""Peer messaging and the shared board, driven through the orchestration layer.

The unit tests cover the tree and the board in isolation. This one covers the
wiring that makes them reachable from a model: ``agent_send`` addressing a
member the pool does not own, and the four board tools answering through
``OrchestrationExecutor``.

Both are exercised through the tool surface because that is where the
authorization question actually lives — a child can only reach what the tree
registered, and the board tools only exist when a host wired one.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import CoreLoop, LoopConfig, RouterToolExecutor, ToolRouter
from steerable_agent_runtime.llm import LLMStreamChunk
from steerable_agent_runtime.orchestration import (
    OrchestrationConfig,
    OrchestrationExecutor,
)
from steerable_agent_runtime.team_board import TeamTaskBoard
from steerable_agent_runtime.tree import AgentTree


class _PhraseProvider:
    """Answers by phrase so a child's task can select its reply."""

    name = "fake"
    model = "fake-model"

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        joined = "\n".join(m.content_text for m in messages)

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            for phrase, answer in _ROUTES.items():
                if phrase in joined:
                    yield LLMStreamChunk(content_delta=answer)
                    return
            yield LLMStreamChunk(content_delta="no route")

        return _gen()


_ROUTES = {
    "first child": "first done",
    "second child": "second done",
}


def _executor(
    *,
    tree: AgentTree | None = None,
    board: TeamTaskBoard | None = None,
    max_depth: int = 2,
) -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _PhraseProvider(),
        OrchestrationConfig(max_depth=max_depth),
        tree=tree,
        team_board=board,
    )


async def _call(
    executor: OrchestrationExecutor,
    name: str,
    arguments: dict[str, Any],
    call_id: str = "c1",
) -> dict[str, Any]:
    result = await executor.execute(
        ToolCall(id=call_id, name=name, arguments=arguments), None  # type: ignore[arg-type]
    )
    assert result.success is True, result.error
    return json.loads(result.message or "{}")


@pytest.mark.asyncio
async def test_a_sibling_can_message_a_sibling() -> None:
    """Two children of one parent reach each other without asking the parent.

    This is the collaboration shape the slice exists for: the fact travels
    directly instead of the parent copying it between task prompts.
    """
    tree = AgentTree()
    executor = _executor(tree=tree, max_depth=2)

    await _call(executor, "agent_spawn", {"task": "first child"}, "s1")
    await _call(executor, "agent_spawn", {"task": "second child"}, "s2")
    await executor.pool.wait("0.1", 5)
    await executor.pool.wait("0.2", 5)

    # 0.1's own executor is the nested one built for it; it addresses 0.2 by
    # lineage id and the tree routes the delivery to 0.2's owner.
    nested = executor._tree.get("0.1")
    assert nested is not None
    sent = await tree.send("0.1", "0.2", "the parser lives in lex.py")
    await executor.shutdown()

    assert sent in ("steered", "resumed"), sent


@pytest.mark.asyncio
async def test_the_tree_lists_every_spawned_member() -> None:
    tree = AgentTree()
    executor = _executor(tree=tree, max_depth=2)

    await _call(executor, "agent_spawn", {"task": "first child"}, "s1")
    await _call(executor, "agent_spawn", {"task": "second child"}, "s2")
    await executor.pool.wait("0.1", 5)
    await executor.pool.wait("0.2", 5)

    lineages = [member.lineage for member in tree.members()]
    await executor.shutdown()

    assert lineages == ["0.1", "0.2"]


@pytest.mark.asyncio
async def test_a_closed_child_leaves_the_tree() -> None:
    tree = AgentTree()
    executor = _executor(tree=tree, max_depth=2)

    await _call(executor, "agent_spawn", {"task": "first child"}, "s1")
    await executor.pool.wait("0.1", 5)
    await _call(executor, "agent_close", {"childId": "0.1"}, "c1")

    assert tree.get("0.1") is None
    await executor.shutdown()


@pytest.mark.asyncio
async def test_the_board_tools_are_absent_without_a_board() -> None:
    """A host that did not opt in never has the tools advertised."""
    executor = _executor()
    result = await executor.execute(
        ToolCall(id="t1", name="team_task_create", arguments={"title": "x"}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False


@pytest.mark.asyncio
async def test_the_board_round_trips_through_the_tools() -> None:
    board = TeamTaskBoard()
    executor = _executor(board=board)

    created = await _call(
        executor, "team_task_create", {"title": "refactor auth", "detail": "auth.py"}, "t1"
    )
    listed = await _call(executor, "team_task_list", {}, "t2")
    claimed = await _call(executor, "team_task_claim", {"taskId": created["id"]}, "t3")
    completed = await _call(
        executor, "team_task_complete", {"taskId": created["id"], "note": "done"}, "t4"
    )
    await executor.shutdown()

    assert created["status"] == "todo"
    assert [task["id"] for task in listed["tasks"]] == [created["id"]]
    assert listed["summary"] == {"todo": 1, "claimed": 0, "done": 0}
    assert claimed["status"] == "claimed"
    assert completed["status"] == "done"


@pytest.mark.asyncio
async def test_claiming_without_an_id_takes_the_first_ready_item() -> None:
    board = TeamTaskBoard()
    executor = _executor(board=board)

    await _call(executor, "team_task_create", {"title": "first"}, "t1")
    await _call(executor, "team_task_create", {"title": "second"}, "t2")
    claimed = await _call(executor, "team_task_claim", {}, "t3")
    await executor.shutdown()

    assert claimed["title"] == "first"


@pytest.mark.asyncio
async def test_a_refused_claim_says_what_is_claimable() -> None:
    """The refusal has to be actionable: the model's next step depends on it."""
    board = TeamTaskBoard()
    executor = _executor(board=board)

    created = await _call(executor, "team_task_create", {"title": "only"}, "t1")
    await _call(executor, "team_task_claim", {"taskId": created["id"]}, "t2")
    result = await executor.execute(
        ToolCall(id="t3", name="team_task_claim", arguments={}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "no_ready_task" in (result.error or "")
    assert "claimed" in (result.error or "")


@pytest.mark.asyncio
async def test_creating_with_a_missing_dependency_is_refused() -> None:
    board = TeamTaskBoard()
    executor = _executor(board=board)

    result = await executor.execute(
        ToolCall(
            id="t1",
            name="team_task_create",
            arguments={"title": "late", "dependsOn": ["t9"]},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "unknown dependency" in (result.error or "")


@pytest.mark.asyncio
async def test_a_child_sees_the_board_tools_when_a_board_is_wired() -> None:
    """Workers must be able to claim; the tools follow the board, not the depth.

    The tools are advertised independently of the orchestration family: a
    child that cannot spawn anyone still needs to see the plan and claim from
    it, which is the whole reason the board is not part of that family.
    """
    board = TeamTaskBoard()
    executor = _executor(board=board, max_depth=1)

    _loop, schemas = executor._child_loop("0.1", None, depth=1)
    names = {schema["function"]["name"] for schema in (schemas or [])}
    await executor.shutdown()

    assert {
        "team_task_create",
        "team_task_claim",
        "team_task_complete",
        "team_task_list",
    } <= names


@pytest.mark.asyncio
async def test_a_child_without_a_board_sees_none_of_the_board_tools() -> None:
    executor = _executor(max_depth=2)

    _loop, schemas = executor._child_loop("0.1", None, depth=1)
    names = {schema["function"]["name"] for schema in (schemas or [])}
    await executor.shutdown()

    assert not any(name.startswith("team_task_") for name in names)


@pytest.mark.asyncio
async def test_a_leaf_child_is_offered_send_and_list_but_not_spawn() -> None:
    """Depth bounds delegation, not conversation.

    A depth-1 worker in a ``max_depth=1`` tree cannot spawn — but the whole
    point of peer messaging is that it can hand a finding to a sibling. The
    leaf layer is what keeps those two permissions apart.
    """
    tree = AgentTree()
    executor = _executor(tree=tree, max_depth=1)

    _loop, schemas = executor._child_loop("0.1", None, depth=1)
    names = {schema["function"]["name"] for schema in (schemas or [])}
    await executor.shutdown()

    assert {"agent_send", "agent_list"} <= names
    assert "agent_spawn" not in names


@pytest.mark.asyncio
async def test_a_leaf_child_reaches_a_sibling_through_its_own_tools() -> None:
    """The same delivery, driven the way the model drives it."""
    tree = AgentTree()
    executor = _executor(tree=tree, max_depth=2)
    await _call(executor, "agent_spawn", {"task": "first child"}, "s1")
    await _call(executor, "agent_spawn", {"task": "second child"}, "s2")
    await executor.pool.wait("0.1", 5)
    await executor.pool.wait("0.2", 5)
    # A leaf executor: max_depth=1 makes 0.1 a leaf, so its send can only come
    # from the peer layer.
    leaf_executor = _executor(tree=tree, max_depth=1)
    leaf_loop, _schemas = leaf_executor._child_loop("0.9", None, depth=1)

    result = await leaf_loop._executor.execute(  # type: ignore[attr-defined]
        ToolCall(
            id="p1",
            name="agent_send",
            arguments={"childId": "0.2", "message": "parser is in lex.py"},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()
    await leaf_executor.shutdown()

    assert result.success is True, result.error
    assert json.loads(result.message or "{}")["childId"] == "0.2"


@pytest.mark.asyncio
async def test_a_leaf_listing_members_names_who_it_can_message() -> None:
    tree = AgentTree()
    executor = _executor(tree=tree, max_depth=2)
    await _call(executor, "agent_spawn", {"task": "first child"}, "s1")
    await executor.pool.wait("0.1", 5)
    leaf_executor = _executor(tree=tree, max_depth=1)
    leaf_loop, _schemas = leaf_executor._child_loop("0.9", None, depth=1)

    result = await leaf_loop._executor.execute(  # type: ignore[attr-defined]
        ToolCall(id="p2", name="agent_list", arguments={}),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()
    await leaf_executor.shutdown()

    payload = json.loads(result.message or "{}")
    assert [member["childId"] for member in payload["members"]] == ["0.1"]
    assert payload["self"] == "0.9"
    assert payload["children"] == []


@pytest.mark.asyncio
async def test_a_leaf_unknown_target_is_refused_with_the_members_it_has() -> None:
    tree = AgentTree()
    executor = _executor(tree=tree, max_depth=2)
    await _call(executor, "agent_spawn", {"task": "first child"}, "s1")
    await executor.pool.wait("0.1", 5)
    leaf_executor = _executor(tree=tree, max_depth=1)
    leaf_loop, _schemas = leaf_executor._child_loop("0.9", None, depth=1)

    result = await leaf_loop._executor.execute(  # type: ignore[attr-defined]
        ToolCall(
            id="p3",
            name="agent_send",
            arguments={"childId": "0.7", "message": "hello"},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()
    await leaf_executor.shutdown()

    assert result.success is False
    assert "0.1" in (result.error or "")


@pytest.mark.asyncio
async def test_a_delegated_child_is_a_peer_too() -> None:
    """Both multi-agent surfaces put their children in one job.

    A ``delegate_subagent`` child and an ``agent_spawn`` child can be peers of
    each other, so the delegated one gets the same two messaging tools. It
    reads the tree from the shared pool, which is why ``attach_pool`` matters
    here: the pool *is* the membership.
    """
    from steerable_agent_runtime import SubagentConfig, SubagentExecutor
    from steerable_agent_runtime.subagent import subagent_tool_descriptor

    tree = AgentTree()
    provider = _PhraseProvider()
    subagent = SubagentExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        SubagentConfig(),
        tools=[subagent_tool_descriptor()],
    )
    orchestration = _executor(tree=tree, max_depth=1)
    subagent.attach_pool(orchestration.pool)

    loop, schemas = subagent._loop_factory_for(subagent._config)(  # type: ignore[attr-defined]
        "0.1", None
    )
    names = {schema["function"]["name"] for schema in (schemas or [])}
    await orchestration.shutdown()
    assert loop is not None

    assert {"agent_send", "agent_list"} <= names
    assert "agent_spawn" not in names
