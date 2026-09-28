import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { getProductConfig } from '../product-config.js';
import { getUserDataDir } from '../runtime.js';
import type {
  PackDbAccess,
  PackDbParams,
  PackDbRunResult,
  StorageDriver,
  TenantScope,
} from './driver.js';
import { LOCAL_SCOPE } from './driver.js';
import { SqliteScopedStore } from './index.js';
import {
  HOST_SCHEMA_VERSION,
  OPEN_LOCK_WAIT_MS,
  StorageUpgradeBlockedError,
  openLockPath,
} from './process-locks.js';
import type { ScopedStore } from './scoped-store.js';
import {
  acquireSharedLease,
  acquireWriteLease,
  lockPathForDb,
  StoreAlreadyOwnedError,
  type HeldWriteLease,
} from './write-lease.js';
import { acquireWriteLeaseOrExit } from './write-lease-error.js';

const MAIN_DB_BUSY_TIMEOUT_MS = 5_000;

function invokeStatement(
  statement: Database.Statement,
  operation: 'get' | 'all' | 'run',
  params?: PackDbParams,
): unknown {
  if (Array.isArray(params)) return statement[operation](...params);
  if (params) return statement[operation](params);
  return statement[operation]();
}

function assertScopedPackStatement(
  sql: string,
  params: PackDbParams | undefined,
  scope: TenantScope,
): void {
  if (/^\s*PRAGMA\b/i.test(sql) || /\bsqlite_master\b/i.test(sql)) return;
  if (!/\btenant_id\b/i.test(sql) || !/\buser_id\b/i.test(sql)) {
    throw new Error('[storage] pack SQL must bind tenant_id and user_id');
  }
  if (!params) {
    throw new Error('[storage] scoped pack parameters are required');
  }
  if (Array.isArray(params)) {
    if (!params.includes(scope.tenantId) || !params.includes(scope.userId)) {
      throw new Error('[storage] pack parameters do not match the bound scope');
    }
    return;
  }
  const named = params as Readonly<Record<string, unknown>>;
  const tenantId = named.tenantId ?? named.tenant_id;
  const userId = named.userId ?? named.user_id;
  if (tenantId !== scope.tenantId || userId !== scope.userId) {
    throw new Error('[storage] pack parameters do not match the bound scope');
  }
}

class SqlitePackDbAccess implements PackDbAccess {
  constructor(
    private readonly db: Database.Database,
    readonly scope: TenantScope,
  ) {}

  async get<T extends Record<string, unknown>>(
    sql: string,
    params?: PackDbParams,
  ): Promise<T | undefined> {
    assertScopedPackStatement(sql, params, this.scope);
    return invokeStatement(this.db.prepare(sql), 'get', params) as T | undefined;
  }

  async all<T extends Record<string, unknown>>(
    sql: string,
    params?: PackDbParams,
  ): Promise<T[]> {
    assertScopedPackStatement(sql, params, this.scope);
    return invokeStatement(this.db.prepare(sql), 'all', params) as T[];
  }

