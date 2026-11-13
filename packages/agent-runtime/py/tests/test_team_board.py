"""The shared board: one plan the whole spawn tree works from.

Why a board and not a list in the prompt: the prompt is the parent's context,
and the parent's context is what a big job exhausts. Moving the plan out means
the parent writes it once and workers claim from it.

The behaviors that make that work — and that these tests pin — are that
claiming is exclusive (two workers cannot both take "auth refactor"), that
dependencies gate a claim rather than queueing it, and that a refusal says
enough for the caller to choose what to do next.
"""

from __future__ import annotations

import pytest

from steerable_agent_runtime.team_board import TeamTaskBoard


def test_creating_a_task_returns_an_unclaimed_item() -> None:
    board = TeamTaskBoard()

    item = board.create(title="refactor auth", detail="start in auth.py", created_by="0")

    assert item.id == "t1"
    assert item.status == "todo"
    assert item.owner is None
    assert item.created_by == "0"


def test_ids_are_sequential_and_stable() -> None:
    """A task id is what the parent hands out, so it must be predictable."""
    board = TeamTaskBoard()

    first = board.create(title="one")
    second = board.create(title="two")

    assert (first.id, second.id) == ("t1", "t2")
    assert board.get("t1") is first


def test_naming_a_missing_dependency_fails_at_creation() -> None:
    """The author is the only one who can fix a typo'd id, so fail there."""
    board = TeamTaskBoard()

    with pytest.raises(KeyError, match="unknown dependency"):
        board.create(title="late", depends_on=("t9",))


def test_claiming_binds_the_item_to_the_caller() -> None:
    board = TeamTaskBoard()
    board.create(title="work")

    claimed = board.claim("t1", owner="0.2")

    assert claimed.status == "claimed"
    assert claimed.owner == "0.2"
    assert board.get("t1").status == "claimed"


def test_a_second_claim_is_refused_and_names_the_owner() -> None:
    """This is the whole point of a board over a list: no duplicate work."""
    board = TeamTaskBoard()
    board.create(title="work")
    board.claim("t1", owner="0.2")

    with pytest.raises(ValueError, match="already claimed by 0.2"):
        board.claim("t1", owner="0.3")


def test_a_done_task_cannot_be_reclaimed() -> None:
    board = TeamTaskBoard()
    board.create(title="work")
    board.claim("t1", owner="0.2")
    board.complete("t1")

    with pytest.raises(ValueError, match="already done"):
        board.claim("t1", owner="0.3")


def test_a_blocked_task_cannot_be_claimed() -> None:
    """A dependency gates the claim; it does not queue one."""
    board = TeamTaskBoard()
    board.create(title="first")
    board.create(title="second", depends_on=("t1",))

    with pytest.raises(ValueError, match="blocked by t1"):
        board.claim("t2", owner="0.2")


def test_completing_a_dependency_unblocks_the_next() -> None:
    board = TeamTaskBoard()
    board.create(title="first")
    board.create(title="second", depends_on=("t1",))
    board.claim("t1", owner="0.1")

    board.complete("t1", owner="0.1", note="schema in place")
    claimed = board.claim("t2", owner="0.2")

    assert claimed.status == "claimed"
    # The note is appended to the detail so a reader sees the outcome.
    assert "schema in place" in (board.get("t1").detail or "")


def test_ready_lists_only_unblocked_unclaimed_items() -> None:
    """A worker without an id asks "what can I start", not "what exists"."""
    board = TeamTaskBoard()
    board.create(title="prerequisite")
    board.create(title="blocked", depends_on=("t1",))
    board.create(title="pending")
    board.claim("t1", owner="0.1")
    board.complete("t1", owner="0.1")

    assert [item.title for item in board.ready()] == ["blocked", "pending"]


def test_completing_someone_elses_task_is_refused() -> None:
    """Wrong-id mistakes are far more likely than intent; say whose it is."""
    board = TeamTaskBoard()
    board.create(title="work")
    board.claim("t1", owner="0.2")

    with pytest.raises(ValueError, match="claimed by 0.2, not 0.3"):
        board.complete("t1", owner="0.3")


def test_completing_an_unclaimed_task_is_refused() -> None:
    board = TeamTaskBoard()
    board.create(title="work")

    with pytest.raises(ValueError, match="not claimed"):
        board.complete("t1")


def test_completing_twice_is_idempotent() -> None:
    board = TeamTaskBoard()
    board.create(title="work")
    board.claim("t1", owner="0.2")
    board.complete("t1", owner="0.2")

    assert board.complete("t1", owner="0.2").status == "done"


def test_completing_an_unknown_task_is_refused() -> None:
    board = TeamTaskBoard()

    with pytest.raises(KeyError, match="unknown task"):
        board.complete("t9")


def test_summary_counts_every_status() -> None:
    board = TeamTaskBoard()
    board.create(title="a")
    board.create(title="b")
    board.create(title="c")
    board.claim("t1", owner="0.1")
    board.claim("t2", owner="0.2")
    board.complete("t2", owner="0.2")

    assert board.summary() == {"todo": 1, "claimed": 1, "done": 1}


def test_the_wire_shape_omits_absent_optional_fields() -> None:
    """A model reading the result should not see nulls it has to ignore."""
    board = TeamTaskBoard()
    board.create(title="plain")

    assert board.get("t1").to_wire() == {"id": "t1", "title": "plain", "status": "todo"}
