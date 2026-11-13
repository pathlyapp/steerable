"""ChildRegistry: composed status and resumability.

The registry is the only place that decides what a child "is" right now, so
these tests pin the composition table rather than any storage detail:

- a terminal row reports its own status;
- a non-terminal row with a live handle reports ``running``;
- a non-terminal row with no handle reports ``interrupted`` (the parent turn
  ended or the process died) and stays resumable;
- ``closed`` is terminal, never live, never resumable.
"""

from __future__ import annotations

import pytest
from steerable_agent_runtime.child_record import ChildRecord
from steerable_agent_runtime.llm import LLMUsage
from steerable_agent_runtime.registry import (
    ChildRegistry,
    SpawnedChild,
    default_record_id,
    registry_status,
)
from steerable_agent_runtime.storage import InMemoryStorage


def _storage() -> InMemoryStorage:
    return InMemoryStorage()


def _spawn(parent: str = "chat/p", child: str = "0.1") -> SpawnedChild:
    return SpawnedChild(
        parent_record_id=parent,
        child_id=child,
        depth=1,
        profile="explore",
        engine="coreloop",
    )


def test_record_id_has_one_spelling() -> None:
    assert default_record_id("chat/p", "0.2") == "chat/p:child:0.2"


def test_completion_statuses_map_onto_registry_vocabulary() -> None:
    """The loop says ``failed``; storage says ``error``. One spelling wins."""
    assert registry_status("completed") == "completed"
    assert registry_status("failed") == "error"
    assert registry_status("cancelled") == "cancelled"
    assert registry_status("budget_exhausted") == "budget_exhausted"
    assert registry_status("closed") == "closed"
    # Idempotent on the registry's own spelling.
    assert registry_status("error") == "error"


def test_an_unknown_completion_status_is_refused() -> None:
    """Writing a row nobody can interpret is worse than a loud failure."""
    with pytest.raises(ValueError, match="unknown child completion status"):
        registry_status("interrupted")


@pytest.mark.asyncio
async def test_spawn_writes_a_non_terminal_row() -> None:
    store = _storage()
    registry = ChildRegistry(store)

    record_id = await registry.spawned(_spawn())

    assert record_id == "chat/p:child:0.1"
    stored = await store.get_child(record_id)
    assert stored is not None
    assert stored.status == "pending"
    assert stored.status not in {"completed", "error", "closed"}
    assert stored.depth == 1
    assert stored.profile == "explore"
    assert stored.engine == "coreloop"
    # ``running`` is never persisted.
    assert stored.status != "running"


@pytest.mark.asyncio
async def test_new_child_without_a_handle_reports_interrupted() -> None:
    """The app was closed between spawn and completion."""
    registry = ChildRegistry(_storage())
    await registry.spawned(_spawn())

    view = await registry.get("chat/p:child:0.1")

    assert view is not None
    assert view.status == "interrupted"
    assert view.live is False
    assert view.resumable is True
    assert view.to_wire()["status"] == "interrupted"


@pytest.mark.asyncio
async def test_a_live_handle_reports_running() -> None:
    registry = ChildRegistry(_storage())
    await registry.spawned(_spawn())
    running = True
    registry.mark_live("chat/p:child:0.1", lambda: running)

    view = await registry.get("chat/p:child:0.1")
    assert view is not None
    assert view.status == "running"
    assert view.live is True
    # A running child is not resumable — it is already going.
    assert view.resumable is False

    running = False
    view = await registry.get("chat/p:child:0.1")
    assert view is not None
    assert view.status == "interrupted"


@pytest.mark.asyncio
async def test_terminal_rows_report_their_own_status() -> None:
    registry = ChildRegistry(_storage())
    record_id = await registry.spawned(_spawn())
    registry.mark_live(record_id, lambda: True)

    wrote = await registry.finished(
        record_id,
        status="completed",
        usage=LLMUsage(prompt_tokens=120, completion_tokens=30, total_tokens=150),
    )
    registry.mark_settled(record_id)

    assert wrote is True
    view = await registry.get(record_id)
    assert view is not None
    assert view.status == "completed"
    assert view.live is False
    # A finished child accepts a follow-up turn.
    assert view.resumable is True
    assert view.record.prompt_tokens == 120
    assert view.record.completion_tokens == 30


@pytest.mark.asyncio
async def test_closed_is_terminal_and_never_resumable() -> None:
    registry = ChildRegistry(_storage())
    record_id = await registry.spawned(_spawn())

    await registry.finished(record_id, status="closed")

    view = await registry.get(record_id)
    assert view is not None
    assert view.status == "closed"
    assert view.resumable is False


@pytest.mark.asyncio
async def test_budget_exhausted_stays_resumable() -> None:
    registry = ChildRegistry(_storage())
    record_id = await registry.spawned(_spawn())

    await registry.finished(
        record_id,
        status="budget_exhausted",
        usage=LLMUsage(prompt_tokens=10, completion_tokens=2, total_tokens=12),
    )

    view = await registry.get(record_id)
    assert view is not None
    assert view.status == "budget_exhausted"
    assert view.resumable is True


