import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPackTestHost, validatePackStaticGuards } from '../src/index.js';

describe('@steerable/pack-testkit', () => {
  it('enforces outward channel restrictions and non-idempotent outcome_unknown settlement', async () => {
    const host = createPackTestHost({
      pack: {
        id: 'demo-pack',
        label: 'Demo Pack',
        main: {
          tools: [
            {
              name: 'send_notice',
              description: 'Send external notice',
              inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' } } },
              mode: 'write',
              checkpoint: 'outward',
              idempotent: false,
              async handler(args) {
                if (args.target === 'timeout') {
                  throw new Error('upstream gateway timeout');
                }
                return { deliveredTo: args.target };
              },
            },
          ],
          dataSources: [
            {
              id: 'rows',
              description: 'Demo rows',
              async query() {
                return [{ id: 'r1', value: 42 }];
              },
            },
          ],
        },
      },
    });

    const blockedOnIm = await host.callTool('send_notice', { target: 'ops' }, { originChannel: 'im' });
    expect(blockedOnIm.ok).toBe(false);
    expect(blockedOnIm.error).toBe('outward_confirmation_required_in_workbench');

    const okOnWeb = await host.callTool('send_notice', { target: 'ops' }, { originChannel: 'web' });
    expect(okOnWeb).toEqual({ ok: true, result: { deliveredTo: 'ops' } });

    const snap = await host.queryDataSource('rows');
    expect(snap.sha256).toMatch(/^[a-f0-9]{64}$/);

    const unknownRes = await host.callTool('send_notice', { target: 'timeout' }, { originChannel: 'web' });
    expect(unknownRes.ok).toBe(false);
    expect(unknownRes.outcomeUnknown).toBe(true);
    expect(unknownRes.retryable).toBe(false);
    expect(unknownRes.reconciliationId).toBeTruthy();

    const lockedRetry = await host.callTool('send_notice', { target: 'ops' }, { originChannel: 'web' });
    expect(lockedRetry.ok).toBe(false);
    expect(lockedRetry.reconciliationId).toBe(unknownRes.reconciliationId);
  });

  it('catches forbidden driver imports, private host imports, and read-only mutations via AST guards', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pack-testkit-'));
    try {
      const badSrc = path.join(dir, 'bad-pack.ts');
      writeFileSync(
        badSrc,
        [
          `import Database from 'better-sqlite3';`,
          `import { internal } from '@steerable/agent-shell/src/host/runtime.js';`,
          `import { writeFileSync } from 'node:fs';`,
          `export const readTool = { mode: 'read', handler() { writeFileSync('/tmp/x', String(Database) + String(internal)); } };`,
        ].join('\n'),
        'utf8',
      );
      const report = validatePackStaticGuards(dir);
      expect(report.ok).toBe(false);
      expect(report.checkedFiles).toBe(1);
      expect(report.violations.some((v) => v.rule === 'scoped-store-only')).toBe(true);
      expect(report.violations.some((v) => v.rule === 'extension-core-imports')).toBe(true);
      expect(report.violations.some((v) => v.rule === 'read-only-purity')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
