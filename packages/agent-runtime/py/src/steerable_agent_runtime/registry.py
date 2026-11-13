"""The child-agent registry: the durable answer to "what did this session spawn".

The ``AgentPool`` only knows the children it is currently driving — it is
built per turn and shut down with it, so a parent that finished a turn has no
way to learn what it spawned. This registry is the durable index instead: one
row per spawned child, written at spawn and settled at each terminal exit.

State is **composed**, never stored as a single truth:

- a terminal status comes from the row (``completed`` / ``error`` /
  ``cancelled`` / ``budget_exhausted`` / ``closed``);
- ``running`` is derived from a live in-process handle and is never written,
  so a killed process cannot leave a permanently running row behind;
- a row that never reached a terminal write while no handle exists is
  ``interrupted`` — the parent turn ended or the process died mid-run, and
  ``agent_send`` can resume it.

That composition is what makes "what happened while the app was closed" a
question the registry can answer, instead of a question the UI guesses at.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from .child_record import (
    INTERRUPTED_CHILD_STATUS,
    RESUMABLE_CHILD_STATUSES,
    ChildRecord,
)
from .llm import LLMUsage
from .storage import StorageAdapter

__all__ = [
    "ChildRegistry",
    "ChildStatusView",
    "SpawnedChild",
    "default_record_id",
    "registry_status",
]


def default_record_id(parent_record_id: str, child_id: str) -> str:
    """The one place the child record id is spelled.

    ``<parent>:child:<lineage id>`` — hosts read child traces by this id
    (``child_spawned`` publishes it), so deriving it anywhere else risks two
    spellings of the same record.
    """
    return f"{parent_record_id}:child:{child_id}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


#: The loop's completion vocabulary → the registry's. ``failed`` is what
#: ``CoreLoop`` reports for a run that ended in error; ``error`` is what the
#: pool records for a child whose run raised out of the loop entirely. One
#: spelling reaches storage so a resumed child is not told "failed" while its
#: row says "error".
_COMPLETION_TO_REGISTRY: dict[str, str] = {
    "completed": "completed",
    "failed": "error",
    "error": "error",
    "cancelled": "cancelled",
    "budget_exhausted": "budget_exhausted",
    "closed": "closed",
}


def registry_status(completion_status: str) -> str:
    """Translate a loop completion status into a registry status.

    An unknown status raises rather than writing a row the resume path cannot
    interpret: a child whose row says something nobody understands is worse
    than a loudly failed bookkeeping write, which the caller logs and
    continues from.
    """
    try:
        return _COMPLETION_TO_REGISTRY[completion_status]
    except KeyError:
        raise ValueError(
            f"unknown child completion status {completion_status!r}; expected one of "
            f"{sorted(_COMPLETION_TO_REGISTRY)}"
        ) from None


@dataclass(frozen=True, slots=True)
class SpawnedChild:
    """What a caller must supply to register one spawn."""

    parent_record_id: str
    child_id: str
    depth: int
    profile: str | None
    engine: str


@dataclass(frozen=True, slots=True)
class ChildStatusView:
    """One child as ``agent_list`` / the ``children`` CLI report it.

    ``status`` is the composed answer (see the module docstring); ``live``
    says whether an in-process handle exists right now, which is the one
    fact the stored row cannot know.
    """

    record: ChildRecord
    status: str
    live: bool

    @property
    def resumable(self) -> bool:
        """True when ``agent_send`` can continue this child.

        A finished child can always be given a follow-up turn; an
        ``interrupted`` one resumes from its record. A ``closed`` child never
        does — that is what closing means.
        """
        if self.live:
            return False
        return (
            self.status in RESUMABLE_CHILD_STATUSES
            and self.record.status != "closed"
        )

    def to_wire(self, *, answer_preview: str | None = None) -> dict[str, object]:
        """Model/host-facing payload.

        ``answerPreview`` is supplied by the caller (read from the child's own
        record) rather than stored here, so the registry never duplicates the
        transcript.
        """
        payload: dict[str, object] = {
            **self.record.to_wire(),
            "status": self.status,
            "live": self.live,
            "resumable": self.resumable,
        }
        if answer_preview:
            payload["answerPreview"] = answer_preview
        return payload


class ChildRegistry:
    """Durable child-agent index over one ``StorageAdapter``.

    A registry with ``store=None`` is inert: writes are no-ops, reads return
    nothing. That is the shape a host without a storage adapter gets, and it
    keeps the pool free of ``if store is not None`` branches.
    """

    def __init__(self, store: StorageAdapter | None) -> None:
        self._store = store
        #: Live handles by record id — the only source of ``running``.
        self._live: dict[str, Callable[[], bool]] = {}
        #: Rows noted but not yet written. ``spawn`` must not await, but the
        #: row has to be visible to an ``agent_list`` issued immediately
        #: after it, so the note is synchronous and the write happens at the
        #: child's first await.
        self._pending: dict[str, ChildRecord] = {}

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def note_spawn(
        self, child: SpawnedChild, *, record_id: str | None = None
    ) -> str:
        """Note one spawn without awaiting storage; returns the record id.

        Called inside ``AgentPool.spawn``, which is synchronous. The row is
        readable at once (reads merge the pending set) and becomes durable at
        ``flush_spawn``, which ``_run_child`` awaits before the child's first
        model request — so a crash between the two leaves at worst an
        unrecorded child, never a row claiming a child that never ran.
        """
        resolved = record_id or default_record_id(child.parent_record_id, child.child_id)
        if self._store is None:
            return resolved
        now = _now_iso()
        existing = self._pending.get(resolved)
        created_at = existing.created_at if existing is not None else now
        self._pending[resolved] = ChildRecord(
            record_id=resolved,
            parent_record_id=child.parent_record_id,
            child_id=child.child_id,
            depth=child.depth,
            profile=child.profile,
            engine=child.engine,
            # ``running`` is never written; the row stays non-terminal until
            # a real terminal status arrives.
            status="pending",
            resumable=False,
            prompt_tokens=None,
            completion_tokens=None,
            usage_known=True,
            created_at=created_at,
            updated_at=now,
        )
        return resolved

    async def flush_spawn(self, record_id: str) -> None:
        """Persist a noted spawn. Idempotent; a no-op once written."""
        record = self._pending.pop(record_id, None)
        if record is None or self._store is None:
            return
        existing = await self._store.get_child(record_id)
        # A resumed child keeps its original creation time: spawn order is
        # what the panel and the CLI sort by, so a resumed child must not
        # jump to the end of the list.
        if existing is not None:
            record = replace(record, created_at=existing.created_at)
        await self._store.upsert_child(record)

    async def spawned(self, child: SpawnedChild, *, record_id: str | None = None) -> str:
        """Note and immediately persist one spawn; returns the record id."""
        resolved = self.note_spawn(child, record_id=record_id)
        await self.flush_spawn(resolved)
        return resolved

    async def finished(
        self,
        record_id: str,
        *,
        status: str,
        usage: LLMUsage | None = None,
        usage_known: bool = True,
    ) -> bool:
        """Settle one child's terminal status and usage.

        ``usage=None`` with ``usage_known=False`` is the external-engine case
        (ACP reports no token bill); ``usage=None`` with ``usage_known=True``
        means a local child that reported nothing, which is still "known zero"
        for budget purposes.
        """
        if self._store is None:
            return False
        # A child that settled before its row reached disk still needs one.
        self._pending.pop(record_id, None)
        prompt = usage.prompt_tokens if usage is not None else None
        completion = usage.completion_tokens if usage is not None else None
        return await self._store.finish_child(
            record_id,
            status=status,
            prompt_tokens=prompt,
            completion_tokens=completion,
            usage_known=usage_known,
            resumable=status in RESUMABLE_CHILD_STATUSES,
            updated_at=_now_iso(),
        )

    # ------------------------------------------------------------------
    # Live handles
    # ------------------------------------------------------------------

    def mark_live(self, record_id: str, is_live: Callable[[], bool]) -> None:
        """Register the liveness probe for a child that is running now.

        A *probe* rather than a boolean, so a caller that keeps the pool alive
        across an await boundary cannot leave a stale ``True`` behind: the
        registry asks the handle whether it is still running when it reports.
        """
        self._live[record_id] = is_live

    def mark_settled(self, record_id: str) -> None:
        """Forget a live handle once its run reached a terminal status."""
        self._live.pop(record_id, None)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    async def get(self, record_id: str) -> ChildStatusView | None:
        """One child with its composed status, or ``None``."""
        if self._store is None:
            return None
        record = self._pending.get(record_id) or await self._store.get_child(record_id)
        return self._view(record) if record is not None else None

    async def list_for_parent(
        self, parent_record_id: str, *, include_finished: bool = True
    ) -> list[ChildStatusView]:
        """Every child of one parent, oldest first.

        Filtering happens after composition, not in the query: a row with a
        non-terminal status and no live handle is ``interrupted``, which is
        exactly what ``include_finished=False`` must keep.
        """
        if self._store is None:
            return []
        stored = {r.record_id: r for r in await self._store.list_children(parent_record_id)}
        # Noted-but-unwritten rows are visible immediately, so a spawn
        # issued in this same turn is already listed.
        for record in self._pending.values():
            if record.parent_record_id == parent_record_id:
                stored[record.record_id] = record
        records = sorted(stored.values(), key=lambda r: r.created_at)
        views = [self._view(record) for record in records]
        if not include_finished:
            views = [view for view in views if not view.record.terminal]
        return views

    async def list_all(self, *, prefix: str | None = None) -> list[ChildStatusView]:
        """Every child, optionally filtered by a ``parent_record_id`` prefix.

        This is how a host answers "what did this session spawn" after a
        restart, when no pool exists to ask.
        """
        if self._store is None:
            return []
        stored = {r.record_id: r for r in await self._store.list_all_children(prefix=prefix)}
        for record in self._pending.values():
            if prefix is None or record.parent_record_id.startswith(prefix):
                stored[record.record_id] = record
        records = sorted(stored.values(), key=lambda r: r.created_at)
        return [self._view(record) for record in records]

    async def find_child(self, parent_record_id: str, child_id: str) -> ChildStatusView | None:
        """Resolve a lineage id (``0.2``) to its child within one parent.

        Resume is addressed by lineage id — that is what the parent model
        remembers and what tool results carry — so the lookup lives here
        rather than making every caller scan ``list_for_parent``.
        """
        for view in await self.list_for_parent(parent_record_id):
            if view.record.child_id == child_id:
                return view
        return None

    def _view(self, record: ChildRecord) -> ChildStatusView:
        probe = self._live.get(record.record_id)
        live = bool(probe()) if probe is not None else False
        if record.terminal:
            # Closed is terminal and wins over any stale probe: a closed
            # child is never "running", even if its task has not settled yet.
            return ChildStatusView(record=record, status=record.status, live=False)
        if live:
            return ChildStatusView(record=record, status="running", live=True)
        return ChildStatusView(
            record=record, status=INTERRUPTED_CHILD_STATUS, live=False
        )
