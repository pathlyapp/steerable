/**
 * Per-chat and per-process locks for one user-data directory.
 *
 * The host database itself is shared (WAL). These locks are the units that
 * stay exclusive: one running turn per chat, and one live owner per task.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  acquireWriteLease,
  StoreAlreadyOwnedError,
  type HeldWriteLease,
} from './write-lease.js';

export const HOST_SCHEMA_VERSION = 1;

/** How long a starting host waits for another host to finish migrating. */
export const OPEN_LOCK_WAIT_MS = 15_000;

export class ChatBusyError extends Error {
  readonly code = 'chat_busy';

  constructor(readonly chatId: string) {
    super(`chat busy: ${chatId}`);
    this.name = 'ChatBusyError';
  }
}

export class StorageUpgradeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUpgradeBlockedError';
  }
}

let boundInstanceId: string | null = null;

/** Records which instance owns rows created by this process. */
export function bindStorageInstance(instanceId: string | null): void {
  boundInstanceId = instanceId;
}

export function currentStorageInstanceId(): string | null {
  return boundInstanceId;
}

function assertLockId(id: string): void {
  if (id.length === 0 || id.length > 200 || /[\\/\0]/.test(id)) {
    throw new Error(`invalid lock id: ${id}`);
  }
}

export function chatLockPath(userDataDir: string, chatId: string): string {
  assertLockId(chatId);
  return path.join(userDataDir, 'locks', 'chat', `${chatId}.lock`);
}

export function instanceLockPath(userDataDir: string, instanceId: string): string {
  assertLockId(instanceId);
  return path.join(userDataDir, 'locks', 'instance', `${instanceId}.lock`);
}

export function fileLockPath(userDataDir: string, name: string): string {
  assertLockId(name);
  return path.join(userDataDir, 'locks', 'file', `${name}.lock`);
}

export function openLockPath(dbPath: string): string {
  const parsed = path.parse(path.resolve(dbPath));
  return path.join(parsed.dir, `${parsed.name}.open.lock`);
}

/** Exclusive lock for one chat. Fails immediately when another process holds it. */
export function acquireChatWriteLock(userDataDir: string, chatId: string): HeldWriteLease {
  try {
    return acquireWriteLease(chatLockPath(userDataDir, chatId));
  } catch (error) {
    if (error instanceof StoreAlreadyOwnedError) throw new ChatBusyError(chatId);
    throw error;
  }
}

export interface InstanceLease {
  readonly instanceId: string;
  release(): void;
}

/** Held until this host process exits. A dead process's lock can be taken. */
export function acquireInstanceLease(userDataDir: string): InstanceLease {
  const instanceId = randomUUID();
  const lease = acquireWriteLease(instanceLockPath(userDataDir, instanceId));
  return {
    instanceId,
    release: () => lease.release(),
  };
}

/**
 * True when `instanceId` still holds its lease.
 * A missing or unlocked file means the owner is dead.
 */
export function instanceOwnerIsLive(userDataDir: string, instanceId: string): boolean {
  let lockPath: string;
  try {
    lockPath = instanceLockPath(userDataDir, instanceId);
  } catch {
    return false;
  }
  try {
    const probe = acquireWriteLease(lockPath);
    probe.release();
    return false;
  } catch (error) {
    if (error instanceof StoreAlreadyOwnedError) return true;
    throw error;
  }
}
