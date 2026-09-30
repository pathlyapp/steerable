import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoalStore } from '../src/goal-store.js';
import { ToolRouter } from '../src/tool-router.js';
import type { LocalExecRequest } from '../src/local-executor.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'steerable-parity-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function routerAt(root: string): ToolRouter {
  const router = new ToolRouter({} as never, { list: () => [] } as never);
  router.setGoalStore(new GoalStore(path.join(root, 'goals.json')));
  return router;
}

describe('host parity tools', () => {
  it('lists grep, glob, pwsh, and the goal tools without a task service', () => {
    const names = routerAt(scratch()).listSchemas().map((schema) => schema.name);
    expect(names).toEqual(expect.arrayContaining([
      'grep',
      'glob',
      'pwsh',
      'get_goal',
      'create_goal',
      'update_goal',
    ]));
    expect(names).not.toContain('job_list');
  });

  it('lists job tools only after the task service is wired', () => {
    const router = routerAt(scratch());
    router.setTaskServices({ taskService: {} as never, worktreeService: {} as never });
    const names = router.listSchemas().map((schema) => schema.name);
    expect(names).toEqual(expect.arrayContaining(['job_list', 'job_output', 'job_kill', 'task_run']));
  });

  it('lists and executes loop tools only after a PTY monitor is wired', async () => {
    const router = routerAt(scratch());
    expect(router.listSchemas().map((schema) => schema.name)).not.toContain('loop_create');

    const loop = {
      id: 'loop-1',
      chatId: 'chat-1',
      terminalSessionId: 'terminal-1',
      prompt: 'check build',
      intervalSeconds: 5,
    };
    const monitor = {
      start: vi.fn(() => loop),
      list: vi.fn((chatId?: string) => chatId === undefined || chatId === loop.chatId ? [loop] : []),
      stop: vi.fn(() => true),
    };
    router.setLoopMonitor(monitor);
    expect(router.listSchemas().map((schema) => schema.name)).toEqual(
      expect.arrayContaining(['loop_create', 'loop_list', 'loop_stop']),
    );
    expect(await router.execute(
      { name: 'loop_create', arguments: { prompt: 'check build', intervalSeconds: 5 } },
      { chatId: 'chat-1', projectRoot: '/tmp/project' },
    )).toMatchObject({ success: true, loop: { id: 'loop-1' } });
    expect(monitor.start).toHaveBeenCalledWith({
      chatId: 'chat-1',
      prompt: 'check build',
      intervalSeconds: 5,
      cwd: '/tmp/project',
    });
    expect(await router.execute(
      { name: 'loop_list', arguments: {} },
      { chatId: 'chat-1' },
    )).toEqual({ success: true, loops: [loop] });
    expect(await router.execute(
      { name: 'loop_stop', arguments: { id: 'loop-1' } },
      { chatId: 'chat-1' },
    )).toEqual({ success: true });
    expect(await router.execute(
      { name: 'loop_stop', arguments: { id: 'loop-1' } },
      { chatId: 'chat-2' },
    )).toEqual({ success: false, error: 'loop not found', needsFollowup: true });
    expect(monitor.stop).toHaveBeenCalledOnce();
  });

  it('grep stays inside the project and goal updates check the revision', async () => {
    const root = scratch();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'note.txt'), 'alpha\n');
    const router = routerAt(root);

    const hits = await router.execute(
      { name: 'grep', arguments: { pattern: 'alpha' } },
      { projectRoot: root, chatId: 'chat-1' },
    );
    expect(hits).toMatchObject({
      success: true,
      matches: [{ path: 'src/note.txt', line: 1 }],
    });

    const outside = await router.execute(
      { name: 'grep', arguments: { pattern: 'x', path: path.dirname(root) } },
      { projectRoot: root, chatId: 'chat-1' },
    );
    expect(outside).toMatchObject({ success: false });

    const missing = await router.execute(
      { name: 'get_goal', arguments: {} },
      { chatId: 'chat-1' },
    );
    expect(missing).toMatchObject({ success: true, goal: null });

    const created = await router.execute(
      { name: 'create_goal', arguments: { objective: 'Ship the tool list' } },
      { chatId: 'chat-1' },
    ) as { success: boolean; goal: { id: string; revision: number } };
    expect(created.success).toBe(true);

    const stale = await router.execute(
      {
        name: 'update_goal',
        arguments: { id: created.goal.id, revision: 0, action: 'complete' },
      },
      { chatId: 'chat-1' },
    );
    expect(stale).toMatchObject({ success: false, needsFollowup: true });

    const done = await router.execute(
      {
        name: 'update_goal',
        arguments: { id: created.goal.id, revision: created.goal.revision, action: 'complete' },
      },
      { chatId: 'chat-1' },
    );
    expect(done).toMatchObject({ success: true, goal: { phase: 'complete', revision: 2 } });
  });

  it('goal tools without a chat id ask for follow-up instead of throwing', async () => {
    const result = await routerAt(scratch()).execute(
      { name: 'get_goal', arguments: {} },
      {},
    );
    expect(result).toMatchObject({ success: false, needsFollowup: true });
  });

  it('pwsh wraps the script for the platform shell and refuses an empty command', async () => {
    const calls: LocalExecRequest[] = [];
    const router = new ToolRouter(
      {} as never,
      { list: () => [] } as never,
      async (request) => {
        calls.push(request);
        return { success: true, stdout: 'ok', exitCode: 0 };
      },
    );
    const empty = await router.execute({ name: 'pwsh', arguments: { command: '  ' } });
    expect(empty).toMatchObject({ success: false, needsFollowup: true });
    expect(calls).toHaveLength(0);

    const ran = await router.execute({ name: 'pwsh', arguments: { command: 'Get-Date' } });
    expect(ran).toMatchObject({ success: true, stdout: 'ok' });
    expect(calls).toHaveLength(1);
    if (process.platform === 'win32') {
      expect(calls[0]).toMatchObject({ command: 'Get-Date', shell: 'powershell' });
    } else {
      expect(calls[0].command).toBe('pwsh -NoProfile -NonInteractive -Command "Get-Date"');
      expect(calls[0].shell).toBeUndefined();
    }
  });

  it('job tools delegate to the task service and copy taskId onto job_id', async () => {
    const router = routerAt(scratch());
    const status = vi.fn(async () => ({
      success: true,
      total: 1,
      tasks: [{ taskId: 'abc-123', status: 'running', task: '背景' }],
    }));
    const result = vi.fn(async () => ({ success: false, needsFollowup: true }));
    const kill = vi.fn(async () => ({ success: true, killed: true, job_id: 'abc-123' }));
    router.setTaskServices({
      taskService: { status, result, kill } as never,
      worktreeService: {} as never,
    });

    const listed = await router.execute(
      { name: 'job_list', arguments: {} },
      { chatId: 'chat-1' },
    );
    expect(listed).toMatchObject({
      total: 1,
      jobs: [{ taskId: 'abc-123', job_id: 'abc-123' }],
    });

    await router.execute(
      { name: 'job_output', arguments: { job_id: 'abc-123' } },
      { chatId: 'chat-1' },
    );
    expect(result).toHaveBeenCalledWith('chat-1', 'abc-123');

    await router.execute(
      { name: 'job_kill', arguments: { job_id: 'abc-123', reason: '停掉' } },
      { chatId: 'chat-1' },
    );
    expect(kill).toHaveBeenCalledWith('chat-1', 'abc-123', '停掉');

    expect(await router.execute(
      { name: 'job_output', arguments: {} },
      { chatId: 'chat-1' },
    )).toMatchObject({ success: false, needsFollowup: true });

    await expect(router.execute({ name: 'job_list', arguments: {} }, {})).rejects.toThrow('chatId');
  });
});
