import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';
import { getNativeClipboard } from '@earendil-works/pi-tui';
import { createCli } from '../src/cli.js';
import { yieldsToRenderer } from '../src/tui/run.js';
import { pageScrollLines, transcriptEdge, transcriptPage } from '../src/tui/scroll.js';
import { searchHits } from '../src/tui/search.js';
import { formatUsage } from '../src/tui/usage.js';
import { applyChildEvent } from '../src/tui/children.js';
import { createDraft, editDraft } from '../src/tui/editor.js';
import { imageExtension } from '../src/tui/clipboard.js';
import { completeSlash, slashAt } from '../src/tui/commands.js';
import { attachmentMessage, completeFiles, mentionAt } from '../src/tui/files.js';
import { formatKey, installAgentKeybindings, keyLabel } from '../src/tui/keys.js';
import { composerRows, renderScreen, visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';
import { formatDuration, historyRows, plainMarkdown, toolStatus } from '../src/tui/transcript.js';

afterEach(() => {
  installAgentKeybindings();
});

describe('tui screen', () => {
  it('TUI-091 TUI-095 renders native goal state without a turn cap', () => {
    const active = visibleText(renderScreen({
      product: 'Demo',
      title: 'Goal',
      modelName: 'demo-model',
      lines: [],
      approval: null,
      ask: null,
      chats: null,
      readOnly: false,
      help: false,
      draft: '',
      cursor: 0,
      status: '',
      goal: { objective: '完整实现目标', phase: 'active', turns: 3 },
      loops: [{ id: 'l1', prompt: '检查构建', intervalSeconds: 300 }],
    }, 72));
    expect(active).toContain('目标 · 完整实现目标 · 第 3 轮');
    expect(active).toContain('Loop · 1 个运行中');

    const blocked = visibleText(renderScreen({
      product: 'Demo',
      title: 'Goal',
      modelName: 'demo-model',
      lines: [],
      approval: null,
      ask: null,
      chats: null,
      readOnly: false,
      help: false,
      draft: '',
      cursor: 0,
      status: '',
      goal: {
        objective: '完整实现目标',
        phase: 'blocked',
        turns: 3,
        blockedReason: '需要用户凭据',
      },
    }, 72));
    expect(blocked).toContain('目标 · 阻塞 · 完整实现目标 · 需要用户凭据');
  });

  it('TUI-030 TUI-040 TUI-051 renders a tool card, seven approval decisions, and a read-only chat', () => {
    const tool = visibleText(renderScreen({
      product: 'Demo',
      title: 'Notes',
      modelName: 'demo-model',
      lines: [
        { kind: 'user', text: '列出目录' },
        { kind: 'tool', name: 'local_exec_shell', args: 'ls -la', status: '✓ 0.3s' },
      ],
      approval: null,
      ask: null,
      chats: null,
      readOnly: false,
      help: false,
      draft: '',
      cursor: 0,
      status: '',
    }, 72));
    expect(tool).toContain('Demo · Notes · demo-model');
    expect(tool).toContain('▸ local_exec_shell  ls -la  ✓ 0.3s');

    const approval = visibleText(renderScreen({
      product: 'Demo',
      title: 'Notes',
      modelName: 'demo-model',
      lines: [],
      approval: { toolName: 'local_exec_shell', summary: 'rm -rf build' },
      ask: null,
      chats: null,
      readOnly: false,
      help: false,
      draft: '',
      cursor: 0,
      status: '',
    }, 72));
    expect(approval).toContain('审批 local_exec_shell rm -rf build');
    expect(approval).toContain('y 本次允许');
    expect(approval).toContain('s 本会话');
    expect(approval).toContain('a 总是');
    expect(approval).toContain('n 拒绝');
    expect(approval).toContain('N 本会话拒绝');
    expect(approval).toContain('A 总是拒绝');
    expect(approval).toContain(`${keyLabel('agent.approval.abort')} 中止`);

    const busy = visibleText(renderScreen({
      product: 'Demo',
      title: 'Build',
      modelName: 'demo-model',
      lines: [],
      approval: null,
      ask: null,
      chats: [
        { id: 'chat-1', title: 'Notes', busy: false, selected: false },
        { id: 'chat-2', title: 'Build', busy: true, selected: true },
      ],
      readOnly: true,
      help: false,
      draft: '',
      cursor: 0,
      status: '',
    }, 72));
    expect(busy).toContain('chat-2  Build  只读');
    expect(busy).toContain('只读 · 另一个进程正在运行');
  });

  it('TUI-011 TUI-080 lets the renderer see capability replies and treats shifted return as a newline', () => {
    expect(transcriptPage('\x1b[5~')).toBe(-1);
    expect(transcriptPage('\x1b[6~')).toBe(1);
    expect(transcriptPage('\r')).toBe(0);
    expect(transcriptEdge('\x1b[H')).toBe('top');
    expect(transcriptEdge('\x1b[F')).toBe('bottom');
    expect(transcriptEdge('\r')).toBeNull();
    const hits = searchHits(
      [{ kind: 'assistant', text: '先看目录' }, { kind: 'tool', name: 'local_exec_shell', args: 'ls', output: 'SECRET' }],
      'secret',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 1 });
    expect(hits[0]?.snippet).toContain('SECRET');
    expect(formatUsage({ totals: { turns: 3, totalTokens: 1200, costUsd: 0.02 } })).toBe('用量 3 回合 · 1200 token · $0.02');
    expect(pageScrollLines(24, -1)).toBe(-20);
    expect(pageScrollLines(2, 1)).toBe(1);
    expect(yieldsToRenderer('\x1b[?5u')).toBe(true);
    expect(yieldsToRenderer('\x1b[13;2u')).toBe(false);
    expect(yieldsToRenderer('\r')).toBe(false);
  });

  it('TUI-120 TUI-121 TUI-122 uses platform-specific key names', () => {
    expect(formatKey('ctrl+c', 'darwin')).toBe('Control+C');
    expect(formatKey('enter', 'darwin')).toBe('Return');
    expect(formatKey('shift+enter', 'darwin')).toBe('Shift+Return');
    expect(formatKey('escape', 'darwin')).toBe('Esc');
    expect(formatKey('y', 'darwin')).toBe('y');
    expect(formatKey('shift+n', 'darwin')).toBe('N');
    expect(formatKey('ctrl+c', 'linux')).toBe('Ctrl+C');
    expect(formatKey('enter', 'linux')).toBe('Enter');
    expect(formatKey('shift+enter', 'linux')).toBe('Shift+Enter');
    expect(formatKey('escape', 'win32')).toBe('Esc');
  });

  it('TUI-033 TUI-053 restores tool cards from a newest-first history', () => {
    const rows = historyRows([
      {
        role: 'assistant',
        content: '看完了',
        createdAt: '2026-09-29T02:00:00.000Z',
        messageMetadata: JSON.stringify({
          timeline: [
            { type: 'text', content: '先看目录' },
            { type: 'reasoning', content: 'hidden' },
            {
              type: 'tools',
              actions: [{
                id: 'c1',
                tool: 'local_exec_shell',
                arguments: { command: 'ls' },
                view: { title: 'ls' },
                success: true,
                durationMs: 300,
                result: { stdout: 'SECRET-LINE' },
              }],
            },
            { type: 'text', content: '看完了' },
          ],
        }),
      },
      { role: 'user', content: '列出', createdAt: '2026-09-29T01:00:00.000Z' },
    ]);
    expect(rows.map((row) => row.kind === 'tool' ? row.action.tool : row.text)).toEqual([
      '列出',
      '先看目录',
      'hidden',
      'local_exec_shell',
      '看完了',
    ]);
    const withChildren = historyRows([{
      role: 'assistant',
      content: 'done',
      messageMetadata: JSON.stringify({
        orchestrationChildEvents: [
          { kind: 'child_spawned', childId: 'c1', task: '查资料', profile: 'researcher', depth: 0 },
          { kind: 'child_completed', childId: 'c1' },
        ],
      }),
    }]);
    expect(withChildren.filter((row) => row.kind === 'tree').map((row) => row.kind === 'tree' ? row.text : '')).toEqual([
      '子任务 1/1',
      '✓ researcher  查资料  完成',
    ]);
  });

  it('TUI-093 renders internal wake messages as notices instead of user text', () => {
    expect(historyRows([
      {
        role: 'user',
        content: '<objective>secret prompt</objective>',
        messageMetadata: JSON.stringify({ internal: true, trigger: 'goal', sourceId: 'g1' }),
      },
      {
        role: 'user',
        content: 'check build',
        messageMetadata: JSON.stringify({ internal: true, trigger: 'loop', sourceId: 'l1' }),
      },
    ])).toEqual([
      { kind: 'tree', text: '目标续跑' },
      { kind: 'tree', text: 'Loop 触发' },
    ]);
  });

  it('TUI-022 TUI-031 TUI-123 strips markdown markers and formats a finished tool as one line', () => {
    expect(formatDuration(300)).toBe('0.3s');
    expect(toolStatus({})).toBe('…');
    expect(toolStatus({ success: true, durationMs: 300 })).toBe('✓ 0.3s');
    expect(plainMarkdown('# 结果\n\n**完成** `ls`\n```\nkeep\n```')).toBe('结果\n\n完成 ls\nkeep');
  });
});

