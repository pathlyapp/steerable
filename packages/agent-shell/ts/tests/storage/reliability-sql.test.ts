/**
 * R4 的聚合 SQL 跑在真实 SQLite 上。
 *
 * 口径（停止不算失败、重试恢复单独计）已经有纯函数测试覆盖，这里只锁
 * 一件事：`getReliabilitySummary` 里那两条查询在真库上算出的数对不对。
 * 用真的 better-sqlite3 而不是 mock，因为要防的正是「SQL 看起来对、跑出来
 * 错」——`GROUP BY` 用输出别名时 SQLite 会解析到源列，把 auth 和 transport
 * 并成一个桶，这种错 mock 永远测不出来。
 */
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const DAY_MS = 24 * 60 * 60 * 1000;

/** 与 `LocalStore.ensureColumn` 同语义的迁移，用在测试自己的最小表上。 */
function ensureColumn(
  db: import('better-sqlite3').Database,
  column: string,
  type: string,
): void {
  const columns = db.prepare('PRAGMA table_info(usage_events)').all() as Array<{
    name: string;
  }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE usage_events ADD COLUMN ${column} ${type}`);
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE usage_events (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, id TEXT NOT NULL,
      chat_id TEXT, kind TEXT NOT NULL, provider TEXT, model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL, created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, id)
    );
  `);
  ensureColumn(db, 'outcome', `TEXT NOT NULL DEFAULT 'completed'`);
  ensureColumn(db, 'failure_kind', 'TEXT');
  ensureColumn(db, 'attempts', 'INTEGER');
  ensureColumn(db, 'retried', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'used_direct', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}

function seed(
  db: import('better-sqlite3').Database,
  rows: Array<{
    outcome: 'completed' | 'failed' | 'cancelled';
    failureKind?: string;
    retried?: boolean;
    usedDirect?: boolean;
    ageDays?: number;
  }>,
): void {
  const insert = db.prepare(`
    INSERT INTO usage_events
      (tenant_id, user_id, id, chat_id, kind, provider, model, prompt_tokens,
       completion_tokens, total_tokens, cached_prompt_tokens, cost_usd,
       created_at, outcome, failure_kind, attempts, retried, used_direct)
    VALUES ('local','local',?,'c1','turn','p','m',0,0,0,0,NULL,?,?,?,?,?,?)
  `);
  rows.forEach((row, index) => {
    const age = row.ageDays ?? 0;
    insert.run(
      `e${index}`,
      new Date(Date.now() - age * DAY_MS).toISOString(),
      row.outcome,
      row.failureKind ?? null,
      3,
      row.retried ? 1 : 0,
      row.usedDirect ? 1 : 0,
    );
  });
}

/** The exact queries `LocalStore.getReliabilitySummary` issues. */
function readSummary(db: import('better-sqlite3').Database, sinceDays: number) {
  const since = new Date(Date.now() - sinceDays * DAY_MS).toISOString();
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN outcome = 'completed' AND retried = 1 THEN 1 ELSE 0 END) AS recovered,
         SUM(CASE WHEN used_direct = 1 THEN 1 ELSE 0 END) AS used_direct
       FROM usage_events
       WHERE tenant_id = ? AND user_id = ? AND created_at >= ?`,
    )
    .get('local', 'local', since) as Record<string, number | null>;
  const byKind = db
    .prepare(
      `SELECT COALESCE(failure_kind, 'unknown') AS kind, COUNT(*) AS count
       FROM usage_events
       WHERE tenant_id = ? AND user_id = ? AND created_at >= ?
         AND outcome = 'failed'
       GROUP BY COALESCE(failure_kind, 'unknown')
       ORDER BY count DESC, kind`,
    )
    .all('local', 'local', since) as Array<{ kind: string; count: number }>;
  return { totals, byKind };
}

describe('可靠性统计的聚合 SQL', () => {
  it('三种终态分开数，重试恢复只算成功的', () => {
    const db = makeDb();
    seed(db, [
      { outcome: 'completed', retried: true },
      { outcome: 'completed', retried: true },
      { outcome: 'completed' },
      { outcome: 'failed', failureKind: 'transport', retried: true },
      { outcome: 'failed', failureKind: 'auth' },
      { outcome: 'cancelled' },
    ]);

    const { totals } = readSummary(db, 7);

    expect(totals.total).toBe(6);
    expect(totals.failed).toBe(2);
    expect(totals.cancelled).toBe(1);
    expect(totals.recovered).toBe(2);
  });

  it('失败按类别分桶，不会把不同类别并成一个', () => {
    // 这条防的是 `GROUP BY kind` 解析到源列：那样 auth 会被并进 transport，
    // 「网络类失败占比」这个关键指标就会虚高。
    const db = makeDb();
    seed(db, [
      { outcome: 'failed', failureKind: 'transport' },
      { outcome: 'failed', failureKind: 'auth' },
      { outcome: 'failed', failureKind: 'transport' },
    ]);

    const { byKind } = readSummary(db, 7);

    expect(byKind).toEqual([
      { kind: 'transport', count: 2 },
      { kind: 'auth', count: 1 },
    ]);
  });

  it('没有类别的旧记录归到 unknown，不丢', () => {
    const db = makeDb();
    seed(db, [{ outcome: 'failed' }]);

    const { byKind } = readSummary(db, 7);

    expect(byKind).toEqual([{ kind: 'unknown', count: 1 }]);
  });

  it('窗口外的回合不计入', () => {
    const db = makeDb();
    seed(db, [
      { outcome: 'failed', failureKind: 'transport' },
      { outcome: 'failed', failureKind: 'transport', ageDays: 30 },
    ]);

    const { totals, byKind } = readSummary(db, 7);

    expect(totals.total).toBe(1);
    expect(byKind).toEqual([{ kind: 'transport', count: 1 }]);
  });

  it('空表给出零而不是报错', () => {
    const { totals, byKind } = readSummary(makeDb(), 7);

    expect(totals.total).toBe(0);
    expect(totals.failed).toBeNull();
    expect(byKind).toEqual([]);
  });

  it('迁移可重复执行，已有列不会重复加', () => {
    const db = makeDb();
    ensureColumn(db, 'outcome', 'TEXT');
    ensureColumn(db, 'outcome', 'TEXT');
    const columns = db
      .prepare('PRAGMA table_info(usage_events)')
      .all() as Array<{ name: string }>;
    expect(columns.filter((c) => c.name === 'outcome')).toHaveLength(1);
  });
});
