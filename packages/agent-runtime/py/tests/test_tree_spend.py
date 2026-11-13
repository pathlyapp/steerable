"""Token accounting for the whole turn tree.

This answers "what did this turn cost, and which agent spent it" and nothing
else. It used to enforce a limit; that was removed on purpose, because a turn
that runs long is a turn that had more work, and stopping it mid-task throws
away the work already paid for. Cost control belongs before a turn starts, not
inside one that is half done.

What survives is the scope: one counter shared by the parent and every child,
so the host reads one number for the turn instead of adding up loops, with the
per-agent split saying which member spent it.
"""

from __future__ import annotations

import threading

from steerable_agent_runtime.spend import TreeSpend
from steerable_agent_runtime.llm import LLMUsage


def _usage(total: int, *, prompt: int | None = None, completion: int | None = None) -> LLMUsage:
    return LLMUsage(
        prompt_tokens=prompt if prompt is not None else total,
        completion_tokens=completion if completion is not None else 0,
        total_tokens=total,
    )


def test_recording_accumulates_across_agents() -> None:
    spend = TreeSpend()

    spend.record(_usage(30), agent="parent")
    spend.record(_usage(20), agent="0.1")

    assert spend.report().spent == 50


def test_attribution_is_kept_per_agent() -> None:
    """'The turn spent 40k' is not actionable; 'which child' is."""
    spend = TreeSpend()

    spend.record(_usage(300), agent="0.1")
    spend.record(_usage(100), agent="0.2")
    spend.record(_usage(50), agent="parent")

    assert spend.report().by_agent == {"0.1": 300, "0.2": 100, "parent": 50}


def test_there_is_no_limit_to_cross() -> None:
    """The whole point of the change: a big turn is reported, not stopped.

    A previous design raised ``SessionBudgetExceeded`` here and left the child
    stopped at ``budget_exhausted``, needing a human to click resume. That made
    "let four agents finish the refactor" end at 80% with no error the user
    could act on.
    """
    spend = TreeSpend()

    spend.record(_usage(10_000_000), agent="0.1")
    spend.record(_usage(10_000_000), agent="parent")

    assert spend.report().spent == 20_000_000
    assert spend.report().by_agent == {"0.1": 10_000_000, "parent": 10_000_000}


def test_a_none_usage_records_the_agent_without_adding_tokens() -> None:
    """'Ran and reported nothing' must be distinguishable from 'never ran'."""
    spend = TreeSpend()

    spend.record(None, agent="0.3")

    report = spend.report()
    assert report.spent == 0
    assert report.by_agent == {"0.3": 0}


def test_negative_totals_do_not_refund() -> None:
    """A bad provider report must not make the turn look cheaper."""
    spend = TreeSpend()
    spend.record(_usage(40), agent="0.1")
    spend.record(_usage(-50), agent="0.1")

    assert spend.report().spent == 40


def test_concurrent_records_do_not_lose_tokens() -> None:
    """The loop feeds usage from two threads; a lost update would under-count."""
    spend = TreeSpend()
    per_thread = 200
    threads = 8

    def run() -> None:
        for _ in range(per_thread):
            spend.record(_usage(1), agent="0.1")

    workers = [threading.Thread(target=run) for _ in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert spend.report().spent == per_thread * threads


def test_the_report_is_a_snapshot() -> None:
    """A host reading mid-turn must not see later records in an old report."""
    spend = TreeSpend()
    spend.record(_usage(10), agent="0.1")

    snapshot = spend.report()
    spend.record(_usage(90), agent="0.2")

    assert snapshot.spent == 10
    assert snapshot.by_agent == {"0.1": 10}
    assert spend.report().spent == 100