describe('tui session', () => {
  it('TUI-004 TUI-041 answers an approval and aborts the next turn from the key table', async () => {
    const decisions: string[] = [];
    let releaseApproval: (kind: string) => void = () => {};
    const approvalDone = new Promise<string>((resolve) => {
      releaseApproval = resolve;
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    let pushEvent: (event: { channel: string; payload: unknown }) => void = () => {};
    const queued = new Promise<{ channel: string; payload: unknown }>((resolve) => {
      pushEvent = resolve;
    });
    const client = fakeClient({
      async *stream(_path, body, signal) {
        const message = String((body as { message?: string }).message ?? '');
        if (message.includes('hang')) {
          yield { type: 'content', content: 'running' } as SSEEvent;
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
          yield { type: 'error', message: 'interrupted' } as SSEEvent;
          return;
        }
        yield { type: 'tool_call', payload: { name: 'local_exec_shell', arguments: { command: 'ls' } } } as SSEEvent;
        pushEvent({
          channel: 'approval:request',
          payload: { requestId: 'req-1', toolName: 'local_exec_shell', arguments: { command: 'ls' } },
        });
        await approvalDone;
        yield { type: 'content', content: 'listed' } as SSEEvent;
      },
      async *events() {
        events.push(await queued);
        yield events[0];
      },
      async decideApproval(_id, kind) {
        decisions.push(kind);
        releaseApproval(kind);
        return true;
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, 'hello');
    await waitFor(() => visibleText(session.render(72)).includes('审批'));
    session.handleInput('y');
    await waitFor(() => visibleText(session.render(72)).includes('listed'));
    expect(decisions).toEqual(['allow_once']);
    expect(visibleText(session.render(72))).toContain('▸ local_exec_shell  ls');

    await typeLine(session, 'hang');
    await waitFor(() => visibleText(session.render(72)).includes('running'));
    session.handleInput('\x03');
    await waitFor(() => visibleText(session.render(72)).includes('已中断'));
  });

  it('TUI-016 uses a rebound interrupt key and leaves ctrl+c alone', async () => {
    installAgentKeybindings({ 'agent.interrupt': 'ctrl+x' });
    let exited = 0;
    const session = new AgentTui(fakeClient(), { product: 'Demo', onExit() { exited += 1; } });
    await session.open();
    session.handleInput('\x03');
    expect(exited).toBe(0);
    session.handleInput('\x18');
    expect(exited).toBe(1);
  });

  it('TUI-061A TUI-061B TUI-061C runs new, model, clear, and help commands', async () => {
    const calls: string[] = [];
    const session = new AgentTui(fakeClient({
      stream: async function* () {
        yield { type: 'content', content: 'old' } as SSEEvent;
      },
      request: async (method, requestPath, body) => {
        calls.push(`${method} ${requestPath}`);
        if (method === 'POST' && requestPath === '/api/v2/chats/new') {
          return { status: 200, data: { chatId: 'chat-new' } };
        }
        if (method === 'POST') return { status: 200, data: { ...(body as object), model: 'next-model' } };
        if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
        if (requestPath.startsWith('/api/v2/chats/')) return { status: 200, data: { id: 'chat-new', title: 'New' } };
        return { status: 200, data: { provider: 'openai-compat', model: 'demo-model', chats: [] } };
      },
    }), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, 'hello');
    await waitFor(() => visibleText(session.render(72)).includes('old'));
    await typeLine(session, '/clear');
    expect(visibleText(session.render(72))).not.toContain('old');
    await typeLine(session, '/help');
    expect(visibleText(session.render(72))).toContain('/model');
    session.handleInput('\x1b');
    await typeLine(session, '/model next-model');
    expect(visibleText(session.render(72))).toContain('next-model');
    await typeLine(session, '/new');
    expect(calls).toContain('POST /api/v2/chats/new');
    expect(visibleText(session.render(72))).toContain('New');
  });

  it('TUI-050 TUI-051 opens a busy chat as read-only', async () => {
    const session = new AgentTui(fakeClient({
      request: async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-2', title: 'Build' }] } };
        }
        if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
        if (requestPath.startsWith('/api/v2/chats/')) return { status: 200, data: { id: 'chat-2', title: 'Build' } };
        return { status: 200, data: { model: 'demo-model' } };
      },
    }), {
      product: 'Demo',
      busyChatIds: ['chat-2'],
      onExit() {},
    });
    await session.open();
    session.handleInput('\x0c');
    session.handleInput('\r');
    expect(visibleText(session.render(72))).toContain('只读 · 另一个进程正在运行');
    await typeLine(session, 'hello');
    expect(visibleText(session.render(72))).not.toContain('user hello');
  });

  it('TUI-010 TUI-020 TUI-021 paints each keystroke before enter', async () => {
    const painted: string[] = [];
    const session = new AgentTui(fakeClient(), {
      product: 'Demo',
      onExit() {},
      onChange() {
        painted.push(session.snapshot().draft);
      },
    });
    await session.open();
    painted.length = 0;
    session.handleInput('你');
    session.handleInput('好');
    expect(session.snapshot()).toMatchObject({ draft: '你好', cursor: 2 });
    expect(painted).toEqual(['你', '你好']);
    const screen = visibleText(session.render(72));
    expect(screen).toContain('你好');
    expect(screen).not.toContain('user 你好');
    session.handleInput('\x1b[D');
    session.handleInput('!');
    expect(session.snapshot().draft).toBe('你!好');
    session.handleInput('\x1b[C');
    session.handleInput('\n');
    expect(session.snapshot().draft).toBe('你!好\n');
    session.handleInput('\x1b[13;2u');
    session.handleInput('\x1b\r');
    expect(session.snapshot().draft).toBe('你!好\n\n\n');
    expect(composerRows(session.snapshot().draft, 40)).toBeGreaterThan(1);
    session.handleInput('\x1b[200~粘贴\x1b[201~');
    expect(session.snapshot().draft).toBe('你!好\n\n\n粘贴');
  });
});

describe('prompt history', () => {
  it('TUI-072A recalls sent lines with up and restores the draft with down', async () => {
    const session = new AgentTui(fakeClient(), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '先看目录');
    await typeLine(session, '再看文件');
    expect(session.snapshot().draft).toBe('');
    session.handleInput('\x1b[A');
    expect(session.snapshot()).toMatchObject({ draft: '再看文件', cursor: '再看文件'.length });
    session.handleInput('\x1b[A');
    expect(session.snapshot().draft).toBe('先看目录');
    session.handleInput('\x1b[B');
    expect(session.snapshot().draft).toBe('再看文件');
    session.handleInput('!');
    session.handleInput('\x1b[B');
    expect(session.snapshot().draft).toBe('再看文件!');
  });

  it('TUI-072B moves inside a multiline draft before recalling', async () => {
    const session = new AgentTui(fakeClient(), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '已发送');
    session.handleInput('a');
    session.handleInput('\n');
    session.handleInput('b');
    session.handleInput('\x1b[A');
    expect(session.snapshot()).toMatchObject({ draft: 'a\nb', cursor: 1 });
    session.handleInput('\x1b[A');
    expect(session.snapshot().draft).toBe('已发送');
  });

  it('TUI-016 TUI-072B recalls with a rebound history key inside a multiline draft', async () => {
    installAgentKeybindings({
      'tui.editor.historyPrevious': 'ctrl+p',
      'tui.editor.historyNext': 'ctrl+n',
    });
    const session = new AgentTui(fakeClient(), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '已发送');
    session.handleInput('a');
    session.handleInput('\n');
    session.handleInput('b');
    session.handleInput('\x10');
    expect(session.snapshot().draft).toBe('已发送');
    session.handleInput('\x0e');
    expect(session.snapshot().draft).toBe('a\nb');
  });
});

describe('slash commands', () => {
  it('TUI-060 lists registered commands and completes one with tab', async () => {
    expect(slashAt('/mo', 3)).toEqual({ start: 0, query: 'mo' });
    expect(slashAt('看 /mo', 5)).toBeNull();
    expect(completeSlash('a').map((pick) => pick.label)).toEqual(['/attach 附加文件']);
    const session = new AgentTui(fakeClient(), { product: 'Demo', onExit() {} });
    await session.open();
    session.handleInput('/');
    expect(session.snapshot().picks?.map((pick) => pick.label)).toEqual([
      '/new 新会话',
      '/model 查看或切换模型',
      '/attach 附加文件',
      '/clear 清屏',
      '/help 帮助',
      '/status 用量',
      '/skills 技能',
      '/mcp MCP',
      '/export 导出会话',
      '/compact 压缩上下文',
      '/plan 计划模式',
      '/goal 持续目标',
      '/loop 循环执行',
      '/tasks 后台任务',
      '/fork 分叉',
      '/rewind 回退',
      '/permissions 会话权限',
      '/copy 复制回答',
      '/editor 外部编辑器',
    ]);
    session.handleInput('a');
    session.handleInput('\t');
    expect(session.snapshot()).toMatchObject({ draft: '/attach ', picks: null });
    session.handleInput('\r');
    await waitFor(() => visibleText(session.render(72)).includes('用法 /attach'));
    expect(session.snapshot().draft).toBe('');
  });

  it('TUI-090 passes /goal and /loop through to their skills', async () => {
    const bodies: unknown[] = [];
    const session = new AgentTui(fakeClient({
      async *stream(_path, body) {
        bodies.push(body);
        yield { type: 'content', content: 'ok' } as SSEEvent;
      },
    }), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '/goal ship the release');
    await typeLine(session, '/loop 5m check CI');
    await waitFor(() => bodies.length === 2);
    expect(bodies).toEqual([
      { message: '/goal ship the release' },
      { message: '/loop 5m check CI' },
    ]);
  });

  it('TUI-091 TUI-095 routes goal and loop management commands to native endpoints', async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const client = fakeClient({
      request: async (method, requestPath, body) => {
        requests.push({ method, path: requestPath, body });
        if (requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Demo' }] } };
        }
        if (requestPath.endsWith('/goal') && method === 'GET') {
          return {
            status: 200,
            data: { goal: { objective: 'Ship', phase: 'paused', turns: 2 } },
          };
        }
        if (requestPath.endsWith('/goal') && method === 'POST') {
          return {
            status: 200,
            data: { goal: { objective: 'Ship better', phase: 'active', turns: 2 } },
          };
        }
        if (requestPath.endsWith('/loops')) {
          return {
            status: 200,
            data: {
              loops: [{
                id: 'loop-1',
                prompt: 'check CI',
                intervalSeconds: 60,
                terminalSessionId: 'terminal-1',
              }],
            },
          };
        }
        return { status: 200, data: {} };
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '/goal');
    await typeLine(session, '/goal edit Ship better');
    await typeLine(session, '/goal pause');
    await typeLine(session, '/loop list');
    await typeLine(session, '/loop stop loop-1');

    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'POST',
        path: '/api/v2/chats/chat-1/goal',
        body: { action: 'edit', objective: 'Ship better' },
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v2/chats/chat-1/goal',
        body: { action: 'pause' },
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: '/api/v2/chats/chat-1/loops/loop-1',
      }),
    ]));
    expect(session.snapshot().loops).toHaveLength(1);
  });

  it('TUI-095 warns once before exiting while a monitored loop is active', async () => {
    const onExit = vi.fn();
    const session = new AgentTui(fakeClient({
      request: async (_method, requestPath) => {
        if (requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Demo' }] } };
        }
        if (requestPath.endsWith('/loops')) {
          return {
            status: 200,
            data: {
              loops: [{
                id: 'loop-1',
                prompt: 'check CI',
                intervalSeconds: 60,
                terminalSessionId: 'terminal-1',
              }],
            },
          };
        }
        return { status: 200, data: {} };
      },
    }), { product: 'Demo', onExit });
    await session.open();
    session.handleInput('\x03');
    expect(onExit).not.toHaveBeenCalled();
    expect(session.snapshot().status).toContain('活动 Loop 会随本进程停止');
    session.handleInput('\x03');
    expect(onExit).toHaveBeenCalledOnce();
  });
});

