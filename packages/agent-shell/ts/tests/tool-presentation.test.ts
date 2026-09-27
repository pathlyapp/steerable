import { describe, expect, it } from 'vitest';

import { ToolRouter } from '../src/tool-router.js';
import { declaredToolNames, presentToolCall } from '../src/tool-presentation.js';

function wiredRouter(): ToolRouter {
  const router = new ToolRouter({} as never, { list: () => [] } as never);
  router.setTaskServices({ taskService: {} as never, worktreeService: {} as never });
  router.setWebTools(async () => ({}), ['web_search', 'web_fetch']);
  router.setPluginRpc(async () => ({}));
  return router;
}

describe('tool presentation', () => {
  it('declares a card for every built-in host tool', () => {
    const names = wiredRouter().listSchemas().map((schema) => schema.name);
    expect(names.length).toBeGreaterThanOrEqual(35);
    for (const name of names) {
      const view = presentToolCall(name, { command: 'pwd', path: 'a.ts', query: 'q', pattern: 'x' });
      expect(view.declared, name).toBe(true);
      expect(view.title.length, name).toBeGreaterThan(0);
    }
  });

  it('does not infer a card for an undeclared name', () => {
    expect(presentToolCall('get_weather', {})).toEqual({
      card: 'generic',
      kind: 'other',
      title: 'get_weather',
      declared: false,
    });
  });

  it('titles a shell call from its command and a search from its pattern', () => {
    expect(presentToolCall('local_exec_shell', { command: 'pytest -q' })).toMatchObject({
      card: 'terminal',
      kind: 'execute',
      title: 'pytest -q',
      declared: true,
    });
    expect(presentToolCall('grep', { pattern: 'presentToolCall' })).toMatchObject({
      card: 'search',
      kind: 'search',
      title: 'presentToolCall',
    });
    expect(presentToolCall('local_edit_file', { path: 'src/app.ts' })).toMatchObject({
      card: 'diff',
      kind: 'edit',
      title: 'src/app.ts',
    });
  });

  it('folds a web_search result count into the declared title', () => {
    const view = presentToolCall(
      'web_search',
      { query: 'steerable tools' },
      { success: true, data: { result_count: 3 } },
    );
    expect(view.card).toBe('web');
    expect(view.title).toContain('3 条结果');
  });

  it('covers the sidecar names the desktop table also declares', () => {
    for (const name of ['bash', 'read_file', 'edit_file', 'apply_patch', 'todo_write', 'delegate_subagent']) {
      expect(declaredToolNames()).toContain(name);
    }
  });

  it('clips a long command and keeps the declared card', () => {
    const view = presentToolCall('pwsh', { command: 'Get-Process '.repeat(20) });
    expect(view).toMatchObject({ card: 'terminal', kind: 'execute', declared: true });
    expect(view.title.endsWith('…')).toBe(true);
    expect(view.title.length).toBeLessThanOrEqual(60);
  });

  it('folds fetch status into the title and marks a blocked task', () => {
    const fetched = presentToolCall(
      'web_fetch',
      { url: 'https://example.com/docs' },
      { success: true, data: { status: 200, bytes: 2048 } },
    );
    expect(fetched.card).toBe('web');
    expect(fetched.title).toContain('example.com/docs');
    expect(fetched.title).toContain('200');
    expect(fetched.title).toContain('2.0 KB');

    expect(presentToolCall('task_run', { task: 'fix tests' }, { status: 'blocked' }).title)
      .toBe('fix tests · 等待依赖');
    expect(presentToolCall('job_kill', { job_id: '1117d5bf-de01-4b44' })).toMatchObject({
      kind: 'delete',
      title: '1117d5bf',
      declared: true,
    });
  });

  it('does not declare a card for a dynamic MCP name', () => {
    expect(presentToolCall('mcp__docs__search', { query: 'q' }).declared).toBe(false);
  });
});
