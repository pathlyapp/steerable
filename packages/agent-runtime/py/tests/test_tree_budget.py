"""One token budget for the whole turn tree.

The failure this prevents: every loop in a delegating turn keeping its own
accounting, so a parent plus three children each spend the full allowance and
no single loop ever sees the tree go over.

The rejected alternative is pinned too — handing each child a slice of the
remainder makes a serial child hit its own wall while the tree still has room,
which turns a generous budget into a tight one.
"""

from __future__ import annotations

import threading

import pytest
from steerable_agent_runtime.budget import (
    SessionBudgetExceeded,
    TreeBudget,
)
from steerable_agent_runtime.llm import LLMUsage


def _usage(total: int, *, prompt: int | None = None, completion: int | None = None) -> LLMUsage:
    return LLMUsage(
        prompt_tokens=prompt if prompt is not None else total,
        completion_tokens=completion if completion is not None else 0,
        total_tokens=total,
    )


def test_charging_accumulates_across_agents() -> None:
    budget = TreeBudget(limit=100)

    budget.charge(_usage(30), agent="parent")
    budget.charge(_usage(20), agent="0.1")
    report = budget.report()

    assert report.spent == 50
    assert report.remaining == 50
    assert report.exhausted is False


def test_attribution_is_kept_per_agent() -> None:
    """'The turn spent 40k' is not actionable; 'which child' is."""
    budget = TreeBudget(limit=1000)

    budget.charge(_usage(300), agent="0.1")
    budget.charge(_usage(100), agent="0.2")
    budget.charge(_usage(50), agent="parent")

    assert budget.report().by_agent == {"0.1": 300, "0.2": 100, "parent": 50}


def test_the_limit_is_a_tree_limit_not_a_per_child_limit() -> None:
    """Two children each under the limit must still trip a shared one."""
    budget = TreeBudget(limit=100)
    budget.charge(_usage(60), agent="0.1")

    with pytest.raises(SessionBudgetExceeded, match="crossed it"):
        budget.charge(_usage(60), agent="0.2")


def test_the_overspending_request_is_included_in_the_report() -> None:
    """A caller showing the report must see the request that broke the budget."""
    budget = TreeBudget(limit=100)
    with pytest.raises(SessionBudgetExceeded):
        budget.charge(_usage(150), agent="0.1")

    report = budget.report()
    assert report.spent == 150
    assert report.exhausted is True


def test_exactly_reaching_the_limit_is_allowed() -> None:
    budget = TreeBudget(limit=100)
    budget.charge(_usage(100), agent="0.1")
    assert budget.report().spent == 100
    assert budget.report().exhausted is True


def test_remaining_floors_at_zero() -> None:
    budget = TreeBudget(limit=10)
    with pytest.raises(SessionBudgetExceeded):
        budget.charge(_usage(50), agent="0.1")
    assert budget.remaining == 0


def test_a_none_usage_records_the_agent_without_charging() -> None:
    """'Ran and reported nothing' must be distinguishable from 'never ran'."""
    budget = TreeBudget(limit=100)

    budget.charge(None, agent="0.3")

    report = budget.report()
    assert report.spent == 0
    assert report.by_agent == {"0.3": 0}


def test_negative_totals_do_not_refund() -> None:
    """A bad provider report must not buy budget back."""
    budget = TreeBudget(limit=100)
    budget.charge(_usage(40), agent="0.1")
    budget.charge(_usage(-50), agent="0.1")
    assert budget.report().spent == 40


def test_concurrent_charges_do_not_lose_tokens() -> None:
    """The loop feeds usage from two threads; a lost update would under-count."""
    budget = TreeBudget(limit=1_000_000)
    per_thread = 200
    threads = 8

    def run() -> None:
        for _ in range(per_thread):
            budget.charge(_usage(1), agent="0.1")

    workers = [threading.Thread(target=run) for _ in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert budget.report().spent == per_thread * threads


def test_the_rejected_slice_design_is_wrong_for_a_serial_child() -> None:
    """Documents why slices were rejected, using the tree budget as the fix.

    With a 1/(n+1) slice, a child in an otherwise idle tree is capped at a
    fraction of what is actually available. The tree budget has no such
    notion: it charges what was spent and no more.
    """
    limit = 100
    slices = 4
    slice_size = limit // (slices + 1)  # the rejected scheme
    budget = TreeBudget(limit=limit)

    # One child alone can use most of the tree, not just one slice.
    budget.charge(_usage(limit - 10), agent="0.1")

    assert slice_size < limit - 10
    assert budget.report().remaining == 10