describe('follow-up queue', () => {
  it('TUI-073 sends the next line only after the current turn finishes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const client = fakeClient({
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield { type: 'content', content: '先回答' } as SSEEvent;
          await gate;
          yield { type: 'content', content: '说完' } as SSEEvent;
          return;
        }
        yield { type: 'content', content: '下一轮' } as SSEEvent;
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '第一句');
    await waitFor(() => visibleText(session.render(72)).includes('先回答'));
    await typeLine(session, '第二句');
    const waiting = visibleText(session.render(72));
    expect(waiting).toContain('排队 第二句');
    expect(waiting).not.toContain('user 第二句');
    expect(calls).toBe(1);
    release();
    await waitFor(() => visibleText(session.render(72)).includes('下一轮'));
    const done = visibleText(session.render(72));
    expect(done).toContain('user 第二句');
    expect(done).not.toContain('排队');
    expect(calls).toBe(2);
  });

  it('TUI-074 drops a queued line when the turn is interrupted', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const client = fakeClient({
      async *stream() {
        calls += 1;
        yield { type: 'content', content: '先回答' } as SSEEvent;
        await gate;
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    try {
      await session.open();
      await typeLine(session, '第一句');
      await waitFor(() => visibleText(session.render(72)).includes('先回答'));
      await typeLine(session, '第二句');
      expect(visibleText(session.render(72))).toContain('排队 第二句');
      session.handleInput('\x03');
      expect(visibleText(session.render(72))).not.toContain('排队');
      expect(visibleText(session.render(72))).toContain('已中断');
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(visibleText(session.render(72))).not.toContain('user 第二句');
      expect(calls).toBe(1);
    } finally {
      release();
    }
  });
});

