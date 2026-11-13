import { describe, expect, it } from 'vitest';
import { toTurnTool } from '../src/local-backend/coreloop-stream.js';
import {
  ToolRouter,
  assertToolApproval,
} from '../src/tool-router.js';

function makeToolRouter(): ToolRouter {
  return new ToolRouter(
    {
      executeShell: async () => ({ success: true }),
      readLocalFile: async () => ({ success: true, content: '' }),
      writeLocalFile: async () => ({ success: true }),
      openLocalTarget: async () => ({ success: true }),
    } as never,
    { list: () => [], getById: () => null } as never,
  );
}

describe('tool approval declarations', () => {
  it('passes a pack approval spec through to the schema and the wire tool', () => {
    const router = makeToolRouter();
    router.registerToolContributions([
      {
        name: 'browser_scroll',
        description: 'Scroll the page',
        inputSchema: { type: 'object', properties: {} },
        mode: 'read',
        approval: {
          category: 'browser',
          label: { 'zh-CN': '浏览器操作', en: 'Browser actions' },
        },
        handler: async () => ({}),
      },
    ]);
    const schema = router.listSchemas().find((item) => item.name === 'browser_scroll');
    expect(schema?.approval?.category).toBe('browser');
    expect(toTurnTool(schema!)).toEqual({
      name: 'browser_scroll',
      description: 'Scroll the page',
      inputSchema: { type: 'object', properties: {} },
      mode: 'read',
      approvalCategory: 'browser',
    });
  });

  it('rejects a reserved or malformed approval category at assembly', () => {
    const router = makeToolRouter();
    expect(() => router.registerToolContributions([
      {
        name: 'browser_navigate',
        description: 'Open a page',
        inputSchema: { type: 'object', properties: {} },
        mode: 'external',
        approval: { category: 'network_egress', label: { en: 'Network' } },
        handler: async () => ({}),
      },
    ])).toThrow(/invalid approval category/);
    expect(() => assertToolApproval({
      name: 'bad',
      approval: { category: 'Browser', label: { en: 'Browser' } },
    })).toThrow(/invalid approval category/);
  });
});
