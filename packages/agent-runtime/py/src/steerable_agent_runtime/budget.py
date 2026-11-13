"""One token budget for a whole delegating turn tree.

``steerable_agent_harness.budget`` budgets **one loop run**: it charges that
run's own requests and reports exhaustion to that run. That is the wrong scope
once a turn can delegate: a parent plus three children would each get the full
allowance, so a turn's real spend could be four times what the host asked for
and no single loop would ever notice.

This module is the other scope — one counter shared by every agent in the tree.
Each request, whoever made it, charges the same state, and the first one to
cross the limit fails there. The alternative (handing each child a slice of
the remainder) was considered and rejected: a serial child given 1/(n+1) of
the budget hits its own wall while the tree still has room, which turns a
generous budget into a tight one.

Attribution is kept alongside the total because "the turn spent 40k" is not
actionable when a host needs to know which child spent it.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .llm import LLMUsage

__all__ = ["SessionBudgetExceeded", "TreeBudget", "TreeBudgetReport"]


class SessionBudgetExceeded(Exception):
    """Raised when a request would take the tree past its token limit.

    Named for the session, not for a child: the limit belongs to the whole
    turn tree, and the agent that happens to cross it is not the one at fault.
    """


@dataclass(frozen=True, slots=True)
class TreeBudgetReport:
    """The tree's spend at one point in time.

    ``by_agent`` keys are the caller's own agent labels (``"parent"``,
    ``"0.1"`` …) — the budget does not know about lineage and must not guess
    it, so it stores whatever key the caller passes.
    """

    limit: int
    spent: int
    by_agent: dict[str, int]

    @property
    def remaining(self) -> int:
        return max(self.limit - self.spent, 0)

    @property
    def exhausted(self) -> bool:
        return self.spent >= self.limit


@dataclass
class TreeBudget:
    """A token limit shared by every agent in one turn tree.

    Thread-safe: the loop hands usage in from both the parent's event loop and
    the worker thread that drives the native engine, so plain attribute
    updates would race.
    """

    limit: int
    _spent: int = field(default=0, init=False)
    _by_agent: dict[str, int] = field(default_factory=dict, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    def charge(self, usage: LLMUsage | None, *, agent: str) -> int:
        """Charge one request's usage; returns the tree's spend afterwards.

        ``usage=None`` charges nothing but still records the agent, so a host
        can tell "this child ran and reported nothing" apart from "this child
        never ran" — the distinction matters when the bill does not add up.

        Raises:
            SessionBudgetExceeded: when the charge takes the tree past
                ``limit``. The spend is recorded **before** raising, so the
                report a caller shows still includes the request that broke it.
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
            spent = self._spent
        if spent > self.limit:
            raise SessionBudgetExceeded(
                f"turn tree spent {spent} tokens against a {self.limit}-token "
                f"budget (agent {agent!r} crossed it)"
            )
        return spent

    @property
    def remaining(self) -> int:
        """Tokens left, floored at zero."""
        with self._lock:
            return max(self.limit - self._spent, 0)

    @property
    def exhausted(self) -> bool:
        """True once the tree has spent its whole limit."""
        with self._lock:
            return self._spent >= self.limit

    def report(self) -> TreeBudgetReport:
        """A snapshot, safe to hand to a host mid-turn."""
        with self._lock:
            return TreeBudgetReport(
                limit=self.limit,
                spent=self._spent,
                by_agent=dict(self._by_agent),
            )