describe('backend-initiated turns', () => {
  it('TUI-092 TUI-094 attaches to a goal wake and reloads its persisted internal turn', async () => {
    const events: Array<{ channel: string; payload: unknown }> = [];
    let releaseEvent: (() => void) | null = null;
    let liveActive = false;
    let finished = false;
    const sent: string[] = [];
    const client = fakeClient({
      request: async (method, requestPath) => {
        if (requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Demo' }] } };
        }
        if (requestPath.endsWith('/live-stream')) {
          return {
            status: 200,
            data: liveActive
              ? { active: true, content: '后台正在继续' }
              : { active: false },
          };
        }
        if (requestPath.endsWith('/messages')) {
          return {
            status: 200,
            data: {
              messages: finished
                ? [
                    {
                      role: 'user',
                      content: '<objective>hidden</objective>',
                      messageMetadata: JSON.stringify({
                        internal: true,
                        trigger: 'goal',
                        sourceId: 'goal-1',
                      }),
                    },
                    { role: 'assistant', content: '目标继续完成' },
                  ]
                : [],
            },
          };
        }
        if (requestPath.endsWith('/goal')) {
          return {
            status: 200,
            data: { goal: { objective: 'Ship', phase: 'active', turns: finished ? 2 : 1 } },
          };
        }
        if (requestPath.endsWith('/loops')) return { status: 200, data: { loops: [] } };
        if (method === 'GET' && requestPath === '/api/v2/local-settings/llm') {
          return { status: 200, data: { model: 'demo-model' } };
        }
        return { status: 200, data: { title: 'Demo' } };
      },
      stream: async function* (_path, body) {
        sent.push(String((body as { message?: string }).message ?? ''));
        yield { type: 'content', content: '排队消息已发送' } as SSEEvent;
      },
      events: async function* () {
        while (true) {
          if (events.length === 0) {
            await new Promise<void>((resolve) => {
              releaseEvent = resolve;
            });
            releaseEvent = null;
          }
          const event = events.shift();
          if (event) yield event;
        }
      },
    });
    const session = new AgentTui(client, {
      product: 'Demo',
      onExit() {},
      liveIntervalMs: 5,
    });
    await session.open();

    liveActive = true;
    events.push({
      channel: 'chat-turn-started',
      payload: { chatId: 'chat-1', trigger: 'goal', sourceId: 'goal-1' },
    });
    releaseEvent?.();
    await waitFor(() => visibleText(session.render(72)).includes('后台正在继续'));
    await typeLine(session, '后台结束后发送');
    expect(visibleText(session.render(72))).toContain('排队 后台结束后发送');
    expect(sent).toEqual([]);

    liveActive = false;
    finished = true;
    events.push({
      channel: 'chat-turn-finished',
      payload: { chatId: 'chat-1', trigger: 'goal', status: 'completed' },
    });
    releaseEvent?.();
    await waitFor(() => visibleText(session.render(72)).includes('目标继续完成'));
    await waitFor(() => sent.includes('后台结束后发送'));
    const rendered = visibleText(session.render(72));
    expect(rendered).toContain('目标续跑');
    expect(rendered).not.toContain('<objective>hidden</objective>');
  });
});

