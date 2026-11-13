"""Per-agent token accounting for a delegating turn tree.

The question this answers is "what did this turn cost, and which agent spent
it" — nothing more. There is no limit here and no way to add one: a turn that
runs long is a turn that had more work, and stopping it mid-task throws away
the work already paid for. A host that wants cost control puts the gate where
it belongs (before a turn starts, or on a period budget), not inside a task
that is already half done.

Scope is the whole tree, not one loop. ``steerable_agent_harness.budget``
accounts for a single run; once a turn delegates, a parent plus three children
would each report their own slice and no single number would describe the
turn. One counter shared by every member gives the host that number, and the
per-agent breakdown says which member spent it.

Why an object rather than a dict the host already has: the loop hands usage in
from both the parent's event loop and the worker thread that drives the native
engine, so plain attribute updates would race.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .llm import LLMUsage

__all__ = ["TreeSpend", "TreeSpendReport"]


@dataclass(frozen=True, slots=True)
class TreeSpendReport:
    """The tree's spend at one point in time.

    ``by_agent`` keys are the caller's own agent labels (``"parent"``,
    ``"0.1"`` …) — this class does not know about lineage and must not guess
    it, so it stores whatever key the caller passes.
    """

    spent: int
    by_agent: dict[str, int]


@dataclass
class TreeSpend:
    """Token accounting shared by every agent in one turn tree."""

    _spent: int = field(default=0, init=False)
    _by_agent: dict[str, int] = field(default_factory=dict, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    def record(self, usage: LLMUsage | None, *, agent: str) -> int:
        """Add one run's usage; returns the tree's spend afterwards.

        ``usage=None`` adds nothing but still names the agent, so a host can
        tell "this child ran and reported nothing" (an external engine that
        bills nothing we can see) apart from "this child never ran". The
        distinction is what keeps a partial total from reading as complete.
        """
        if usage is None:
            with self._lock:
                self._by_agent.setdefault(agent, 0)
            return self._spent
        # Total, not prompt+completion: providers disagree about whether the
        # total includes cache reads, and ``usage.total_tokens`` is the one
        # number every provider reports consistently.
        billed = max(usage.total_tokens, 0)
        with self._lock:
            self._spent += billed
            self._by_agent[agent] = self._by_agent.get(agent, 0) + billed
            return self._spent

    @property
    def spent(self) -> int:
        """Tokens spent by the whole tree so far."""
        with self._lock:
            return self._spent

    def report(self) -> TreeSpendReport:
        """A snapshot, safe to hand to a host mid-turn."""
        with self._lock:
            return TreeSpendReport(spent=self._spent, by_agent=dict(self._by_agent))
