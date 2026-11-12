"""Cross-process leases for one sqlite database file.

Several processes may hold a shared lease on the sibling ``*.lock`` file
(``sessions.db`` → ``sessions.lock``) while they have the database open.
Schema migration takes an exclusive lease and fails immediately when any
other process holds the file. Process death releases the kernel lock.
There is no TTL that could steal from a live process. The lock file is
never deleted: it keeps a stable inode for later lockers.

POSIX uses non-blocking ``fcntl.flock`` (``LOCK_SH`` to register an open
database, ``LOCK_EX`` to migrate). Windows uses the lock file's share mode,
the same rule as the Rust sidecar: shared openers allow read and write
sharing, and an exclusive opener allows none. SQLite byte-range locks do
not see this file, so only this flock/share-mode pair coordinates Python
and Rust.
"""

from __future__ import annotations

import errno
import os
import sys
from pathlib import Path
from typing import Any

from ..errors import StoreAlreadyOwnedError

_LOCK_ATTEMPTS = 3


def lock_path_for_db(db_path: str | os.PathLike[str]) -> Path:
    """Sibling lock file: ``sessions.db`` → ``sessions.lock``."""
    return Path(db_path).expanduser().resolve().with_suffix(".lock")


def _is_memory(db_path: str) -> bool:
    return db_path == ":memory:" or db_path.startswith("file::memory:")


def acquire_shared_lease(db_path: str | os.PathLike[str]) -> "WriteLease":
    """Register that this process has ``db_path`` open.

    Other shared holders succeed. An exclusive holder (a migration, or an
    older sidecar that still locks the whole database) fails loud.
    ``:memory:`` databases have no file and take no lease.
    """
    return _acquire(db_path, shared=True)


def acquire_write_lease(db_path: str | os.PathLike[str]) -> "WriteLease":
    """Acquire the exclusive lease for ``db_path``.

    Used for schema migration. A shared or exclusive holder fails loud.
    ``:memory:`` databases have no file and take no lease.
    """
    return _acquire(db_path, shared=False)


def _acquire(db_path: str | os.PathLike[str], *, shared: bool) -> "WriteLease":
    raw = os.fspath(db_path)
    if _is_memory(raw):
        return WriteLease._unheld()
    lock_path = lock_path_for_db(raw)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        return WriteLease._acquire_win32(lock_path, shared=shared)
    return WriteLease._acquire_posix(lock_path, shared=shared)


class WriteLease:
    """Held kernel lock. ``release`` closes the descriptor/handle; the file stays."""

    def __init__(self, *, _fd: int | None, _handle: Any, _lock_path: Path | None) -> None:
        self._fd = _fd
        self._handle = _handle
        self._lock_path = _lock_path
        self._released = False

    @classmethod
    def _unheld(cls) -> "WriteLease":
        return cls(_fd=None, _handle=None, _lock_path=None)

    @classmethod
    def _acquire_posix(cls, lock_path: Path, *, shared: bool) -> "WriteLease":
        import fcntl

        mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
        for _ in range(_LOCK_ATTEMPTS):
            fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, mode | fcntl.LOCK_NB)
            except OSError as exc:
                os.close(fd)
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES):
                    raise StoreAlreadyOwnedError(str(lock_path)) from exc
                raise
            held = os.fstat(fd)
            try:
                current = os.stat(lock_path)
            except FileNotFoundError:
                os.close(fd)
                continue
            if (held.st_ino, held.st_dev) == (current.st_ino, current.st_dev):
                return cls(_fd=fd, _handle=None, _lock_path=lock_path)
            os.close(fd)
        raise StoreAlreadyOwnedError(str(lock_path))

    @classmethod
    def _acquire_win32(cls, lock_path: Path, *, shared: bool) -> "WriteLease":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create_file = kernel32.CreateFileW
        create_file.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        create_file.restype = wintypes.HANDLE
        generic_read = 0x80000000
        generic_write = 0x40000000
        file_share_read = 0x00000001
        file_share_write = 0x00000002
        open_always = 4
        file_attribute_normal = 0x80
        error_sharing = 32
        error_lock = 33
        invalid = wintypes.HANDLE(-1).value
        share = file_share_read | file_share_write if shared else 0
        handle = create_file(
            str(lock_path),
            generic_read | generic_write,
            share,
            None,
            open_always,
            file_attribute_normal,
            None,
        )
        if handle is None or int(handle) == int(invalid):
            err = ctypes.get_last_error()
            if err in (error_sharing, error_lock):
                raise StoreAlreadyOwnedError(str(lock_path))
            raise ctypes.WinError(err)
        return cls(_fd=None, _handle=handle, _lock_path=lock_path)

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
        if self._handle is not None:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = [wintypes.HANDLE]
            close_handle.restype = wintypes.BOOL
            close_handle(self._handle)
            self._handle = None

    def __enter__(self) -> "WriteLease":
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()