describe('clipboard paste', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('TUI-067 attaches a pasted image and inserts clipboard text when there is no image', async () => {
    expect(imageExtension(png)).toBe('png');
    expect(imageExtension(new Uint8Array([1, 2, 3]))).toBeNull();
    const imageSession = new AgentTui(fakeClient(), {
      product: 'Demo',
      onExit() {},
      readClipboard: async () => ({ image: png }),
    });
    await imageSession.open();
    imageSession.handleInput('\x16');
    await waitFor(() => (imageSession.snapshot().attachments ?? []).length === 1);
    const name = imageSession.snapshot().attachments?.[0] ?? '';
    expect(name).toMatch(/^clipboard-[0-9a-f]+\.png$/);
    expect(imageSession.snapshot().status).toBe(`已附加 ${name}`);

    const textSession = new AgentTui(fakeClient(), {
      product: 'Demo',
      onExit() {},
      readClipboard: async () => ({ text: '贴上' }),
    });
    await textSession.open();
    textSession.handleInput('\x16');
    await waitFor(() => textSession.snapshot().draft === '贴上');
    expect(textSession.snapshot().attachments ?? []).toEqual([]);
  });
});

describe('composer', () => {
  it('TUI-012 edits by grapheme and by word from the key table', () => {
    const draft = createDraft();
    editDraft(draft, '👍');
    editDraft(draft, '\x7f');
    expect(draft).toEqual({ text: '', cursor: 0 });
    editDraft(draft, 'a');
    editDraft(draft, 'b');
    editDraft(draft, ' ');
    editDraft(draft, 'c');
    editDraft(draft, 'd');
    editDraft(draft, '\x17');
    expect(draft.text).toBe('ab ');
    editDraft(draft, '\x1b[D');
    editDraft(draft, '\x1b[D');
    editDraft(draft, '\x1b[D');
    editDraft(draft, 'x');
    expect(draft).toEqual({ text: 'xab ', cursor: 1 });
    editDraft(draft, '\x1b[A');
    expect(draft.cursor).toBe(1);
    editDraft(draft, '\n');
    editDraft(draft, 'z');
    editDraft(draft, '\x1b[A');
    expect(draft.text).toBe('x\nzab ');
    expect(draft.cursor).toBe(1);
    editDraft(draft, '\x1b[B');
    expect(draft.cursor).toBe(3);
  });
});

