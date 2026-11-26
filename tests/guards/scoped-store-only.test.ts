import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanSourceTextForPackViolations } from '@steerable/pack-testkit';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_SRC = path.resolve(HERE, '../../packages/agent-shell/ts/src');

const ALLOWED_STORAGE_PREPARE_REL = new Set([
  'storage/index.ts',
  'storage/sqlite-driver.ts',
  'storage/write-lease.ts',
  'local-backend/task-process.ts',
]);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('AST Guard #1: scoped-store-only (T-ARC-01)', () => {
  it('verifies zero raw SQL .prepare(...) or direct better-sqlite3/mysql2 imports outside StorageDriver in agent-shell', () => {
    const files = walkTs(SHELL_SRC);
    const violations = [];
    for (const file of files) {
      const rel = path.relative(SHELL_SRC, file).split(path.sep).join('/');
      if (ALLOWED_STORAGE_PREPARE_REL.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const found = scanSourceTextForPackViolations(src, rel, {
        allowStorageDriverPrepare: false,
        checkExtensionImports: false,
      }).filter((v) => v.rule === 'scoped-store-only');
      violations.push(...found);
    }
    expect(violations).toEqual([]);
  });

  it('catches injected raw db.prepare(...) and direct database driver imports immediately', () => {
    const badSnippet = `
      import Database from 'better-sqlite3';
      export function leakAllTenants(db: Database.Database) {
        return db.prepare('SELECT * FROM chat_sessions').all();
      }
    `;
    const violations = scanSourceTextForPackViolations(badSnippet, 'bad-route.ts');
    expect(violations.filter((v) => v.rule === 'scoped-store-only').length).toBeGreaterThanOrEqual(2);
  });
});
