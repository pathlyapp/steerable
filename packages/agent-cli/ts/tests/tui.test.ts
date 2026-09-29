import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';
import { getNativeClipboard } from '@earendil-works/pi-tui';
import { createCli } from '../src/cli.js';
import { yieldsToRenderer } from '../src/tui/run.js';
import { pageScrollLines, transcriptPage } from '../src/tui/scroll.js';
import { applyChildEvent } from '../src/tui/children.js';
import { createDraft, editDraft } from '../src/tui/editor.js';
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
  it('renders a tool card, the seven approval decisions, and a read-only occupied chat', () => {
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

  it('lets the renderer see capability replies and treats shifted return as a newline', () => {
    expect(transcriptPage('\x1b[5~')).toBe(-1);
    expect(transcriptPage('\x1b[6~')).toBe(1);
    expect(transcriptPage('\r')).toBe(0);
    expect(pageScrollLines(24, -1)).toBe(-20);
    expect(pageScrollLines(2, 1)).toBe(1);
    expect(yieldsToRenderer('\x1b[?5u')).toBe(true);
    expect(yieldsToRenderer('\x1b[13;2u')).toBe(false);
    expect(yieldsToRenderer('\r')).toBe(false);
  });

  it('uses mac key names on darwin and pc names on other platforms', () => {
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

  it('restores tool cards from a newest-first history', () => {
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

  it('strips markdown markers and formats a finished tool as one line', () => {
    expect(formatDuration(300)).toBe('0.3s');
    expect(toolStatus({})).toBe('…');
    expect(toolStatus({ success: true, durationMs: 300 })).toBe('✓ 0.3s');
    expect(plainMarkdown('# 结果\n\n**完成** `ls`\n```\nkeep\n```')).toBe('结果\n\n完成 ls\nkeep');
  });
});

describe('tui session', () => {
  it('answers an approval and aborts the next turn from the key table', async () => {
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

  it('uses a rebound interrupt key and leaves ctrl+c alone', async () => {
    installAgentKeybindings({ 'agent.interrupt': 'ctrl+x' });
    let exited = 0;
    const session = new AgentTui(fakeClient(), { product: 'Demo', onExit() { exited += 1; } });
    await session.open();
    session.handleInput('\x03');
    expect(exited).toBe(0);
    session.handleInput('\x18');
    expect(exited).toBe(1);
  });

  it('runs slash commands for a new chat, the model, clearing, and help', async () => {
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

  it('opens a busy chat as read-only', async () => {
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

  it('paints each keystroke before enter', async () => {
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
  it('recalls sent lines with up and restores the draft with down', async () => {
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

  it('moves inside a multiline draft before recalling', async () => {
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

  it('recalls with historyPrevious when the caret is not on the first line', async () => {
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
  it('lists the commands that already exist and completes one with tab', async () => {
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
    ]);
    session.handleInput('a');
    session.handleInput('\t');
    expect(session.snapshot()).toMatchObject({ draft: '/attach ', picks: null });
    session.handleInput('\r');
    await waitFor(() => visibleText(session.render(72)).includes('用法 /attach'));
    expect(session.snapshot().draft).toBe('');
  });
});

describe('follow-up queue', () => {
  it('sends the next line only after the current turn finishes', async () => {
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

  it('drops a queued line when the turn is interrupted', async () => {
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

describe('composer', () => {
  it('edits by grapheme and by word from the key table', () => {
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
  it('completes an @ path, attaches a file, and shows the child tree', async () => {
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

  it('shows saved tool cards when a chat opens', async () => {
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

  it('keeps reasoning on one line until it is expanded', async () => {
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

  it('keeps a finished tool on one line until it is expanded', async () => {
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

describe('tui command', () => {
  it('refuses to start when stdin is not a terminal', async () => {
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

  it('loads the clipboard helper without throwing when the native module is missing', () => {
    expect(() => getNativeClipboard()).not.toThrow();
  });
});

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