describe('files and sub-agents', () => {
  it('TUI-035 TUI-065 TUI-066A completes a path, attaches a file, and shows the child tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-files-'));
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src', 'notes.txt'), 'x');
      await fs.writeFile(path.join(root, 'picture.png'), 'x');
      expect((await completeFiles(root, '')).map((pick) => pick.label)).toEqual(['src/', 'picture.png']);
      expect(mentionAt('@src/no', '@src/no'.length)).toEqual({ start: 0, query: 'src/no' });
      expect(attachmentMessage('看这个', [{ path: '/stored/picture.png' }])).toContain('`/stored/picture.png`');
      const folded = applyChildEvent([], {
        kind: 'child_spawned',
        childId: 'c1',
        task: '查资料',
        profile: 'researcher',
        depth: 1,
      });
      expect(applyChildEvent(folded, { kind: 'child_completed', childId: 'c1' })[0]?.status).toBe('completed');

      const bodies: unknown[] = [];
      const session = new AgentTui(fakeClient({
        request: async (method, requestPath) => {
          if (method === 'POST' && requestPath === '/api/v2/chats/new') {
            return { status: 200, data: { chatId: 'chat-1' } };
          }
          return { status: 200, data: { chats: [], model: 'demo-model' } };
        },
        stream: async function* (_requestPath, body) {
          bodies.push(body);
          yield {
            type: 'orchestration_child',
            kind: 'child_spawned',
            childId: 'c1',
            task: '查资料',
            profile: 'researcher',
            depth: 1,
          } as SSEEvent;
          yield { type: 'orchestration_child', kind: 'child_completed', childId: 'c1' } as SSEEvent;
          yield { type: 'content', content: 'done' } as SSEEvent;
        },
      }), {
        product: 'Demo',
        cwd: root,
        saveAttachments: async (_chatId, files) => files.map((file) => ({
          name: file.name,
          path: `/stored/${file.name}`,
        })),
        onExit() {},
      });
      await session.open();
      session.handleInput('@');
      await waitFor(() => visibleText(session.render(72)).includes('src/'));
      session.handleInput('\t');
      await waitFor(() => visibleText(session.render(72)).includes('notes.txt'));
      session.handleInput('\t');
      expect(session.snapshot().draft).toBe('@src/notes.txt ');

      clearDraftFor(session);
      await typeLine(session, '/attach picture.png');
      await waitFor(() => visibleText(session.render(72)).includes('已附加 picture.png'));
      await typeLine(session, '看这个');
      await waitFor(() => visibleText(session.render(72)).includes('done'));
      const screen = visibleText(session.render(72));
      expect(screen).toContain('researcher');
      expect(screen).toContain('子任务 1/1');
      expect(screen).toContain('完成');
      const body = bodies[0] as { message?: string; images?: Array<{ path: string }> };
      expect(body.message).toContain('/stored/picture.png');
      expect(body.images?.[0]?.path).toBe('/stored/picture.png');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('TUI-033 TUI-037 shows saved legacy and rich tool cards when a chat opens', async () => {
    const client = fakeClient({
      request: async (_method, requestPath) => {
        if (requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Notes' }] } };
        }
        if (requestPath.endsWith('/messages')) {
          return {
            status: 200,
            data: {
              messages: [
                {
                  role: 'assistant',
                  content: '看完了',
                  createdAt: '2026-09-29T02:00:00.000Z',
                  messageMetadata: JSON.stringify({
                    timeline: [
                      { type: 'text', content: '先看目录' },
                      { type: 'reasoning', content: 'hidden' },
                      {
                        type: 'tools',
                        actions: [{
                          id: 'c1',
                          tool: 'local_exec_shell',
                          arguments: { command: 'ls' },
                          view: { title: 'ls' },
                          success: true,
                          durationMs: 300,
                          result: { stdout: 'SECRET-LINE' },
                        }],
                      },
                      { type: 'text', content: '看完了' },
                    ],
                  }),
                },
                { role: 'user', content: '列出', createdAt: '2026-09-29T01:00:00.000Z' },
              ],
            },
          };
        }
        return { status: 200, data: { id: 'chat-1', title: 'Notes', model: 'demo-model' } };
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    await session.open();
    const screen = visibleText(session.render(72));
    const userAt = screen.indexOf('user 列出');
    const toolAt = screen.indexOf('▸ local_exec_shell  ls  ✓ 0.3s');
    const answerAt = screen.indexOf('看完了');
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(userAt).toBeLessThan(screen.indexOf('先看目录'));
    expect(screen.indexOf('先看目录')).toBeLessThan(toolAt);
    expect(toolAt).toBeLessThan(answerAt);
    expect(screen).toContain('思考');
    expect(screen).not.toContain('hidden');
    expect(screen).not.toContain('SECRET-LINE');
    session.handleInput('\x0f');
    expect(visibleText(session.render(72))).toContain('SECRET-LINE');
  });

  it('TUI-023 keeps reasoning on one line until it is expanded', async () => {
    const client = fakeClient({
      async *stream() {
        yield { type: 'reasoning', content: '先想' } as SSEEvent;
        yield { type: 'reasoning', content: '清楚' } as SSEEvent;
        yield { type: 'content', content: '结果' } as SSEEvent;
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '想一下');
    await waitFor(() => visibleText(session.render(72)).includes('结果'));
    const folded = visibleText(session.render(72));
    expect(folded).toContain('思考');
    expect(folded).not.toContain('先想清楚');
    session.handleInput('\x0f');
    expect(visibleText(session.render(72))).toContain('先想清楚');
    session.handleInput('\x0f');
    expect(visibleText(session.render(72))).not.toContain('先想清楚');
  });

  it('TUI-032 TUI-034 keeps bounded tool output folded until expanded', async () => {
    const client = fakeClient({
      async *stream() {
        yield { type: 'content', content: '# 结果\n\n**完成**' } as SSEEvent;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'call-1',
            tool: 'local_exec_shell',
            arguments: { command: 'ls -la' },
            view: { title: 'ls -la' },
            success: true,
            durationMs: 300,
            result: { stdout: 'SECRET-LINE\nfile.txt' },
          }],
        } as SSEEvent;
      },
    });
    const session = new AgentTui(client, { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, 'list');
    await waitFor(() => visibleText(session.render(72)).includes('✓ 0.3s'));
    const folded = visibleText(session.render(72));
    expect(folded).toContain('▸ local_exec_shell  ls -la  ✓ 0.3s');
    expect(folded).toContain('结果');
    expect(folded).toContain('完成');
    expect(folded).not.toContain('**完成**');
    expect(folded).not.toContain('SECRET-LINE');
    session.handleInput('\x0f');
    expect(visibleText(session.render(72))).toContain('SECRET-LINE');
    session.handleInput('\x0f');
    expect(visibleText(session.render(72))).not.toContain('SECRET-LINE');
  });
});

describe('transcript tools', () => {
  it('TUI-070 TUI-071 searches, steps matches, and leaves the draft alone', async () => {
    const session = new AgentTui(fakeClient({
      async *stream(_path, body) {
        yield { type: 'content', content: `回声 ${String((body as { message?: string }).message ?? '')}` } as SSEEvent;
      },
    }), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '目录');
    await typeLine(session, '文件');
    await waitFor(() => visibleText(session.render(72)).includes('回声 文件'));
    session.handleInput('\x1b[102;6u');
    session.handleInput('回');
    session.handleInput('声');
    expect(visibleText(session.render(72))).toContain('搜索 回声  1/2');
    expect(session.snapshot().draft).toBe('');
    session.handleInput('\r');
    expect(visibleText(session.render(72))).toContain('搜索 回声  2/2');
    session.handleInput('\x1b[13;2u');
    expect(visibleText(session.render(72))).toContain('搜索 回声  1/2');
    session.handleInput('\x1b');
    expect(visibleText(session.render(72))).not.toContain('搜索 回声');
    await typeLine(session, '/help');
    expect(visibleText(session.render(72))).toContain('搜索记录');
  });

  it('TUI-025 jumps home and end through the rendered snapshot', async () => {
    const seen: Array<'top' | 'bottom' | null> = [];
    const session = new AgentTui(fakeClient(), {
      product: 'Demo',
      onExit() {},
      onChange() {
        seen.push(session.snapshot().scroll ?? null);
      },
    });
    await session.open();
    seen.length = 0;
    session.handleInput('\x1b[H');
    session.handleInput('\x1b[F');
    expect(seen).toEqual(['top', 'bottom']);
  });

  it('TUI-075 pulls a queued line back into an empty composer', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new AgentTui(fakeClient({
      async *stream() {
        yield { type: 'content', content: '先回答' } as SSEEvent;
        await gate;
      },
    }), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '第一句');
    await waitFor(() => visibleText(session.render(72)).includes('先回答'));
    await typeLine(session, '第二句');
    expect(visibleText(session.render(72))).toContain('排队 第二句');
    session.handleInput('\x1bp');
    expect(session.snapshot().draft).toBe('第二句');
    expect(visibleText(session.render(72))).toContain('已取回');
    expect(visibleText(session.render(72))).not.toContain('排队');
    release();
    await session.settled();
  });

  it('TUI-032 TUI-069 TUI-076 copies a reply, uses an editor, and shows a diff', async () => {
    const copied: string[] = [];
    const session = new AgentTui(fakeClient({
      async *stream() {
        yield { type: 'content', content: '可以复制' } as SSEEvent;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'edit-1',
            tool: 'local_edit_file',
            arguments: { path: 'a.txt' },
            view: { title: 'a.txt' },
            success: true,
            durationMs: 10,
            result: { diff: '--- a\n+++ b\n-old\n+new line' },
          }],
        } as SSEEvent;
      },
    }), {
      product: 'Demo',
      onExit() {},
      writeClipboard: async (text) => {
        copied.push(text);
      },
      editInEditor: async () => '改过的草稿',
    });
    await session.open();
    await typeLine(session, '改文件');
    await waitFor(() => visibleText(session.render(72)).includes('a.txt'));
    session.handleInput('\x1bc');
    await waitFor(() => visibleText(session.render(72)).includes('已复制'));
    expect(copied).toEqual(['可以复制']);
    const folded = visibleText(session.render(72));
    expect(folded).not.toContain('+new line');
    session.handleInput('\x0f');
    expect(visibleText(session.render(72))).toContain('+new line');
    session.handleInput('\x1be');
    await waitFor(() => session.snapshot().draft === '改过的草稿');
  });

  it('TUI-062A TUI-062B TUI-062C TUI-062D TUI-062E TUI-068 lists panels and exports the chat', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-export-'));
    const session = new AgentTui(chatClient({
      '/usage/summary': { totals: { turns: 3, totalTokens: 1200, costUsd: 0.02 } },
      '/chat-agents/skills': { skills: [{ name: 'review', description: '看代码' }] },
      '/mcp/servers': { servers: [{ name: 'files', toolCount: 2 }] },
      '/tasks': { tasks: [{ task: '跑测试', status: 'running' }] },
    }), { product: 'Demo', exportDir: dir, onExit() {} });
    await session.open();
    await typeLine(session, '/status');
    await waitFor(() => visibleText(session.render(72)).includes('用量 3 回合 · 1200 token · $0.02'));
    await typeLine(session, '/skills');
    await waitFor(() => visibleText(session.render(72)).includes('技能 review  看代码'));
    await typeLine(session, '/mcp');
    await waitFor(() => visibleText(session.render(72)).includes('MCP files  2 个工具'));
    await typeLine(session, '/tasks');
    await waitFor(() => visibleText(session.render(72)).includes('后台 跑测试  进行中'));
    await typeLine(session, 'hello');
    await typeLine(session, '/export');
    await waitFor(() => visibleText(session.render(72)).includes('已导出'));
    const written = await fs.readFile(path.join(dir, 'chat-1.md'), 'utf8');
    expect(written).toContain('## user');
    expect(written).toContain('hello');
  });

  it('TUI-055 TUI-063A TUI-063B follows a live turn, compacts, forks, and rewinds', async () => {
    let liveCalls = 0;
    const session = new AgentTui(fakeClient({
      request: async (method, requestPath) => {
        if (requestPath.endsWith('/live-stream')) {
          liveCalls += 1;
          if (liveCalls === 1) return { status: 200, data: { active: true, content: '写到一半' } };
          return { status: 200, data: { active: false } };
        }
        if (method === 'POST' && requestPath.endsWith('/compact')) return { status: 200, data: { compacted: 2 } };
        if (method === 'POST' && requestPath.endsWith('/fork')) return { status: 200, data: { chatId: 'chat-fork' } };
        if (method === 'POST' && requestPath.endsWith('/rewind')) return { status: 200, data: { removed: 1 } };
        if (requestPath.endsWith('/messages')) {
          if (requestPath.includes('chat-fork')) return { status: 200, data: { messages: [{ role: 'user', content: '分叉过来', createdAt: '1' }] } };
          if (liveCalls > 1 && requestPath.includes('rewind') === false) {
            return { status: 200, data: { messages: [{ role: 'assistant', content: '已压缩 2 条', createdAt: '1' }] } };
          }
          return { status: 200, data: { messages: [] } };
        }
        if (requestPath.includes('chat-fork')) return { status: 200, data: { id: 'chat-fork', title: '分叉' } };
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Notes' }] } };
        }
        if (requestPath.startsWith('/api/v2/chats/')) return { status: 200, data: { id: 'chat-1', title: 'Notes' } };
        return { status: 200, data: { model: 'demo-model' } };
      },
    }), { product: 'Demo', liveIntervalMs: 15, onExit() {} });
    await session.open();
    await waitFor(() => visibleText(session.render(72)).includes('写到一半'));
    await waitFor(() => !visibleText(session.render(72)).includes('运行中'));
    await typeLine(session, '/compact');
    await waitFor(() => visibleText(session.render(72)).includes('已压缩 2 条'));
    await typeLine(session, '/fork');
    await waitFor(() => visibleText(session.render(72)).includes('分叉过来'));
    expect(visibleText(session.render(72))).toContain('已分叉');
    await typeLine(session, '/rewind');
    await waitFor(() => visibleText(session.render(72)).includes('已回退'));
  });

  it('TUI-036 TUI-044 TUI-064A sends plan mode, lists todos, and cycles permission', async () => {
    const bodies: unknown[] = [];
    const decisions: string[] = [];
    let pushEvent: (event: { channel: string; payload: unknown }) => void = () => {};
    const queued = new Promise<{ channel: string; payload: unknown }>((resolve) => {
      pushEvent = resolve;
    });
    const session = new AgentTui(fakeClient({
      async *stream(_path, body) {
        bodies.push(body);
        yield {
          type: 'executed_actions',
          actions: [{
            tool: 'todo_write',
            arguments: { todos: [{ content: '写测试', status: 'in_progress' }, { content: '补实现', status: 'pending' }] },
          }],
        } as SSEEvent;
        yield { type: 'content', content: '按计划来' } as SSEEvent;
      },
      async *events() {
        yield await queued;
      },
      async decideApproval(_id, kind) {
        decisions.push(kind);
        return true;
      },
    }), { product: 'Demo', onExit() {} });
    await session.open();
    await typeLine(session, '/plan');
    expect(visibleText(session.render(72))).toContain('模式 计划');
    await typeLine(session, '做个方案');
    await waitFor(() => visibleText(session.render(72)).includes('▸ 写测试'));
    expect(visibleText(session.render(72))).toContain('○ 补实现');
    expect(bodies[0]).toMatchObject({ mode: 'plan', message: '做个方案' });
    await typeLine(session, '/permissions');
    expect(visibleText(session.render(72))).toContain('权限 本会话自动');
    pushEvent({
      channel: 'approval:request',
      payload: { requestId: 'req-9', toolName: 'local_exec_shell', arguments: { command: 'ls' } },
    });
    await waitFor(() => decisions.includes('allow_for_session'));
    expect(visibleText(session.render(72))).not.toContain('审批');
    await typeLine(session, '/permissions');
    await typeLine(session, '不该发出去');
    expect(visibleText(session.render(72))).toContain('权限 只读');
    expect(visibleText(session.render(72))).not.toContain('user 不该发出去');
  });
});