@pytest.mark.asyncio
async def test_external_engine_child_reports_unknown_usage() -> None:
    registry = ChildRegistry(_storage())
    record_id = await registry.spawned(
        SpawnedChild(
            parent_record_id="chat/p",
            child_id="0.2",
            depth=1,
            profile="codex-exec",
            engine="acp",
        )
    )

    await registry.finished(record_id, status="completed", usage=None, usage_known=False)

    view = await registry.get(record_id)
    assert view is not None
    assert view.record.engine == "acp"
    assert view.record.usage_known is False
    assert view.record.prompt_tokens is None


@pytest.mark.asyncio
async def test_finishing_an_unknown_child_reports_false() -> None:
    registry = ChildRegistry(_storage())
    assert await registry.finished("chat/p:child:9.9", status="completed") is False


@pytest.mark.asyncio
async def test_list_for_parent_scopes_and_excludes_finished() -> None:
    registry = ChildRegistry(_storage())
    await registry.spawned(_spawn(child="0.2"))
    await registry.spawned(_spawn(child="0.1"))
    await registry.spawned(_spawn(parent="chat/q", child="0.1"))
    await registry.finished("chat/p:child:0.1", status="completed")

    # Spawn order, not lineage order: 0.2 was spawned first.
    children = await registry.list_for_parent("chat/p")
    assert [v.record.child_id for v in children] == ["0.2", "0.1"]

    unfinished = await registry.list_for_parent("chat/p", include_finished=False)
    # 0.2 never finished and has no handle → interrupted, which is unfinished.
    assert [v.record.child_id for v in unfinished] == ["0.2"]

    everything = await registry.list_all()
    assert len(everything) == 3
    prefixed = await registry.list_all(prefix="chat/p")
    assert [v.record.child_id for v in prefixed] == ["0.2", "0.1"]


@pytest.mark.asyncio
async def test_respawning_keeps_the_original_spawn_position() -> None:
    """A resumed child must not jump to the end of the panel."""
    store = _storage()
    registry = ChildRegistry(store)
    await registry.spawned(_spawn(child="0.1"))
    await registry.spawned(_spawn(child="0.2"))
    await registry.finished("chat/p:child:0.1", status="budget_exhausted")
    original = await store.get_child("chat/p:child:0.1")
    assert original is not None

    # Resume: the child is registered again with the same lineage id.
    await registry.spawned(_spawn(child="0.1"))

    respawned = await store.get_child("chat/p:child:0.1")
    assert respawned is not None
    assert respawned.created_at == original.created_at
    children = await registry.list_for_parent("chat/p")
    assert [v.record.child_id for v in children] == ["0.1", "0.2"]


@pytest.mark.asyncio
async def test_find_child_resolves_lineage_id() -> None:
    registry = ChildRegistry(_storage())
    await registry.spawned(_spawn(child="0.1"))
    await registry.spawned(_spawn(child="0.2"))

    found = await registry.find_child("chat/p", "0.2")
    assert found is not None
    assert found.record.record_id == "chat/p:child:0.2"

    assert await registry.find_child("chat/p", "0.9") is None
    # Same lineage id under another parent is a different child.
    assert await registry.find_child("chat/q", "0.2") is None


@pytest.mark.asyncio
async def test_a_storeless_registry_is_inert() -> None:
    """Hosts without a storage adapter keep working; nothing is recorded."""
    registry = ChildRegistry(None)

    record_id = await registry.spawned(_spawn())
    assert record_id == "chat/p:child:0.1"
    assert await registry.get(record_id) is None
    assert await registry.list_for_parent("chat/p") == []
    assert await registry.finished(record_id, status="completed") is False


@pytest.mark.asyncio
async def test_to_wire_carries_answer_preview_only_when_given() -> None:
    registry = ChildRegistry(_storage())
    record_id = await registry.spawned(_spawn())
    await registry.finished(record_id, status="completed")

    view = await registry.get(record_id)
    assert view is not None
    assert "answerPreview" not in view.to_wire()
    assert view.to_wire(answer_preview="version 1.0.8")["answerPreview"] == "version 1.0.8"


@pytest.mark.asyncio
async def test_wire_payload_matches_record_fields() -> None:
    registry = ChildRegistry(_storage())
    record_id = await registry.spawned(_spawn())

    view = await registry.get(record_id)
    assert view is not None
    wire = view.to_wire()
    assert wire["recordId"] == record_id
    assert wire["parentRecordId"] == "chat/p"
    assert wire["childId"] == "0.1"
    assert wire["depth"] == 1
    assert wire["profile"] == "explore"
    assert wire["engine"] == "coreloop"
    assert wire["live"] is False


@pytest.mark.asyncio
async def test_upsert_of_the_same_child_does_not_duplicate() -> None:
    """A retried spawn must not create a second row for one lineage id."""
    registry = ChildRegistry(_storage())
    first = await registry.spawned(_spawn())
    second = await registry.spawned(_spawn())

    assert first == second
    assert len(await registry.list_all()) == 1


def test_child_record_is_frozen() -> None:
    """Rows are values: mutating one in place would silently desync the store."""
    record = ChildRecord(
        record_id="r",
        parent_record_id="p",
        child_id="0.1",
        depth=1,
        profile=None,
        engine="coreloop",
        status="pending",
        resumable=False,
        prompt_tokens=None,
        completion_tokens=None,
        usage_known=True,
        created_at="2026-11-12T00:00:00+00:00",
        updated_at="2026-11-12T00:00:00+00:00",
    )
    with pytest.raises(Exception):
        record.status = "completed"  # type: ignore[misc]
