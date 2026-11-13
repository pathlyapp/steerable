"""The child-agent registry record: one shape, shared by every store.

A record answers only "whose child is this, how deep, what built it, and
where it ended". Task text and answers are deliberately absent — they live
in the child's own ``history`` record, so each fact has one authoritative
copy.

This module is a leaf: no storage and no agent imports. Both the registry
(``registry.py``) and the adapters (``storage/sqlite_store.py``) read these
definitions, which is what keeps their column mapping from drifting.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

#: Statuses that will never change again. ``running`` is absent on purpose:
#: it is derived from a live in-process handle, never written, so a killed
#: process cannot leave a permanently "running" row behind.
TERMINAL_CHILD_STATUSES: frozenset[str] = frozenset(
    {
        "completed",
        "error",
        "cancelled",
        "budget_exhausted",
        "closed",
    }
)

#: Derived, never written: the child has no terminal row and no live handle.
#: The parent turn ended or the process died mid-run; ``agent_send`` resumes it.
INTERRUPTED_CHILD_STATUS = "interrupted"

#: Statuses that accept a further message. ``closed`` is excluded: it is the
#: caller's explicit "never again" and must stay that way.
RESUMABLE_CHILD_STATUSES: frozenset[str] = frozenset(
    {
        "completed",
        "interrupted",
        "cancelled",
        "budget_exhausted",
    }
)


@dataclass(frozen=True, slots=True)
class ChildRecord:
    """One registry row.

    ``record_id`` is the child's own durable record (``<parent>:child:<lineage
    id>``); ``child_id`` is the lineage id inside the parent's pool. ``depth``
    and ``profile`` are duplicated from creation time on purpose: resume must
    rebuild the child's tool domain and nesting from what it was created with,
    never from current settings — otherwise a depth-1 child that was never
    allowed to spawn would gain orchestration tools by being resumed.
    """

    record_id: str
    parent_record_id: str
    child_id: str
    depth: int
    profile: str | None
    engine: str
    status: str
    resumable: bool
    prompt_tokens: int | None
    completion_tokens: int | None
    usage_known: bool
    created_at: str
    updated_at: str

    @property
    def terminal(self) -> bool:
        """True when this status will never change again."""
        return self.status in TERMINAL_CHILD_STATUSES

    def with_terminal_status(
        self,
        *,
        status: str,
        prompt_tokens: int | None,
        completion_tokens: int | None,
        usage_known: bool,
        resumable: bool,
        updated_at: str,
    ) -> ChildRecord:
        """This record after a run settled."""
        return replace(
            self,
            status=status,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            usage_known=usage_known,
            resumable=resumable,
            updated_at=updated_at,
        )

    def to_wire(self) -> dict[str, Any]:
        """Camel-case payload shape for ``agent_list`` and the ``children`` CLI.

        The row is already model-facing (it says nothing about storage), so
        this is the only translation step between disk and the protocol.
        """
        return {
            "recordId": self.record_id,
            "parentRecordId": self.parent_record_id,
            "childId": self.child_id,
            "depth": self.depth,
            "profile": self.profile,
            "engine": self.engine,
            "status": self.status,
            "resumable": self.resumable,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "usageKnown": self.usage_known,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


#: Record attribute → SQL column, in insert order. Adapters use this to bind
#: one statement; ``child_row.to_wire`` uses the attribute names for the wire.
CHILD_COLUMNS: tuple[tuple[str, str], ...] = (
    ("record_id", "record_id"),
    ("parent_record_id", "parent_record_id"),
    ("child_id", "child_id"),
    ("depth", "depth"),
    ("profile", "profile"),
    ("engine", "engine"),
    ("status", "status"),
    ("resumable", "resumable"),
    ("prompt_tokens", "prompt_tokens"),
    ("completion_tokens", "completion_tokens"),
    ("usage_known", "usage_known"),
    ("created_at", "created_at"),
    ("updated_at", "updated_at"),
)

_INT_FIELDS = frozenset({"depth"})
_BOOL_FIELDS = frozenset({"resumable", "usage_known"})


def record_to_values(record: ChildRecord) -> tuple[Any, ...]:
    """Positional values for the insert whose columns are ``CHILD_COLUMNS``.

    SQLite has no boolean type, so flags bind as 0/1 here rather than at each
    call site.
    """
    values: list[Any] = []
    for attribute, _column in CHILD_COLUMNS:
        value = getattr(record, attribute)
        if attribute in _BOOL_FIELDS:
            values.append(int(bool(value)))
        else:
            values.append(value)
    return tuple(values)


def record_from_columns(columns: dict[str, Any]) -> ChildRecord:
    """Rebuild a record from a store's column mapping.

    Flags arrive as 0/1 from SQLite and as ``bool`` from SQLAlchemy; both are
    normalised here so callers never branch on the storage engine.
    """
    values: dict[str, Any] = {}
    for attribute, column in CHILD_COLUMNS:
        value = columns[column]
        if attribute in _INT_FIELDS:
            value = int(value)
        elif attribute in _BOOL_FIELDS:
            value = bool(value)
        values[attribute] = value
    return ChildRecord(**values)