describe('tui command', () => {
  it('TUI-002 refuses to start when stdin is not a terminal', async () => {
    const stderr = capture();
    const code = await createCli({
      argv: ['tui'],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: false,
      createClient: async () => fakeClient(),
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('run');
  });

  it('TUI-067 reports an unavailable native clipboard helper without throwing', () => {
    expect(() => getNativeClipboard()).not.toThrow();
  });
});

function chatClient(routes: Record<string, unknown>): AgentClient {
  return fakeClient({
    request: async (method, requestPath) => {
      for (const [suffix, data] of Object.entries(routes)) {
        if (requestPath.endsWith(suffix)) return { status: 200, data };
      }
      if (method === 'GET' && requestPath === '/api/v2/chats') {
        return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Notes' }] } };
      }
      if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
      if (requestPath.startsWith('/api/v2/chats/')) return { status: 200, data: { id: 'chat-1', title: 'Notes' } };
      return { status: 200, data: { model: 'demo-model', chats: [] } };
    },
    async *stream() {
      yield { type: 'content', content: 'ok' } as SSEEvent;
    },
  });
}

function fakeClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    lastStatus: 200,
    request: async () => ({ status: 200, data: { chats: [], model: 'demo-model' } }),
    stream: async function* () {},
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
    ...overrides,
  };
}

function clearDraftFor(session: AgentTui): void {
  const draft = session.snapshot().draft;
  for (let index = 0; index < [...draft].length; index += 1) session.handleInput('\x7f');
}

async function typeLine(session: AgentTui, text: string): Promise<void> {
  for (const char of text) session.handleInput(char);
  session.handleInput('\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('timed out waiting for the tui');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function capture(): { stream: Writable; text: () => string } {
  let body = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { stream, text: () => body };
}