  async run(sql: string, params?: PackDbParams): Promise<PackDbRunResult> {
    assertScopedPackStatement(sql, params, this.scope);
    const result = invokeStatement(this.db.prepare(sql), 'run', params) as Database.RunResult;
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(operation: (db: PackDbAccess) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = await operation(this);
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function readUserVersion(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
}

function blockUpgrade(message: string): never {
  console.error(`[bs] storage upgrade blocked: ${message}`);
  queueMicrotask(() => process.exit(75));
  throw new StorageUpgradeBlockedError(message);
}

/** Default local SQLite storage driver. */
export class SqliteStorageDriver implements StorageDriver {
  private db: Database.Database | null = null;
  private openLease: HeldWriteLease | null = null;
  private changeTimer: ReturnType<typeof setInterval> | null = null;
  private localSqliteStore: SqliteScopedStore | null = null;
  private readonly stores = new Map<string, ScopedStore>();

  async initialize(): Promise<void> {
    if (this.db) return;
    const dbPath = path.join(
      getUserDataDir(),
      getProductConfig().dbFileName ?? 'agent-shell.db',
    );
    // A previous build held this lock for the whole process. If it is still
    // held, that process cannot share the database, so refuse to migrate
    // or to open alongside it.
    acquireWriteLeaseOrExit(() => {
      const legacy = acquireWriteLease(lockPathForDb(dbPath));
      legacy.release();
    });

    const gate = openLockPath(dbPath);
    let version = readUserVersion(dbPath);
    if (version > HOST_SCHEMA_VERSION) {
      blockUpgrade(
        `本地数据库版本 ${version} 高于本程序支持的版本 ${HOST_SCHEMA_VERSION}。请升级后再打开。`,
      );
    }

    let exclusive: HeldWriteLease | null = null;
    if (version === HOST_SCHEMA_VERSION) {
      // Make sure the open-lock table exists, then register as a shared holder.
      // A live shared holder rejects this exclusive probe immediately.
      try {
        acquireWriteLease(gate).release();
      } catch (error) {
        if (!(error instanceof StoreAlreadyOwnedError)) throw error;
      }
    } else {
      try {
        exclusive = acquireWriteLease(gate, OPEN_LOCK_WAIT_MS);
      } catch (error) {
        if (!(error instanceof StoreAlreadyOwnedError)) throw error;
        version = readUserVersion(dbPath);
        if (version !== HOST_SCHEMA_VERSION) {
          blockUpgrade(
            '本地数据库需要升级，但仍被另一个进程打开。请先关闭正在运行的应用及其命令行任务后再升级。',
          );
        }
      }
    }

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { timeout: MAIN_DB_BUSY_TIMEOUT_MS });
      db.pragma(`busy_timeout = ${MAIN_DB_BUSY_TIMEOUT_MS}`);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      this.db = db;
      const local = new SqliteScopedStore(db, LOCAL_SCOPE);
      await local.initialize();
      db.pragma(`user_version = ${HOST_SCHEMA_VERSION}`);
      this.localSqliteStore = local;
      this.stores.set(this.scopeKey(LOCAL_SCOPE), local);
      exclusive?.release();
      exclusive = null;
      this.openLease = acquireSharedLease(gate);
    } catch (error) {
      exclusive?.release();
      db?.close();
      this.db = null;
      this.openLease?.release();
      this.openLease = null;
      throw error;
    }
  }

  scoped(scope: TenantScope): ScopedStore {
    const db = this.requireDb();
    const key = this.scopeKey(scope);
    const existing = this.stores.get(key);
    if (existing) return existing;
    const store = new SqliteScopedStore(db, scope);
    this.stores.set(key, store);
    return store;
  }

  packAccess(scope: TenantScope): PackDbAccess {
    return new SqlitePackDbAccess(this.requireDb(), scope);
  }

  async applyPackMigrations(): Promise<void> {
    this.localSqliteStore?.applyPackMigrations();
  }

  watchChanges(onChange: () => void): void {
    const db = this.requireDb();
    if (this.changeTimer) return;
    let version = Number(db.pragma('data_version', { simple: true }));
    this.changeTimer = setInterval(() => {
      const next = Number(db.pragma('data_version', { simple: true }));
      if (next === version) return;
      version = next;
      onChange();
    }, 1_000);
    this.changeTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.changeTimer) {
      clearInterval(this.changeTimer);
      this.changeTimer = null;
    }
    this.stores.clear();
    this.db?.close();
    this.db = null;
    this.localSqliteStore = null;
    this.openLease?.release();
    this.openLease = null;
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('[storage] SQLite driver is not initialized');
    return this.db;
  }

  private scopeKey(scope: TenantScope): string {
    return `${scope.tenantId}\u0000${scope.userId}`;
  }
}
