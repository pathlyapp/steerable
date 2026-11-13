"""The shared task board: one plan the whole spawn tree works from.

Without it, splitting a job means the parent hands out self-contained tasks
and then **remembers** who is doing what. That memory is the parent's context,
which is exactly the thing that gets long when a job is big enough to need four
agents. A board moves the plan out of any one context: the parent writes down
the work, workers claim items, and anyone can see what is still unclaimed.

Two decisions worth naming:

- **Claiming is atomic.** Two workers that both see "auth refactor: todo" must
  not both start it; ``claim`` either binds the caller or fails. That is the
  whole point of a board over a list in a prompt.
- **The board does not block.** ``claim`` returning "nothing free" is
  information, not a reason to wait. A worker that waits on the board would
  idle a slot the parent is budgeting for, so the caller decides what to do
  next — and ``team_task_list`` shows what exists.

Ownership is the caller's lineage id (``0.2``), so the board also answers "who
is doing this" without a second registry.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone

__all__ = ["TaskItem", "TeamTaskBoard"]

logger = logging.getLogger(__name__)

#: Statuses in the order work moves through them. ``todo`` is unclaimed; the
#: rest exist so a reader can tell "nobody took it" from "someone has it" from
#: "it is done" without reading every entry.
TASK_STATUSES = ("todo", "claimed", "done")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True, slots=True)
class TaskItem:
    """One unit of work on the board.

    ``owner`` is the claimant's lineage id (``None`` while ``todo``), and
    ``depends_on`` names other task ids — the shape DSH's team board uses, so a
    worker can tell "I can start" from "I am waiting on someone".
    """

    id: str
    title: str
    status: str
    owner: str | None = None
    detail: str | None = None
    depends_on: tuple[str, ...] = ()
    created_by: str | None = None
    created_at: str = ""
    updated_at: str = ""

    @property
    def blocked(self) -> bool:
        """True while a dependency is still unfinished.

        Computed by the board (which can see the others), not here: an item
        alone cannot know whether its dependencies are done.
        """
        return bool(self.depends_on)

    def to_wire(self) -> dict[str, object]:
        """Camel-case payload for a tool result."""
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            **({"owner": self.owner} if self.owner else {}),
            **({"detail": self.detail} if self.detail else {}),
            **({"dependsOn": list(self.depends_on)} if self.depends_on else {}),
            **({"createdBy": self.created_by} if self.created_by else {}),
        }


@dataclass
class TeamTaskBoard:
    """One board per spawn tree, shared by every member.

    The board is plain in-process state: it belongs to a turn tree, and a
    tree does not outlive the turn that started it. Nothing here is durable on
    purpose — a finished turn's plan has no reader, and persisting it would
    create a second place where "what was this job" lives.
    """

    _items: dict[str, TaskItem] = field(default_factory=dict)
    _seq: int = 0

    def create(
        self,
        *,
        title: str,
        detail: str | None = None,
        depends_on: tuple[str, ...] = (),
        created_by: str | None = None,
    ) -> TaskItem:
        """Add one unclaimed item and return it.

        Dependencies are validated here rather than at claim time: an item
        that names a task nobody created would never become claimable, and the
        author is the one who can fix the typo.
        """
        missing = [dep for dep in depends_on if dep not in self._items]
        if missing:
            raise KeyError(
                f"unknown dependenc{'y' if len(missing) == 1 else 'ies'}: "
                f"{', '.join(missing)}"
            )
        self._seq += 1
        now = _now_iso()
        item = TaskItem(
            id=f"t{self._seq}",
            title=title,
            status="todo",
            detail=detail,
            depends_on=tuple(depends_on),
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )
        self._items[item.id] = item
        return item

    def get(self, task_id: str) -> TaskItem | None:
        """One item, or ``None`` when the id is unknown."""
        return self._items.get(task_id)

    def items(self) -> list[TaskItem]:
        """Every item, in creation order."""
        return list(self._items.values())

    def ready(self) -> list[TaskItem]:
        """Unclaimed items whose dependencies are all done.

        This is what a worker without a specific id should claim: the answer
        "nothing ready, three blocked" is actionable in a way that a flat
        unclaimed list is not.
        """
        done = {item.id for item in self._items.values() if item.status == "done"}
        return [
            item
            for item in self._items.values()
            if item.status == "todo" and all(dep in done for dep in item.depends_on)
        ]

    def claim(self, task_id: str, *, owner: str) -> TaskItem:
        """Bind one ready item to ``owner``.

        Raises:
            KeyError: the id is unknown.
            ValueError: the item is not claimable (already claimed, done, or
                still blocked) — the message says which, because "cannot
                claim" alone tells the caller nothing about whether to wait,
                pick another item, or fix a dependency.

        Claiming is the one operation that must not race: two workers reading
        the same ``todo`` and both proceeding would duplicate the work, so the
        check and the bind happen in one step here and nowhere else.
        """
        item = self._items.get(task_id)
        if item is None:
            raise KeyError(f"unknown task {task_id!r}")
        if item.status == "done":
            raise ValueError(f"task {task_id} is already done")
        if item.status == "claimed":
            raise ValueError(
                f"task {task_id} is already claimed by {item.owner}"
            )
        done = {other.id for other in self._items.values() if other.status == "done"}
        blocked = [dep for dep in item.depends_on if dep not in done]
        if blocked:
            raise ValueError(
                f"task {task_id} is blocked by {', '.join(blocked)}"
            )
        claimed = replace(
            item, status="claimed", owner=owner, updated_at=_now_iso()
        )
        self._items[task_id] = claimed
        return claimed

    def complete(
        self, task_id: str, *, owner: str | None = None, note: str | None = None
    ) -> TaskItem:
        """Mark one claimed item done.

        ``owner`` is checked when given: a worker finishing another worker's
        item is far more often a mistake (wrong id) than intent, and the
        message names the real owner so the caller can correct itself.

        Raises:
            KeyError: the id is unknown.
            ValueError: the item is not claimed, or claimed by someone else.
        """
        item = self._items.get(task_id)
        if item is None:
            raise KeyError(f"unknown task {task_id!r}")
        if item.status == "done":
            return item
        if item.status != "claimed":
            raise ValueError(
                f"task {task_id} is {item.status}, not claimed; claim it first"
            )
        if owner is not None and item.owner is not None and item.owner != owner:
            raise ValueError(
                f"task {task_id} is claimed by {item.owner}, not {owner}"
            )
        detail = item.detail if note is None else (
            f"{item.detail}\n{note}" if item.detail else note
        )
        done = replace(
            item, status="done", detail=detail, updated_at=_now_iso()
        )
        self._items[task_id] = done
        return done

    def summary(self) -> dict[str, int]:
        """Counts by status, for a one-line board overview."""
        counts = {status: 0 for status in TASK_STATUSES}
        for item in self._items.values():
            counts[item.status] = counts.get(item.status, 0) + 1
        return counts
