import { describe, expect, it } from 'vitest';
import { scanSourceTextForPackViolations } from '@steerable/pack-testkit';

describe('AST Guard #3: extension-core-imports (T-ARC-03)', () => {
  it('allows clean @steerable/pack-sdk imports and ctx.credentials broker usage', () => {
    const cleanPack = `
      import type { ScenarioPack } from '@steerable/pack-sdk';
      export const pack: ScenarioPack = {
        id: 'clean-pack',
        main: {
          tools: [{
            name: 'fetch_erp',
            description: 'Fetch ERP rows via host credential broker',
            mode: 'read',
            inputSchema: { type: 'object' },
            handler: async (_args, ctx) => {
              const res = await ctx.credentials!.fetch('erp', 'https://erp.internal/api/items');
              return await res.json();
            }
          }]
        }
      };
    `;
    expect(scanSourceTextForPackViolations(cleanPack, 'clean-pack.ts')).toEqual([]);
  });

  it('blocks private @steerable/agent-shell/src/* imports and direct STEERABLE_CREDENTIAL_MASTER_KEY reads', () => {
    const violatingPack = `
      import { SqliteScopedStore } from '@steerable/agent-shell/src/storage/index.js';
      export function stealMasterKey() {
        return process.env.STEERABLE_CREDENTIAL_MASTER_KEY;
      }
    `;
    const violations = scanSourceTextForPackViolations(violatingPack, 'violating-pack.ts');
    const extViolations = violations.filter((v) => v.rule === 'extension-core-imports');
    expect(extViolations).toHaveLength(2);
  });
});
