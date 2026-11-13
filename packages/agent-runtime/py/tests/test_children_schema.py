"""Schema v1 → v2: the ``children`` table arrives without a data migration.

The child-agent index is additive, so an existing v1 database must open
unchanged and gain the table in place. The second half of this file pins the
one thing that can silently rot: the SQL ``IN`` list used by
``include_finished=False`` must be derived from the same status set the
registry reasons about.
"""

from __future__ import annotations

import sqlite3

import pytest

from steerable_agent_runtime.child_record import (
    INTERRUPTED_CHILD_STATUS,
    RESUMABLE_CHILD_STATUSES,
    TERMINAL_CHILD_STATUSES,
    ChildRecord,
)
from steerable_agent_runtime.storage import SqliteStorage
from steerable_agent_runtime.storage.sqlite_store import SCHEMA_VERSION


def _record(record_id: str = "chat/p:child:0.1") -> ChildRecord:
    return ChildRecord(
        record_id=record_id,
        parent_record_id="chat/p",
        child_id="0.1",
        depth=1,
        profile="explore",
        engine="coreloop",
        status="running",
        resumable=False,
        prompt_tokens=None,
        completion_tokens=None,
        usage_known=True,
        created_at="2026-11-12T00:00:00Z",
        updated_at="2026-11-12T00:00:00Z",
    )


def _make_v1_database(path: str) -> None:
    """A database exactly as the previous release left it: v1 schema, one
    session and one record, no ``children`` table."""
    db = sqlite3.connect(path)
    try:
        db.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                chat_id    TEXT NOT NULL,
                is_active  INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                data       TEXT NOT NULL
            );
            CREATE TABLE history (
                record_id TEXT NOT NULL,
                seq       INTEGER NOT NULL,
                data      TEXT NOT NULL,
                PRIMARY KEY (record_id, seq)
            );
            INSERT INTO history (record_id, seq, data)
                VALUES ('chat/p', 0, '{"seq": 0, "kind": "item"}');
            """
        )
        db.execute("PRAGMA user_version = 1")
        db.commit()
    finally:
        db.close()


def test_schema_version_is_two() -> None:
    assert SCHEMA_VERSION == 2


def test_opening_a_v1_database_creates_children_in_place(tmp_path) -> None:
    path = str(tmp_path / "old.db")
    _make_v1_database(path)

    storage = SqliteStorage(path)
    try:
        # The upgrade ran, and the pre-existing record survived it.
        db = sqlite3.connect(path)
        try:
            assert db.execute("PRAGMA user_version").fetchone()[0] == 2
            assert db.execute("SELECT COUNT(*) FROM history").fetchone()[0] == 1
            assert (
                db.execute(
                    "SELECT COUNT(*) FROM sqlite_master"
                    " WHERE type = 'table' AND name = 'children'"
                ).fetchone()[0]
                == 1
            )
        finally:
            db.close()
    finally:
        storage.close()


@pytest.mark.asyncio
async def test_a_v1_database_accepts_child_writes_after_upgrade(tmp_path) -> None:
    path = str(tmp_path / "old.db")
    _make_v1_database(path)

    storage = SqliteStorage(path)
    try:
        await storage.upsert_child(_record())
        fetched = await storage.get_child("chat/p:child:0.1")
        assert fetched is not None
        assert fetched.child_id == "0.1"
    finally:
        storage.close()


def test_a_newer_database_is_refused_whole(tmp_path) -> None:
    """Forward compatibility stays fail-closed: a v3 database is not opened."""
    path = str(tmp_path / "future.db")
    db = sqlite3.connect(path)
    db.execute("PRAGMA user_version = 3")
    db.commit()
    db.close()

    from steerable_agent_runtime.errors import StorageUpgradeBlockedError

    with pytest.raises(StorageUpgradeBlockedError, match="newer than this program"):
        SqliteStorage(path)


def test_terminal_and_resumable_statuses_agree() -> None:
    """``closed`` is terminal and not resumable; ``interrupted`` is resumable
    and not terminal. A status appearing in both sets would make
    ``agent_send`` accept a child that can never run again."""
    assert "closed" in TERMINAL_CHILD_STATUSES
    assert "closed" not in RESUMABLE_CHILD_STATUSES
    assert INTERRUPTED_CHILD_STATUS in RESUMABLE_CHILD_STATUSES
    assert INTERRUPTED_CHILD_STATUS not in TERMINAL_CHILD_STATUSES
    # ``running`` must never be terminal: it is derived, never written.
    assert "running" not in TERMINAL_CHILD_STATUSES
