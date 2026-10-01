import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createCli } from '../src/cli.js';
import { deferred, TuiHarness } from './tui-harness.js';

describe('TUI acceptance edge cases', () => {
  const harnesses: TuiHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('TUI-001 routes a bare CLI invocation to the TUI entry point', async () => {
    let stderr = '';
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    stderrStream.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await createCli({
      argv: [],
      stdinIsTTY: false,
      stdout: stdoutStream,
      stderr: stderrStream,
    });
    expect(code).toBe(2);
    expect(stderr).toContain('tui needs a terminal');
    expect(stderr).toContain('Use run for piped input');
  });

  it('TUI-014 keeps fragmented bracketed-paste newlines in one submitted message', async () => {
    const sent: string[] = [];
    const harness = track(new TuiHarness({
      caseId: 'TUI-014',
      stream: async function* (_requestPath, body) {
        sent.push(String((body as { message?: string }).message ?? ''));
        yield { type: 'content', content: 'ok' };
      },
    }));
    await harness.open();

    harness.input('\x1b[200~line 1\r\n');
    harness.input('line 2\rline 3');
    harness.input('\x1b[201~');
    const draft = harness.screen();
    expect(draft).toContain('line 1');
    expect(draft).toContain('line 2');
    expect(draft).toContain('line 3');
    expect(sent).toEqual([]);

    harness.input('\r');
    await harness.waitForText('ok');
    expect(sent).toEqual(['line 1\nline 2\nline 3']);
  });

  it('TUI-027 recovers after a thrown stream error', async () => {
    let attempt = 0;
    const harness = track(new TuiHarness({
      caseId: 'TUI-027',
      stream: async function* () {
        attempt += 1;
        if (attempt === 1) throw new Error('provider unavailable');
        yield { type: 'content', content: 'recovered' };
      },
    }));
    await harness.open();

    harness.submit('first');
    const failed = await harness.waitForText('provider unavailable');
    expect(failed).toContain('user first');
    harness.submit('second');
    const recovered = await harness.waitForText('recovered');
    expect(recovered).toContain('user second');
    expect(attempt).toBe(2);
  });

  it('TUI-042 isolates the approval overlay from non-decision input', async () => {
    const harness = track(new TuiHarness({ caseId: 'TUI-042' }));
    await harness.open();
    harness.type('draft');
    harness.emit('approval:request', {
      requestId: 'approval-1',
      toolName: 'local_exec_shell',
      arguments: { command: 'rm -rf build' },
    });
    await harness.waitForText('审批 local_exec_shell');

    for (const input of ['x', '\t', '\r', '\x0c', '\x1b[102;6u', '\x1b[?1;2c']) {
      harness.input(input);
      expect(harness.screen()).toContain('审批 local_exec_shell');
      expect(harness.snapshot().draft).toBe('draft');
    }
    expect(harness.approvals).toEqual([]);
  });

  it('TUI-043 TUI-046 answers an ask without starting a normal chat turn', async () => {
    let streamCalls = 0;
    const harness = track(new TuiHarness({
      caseId: 'TUI-043',
      stream: async function* () {
        streamCalls += 1;
      },
      session: {
        writeClipboard: async () => {},
        editInEditor: async (text) => text,
      },
    }));
    await harness.open();
    harness.emit('ask-user:request', { requestId: 'ask-1', prompt: '选择环境' });
    await harness.waitForText('追问 选择环境');
    harness.type('生产环境');

    harness.input('\x0c');
    await harness.waitForText('会话');
    harness.input('\x1b');
    expect(harness.screen()).toContain('追问 选择环境');
    expect(harness.snapshot().draft).toBe('生产环境');
    harness.input('\x1bc');
    harness.input('\x1be');
    expect(harness.snapshot().draft).toBe('生产环境');

    harness.input('\r');
    await harness.waitFor((screen) => !screen.includes('追问 选择环境'), 'ask overlay to close');
    expect(harness.answers).toEqual([{ requestId: 'ask-1', answer: { text: '生产环境' } }]);
    expect(streamCalls).toBe(0);
  });

  it('TUI-045 keeps a failed approval available for retry', async () => {
    let attempts = 0;
    const harness = track(new TuiHarness({
      caseId: 'TUI-045',
      decideApproval: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('approval unavailable');
        return true;
      },
    }));
    await harness.open();
    harness.emit('approval:request', {
      requestId: 'approval-1',
      toolName: 'local_exec_shell',
      arguments: { command: 'echo ok' },
    });
    await harness.waitForText('审批 local_exec_shell');

    harness.input('y');
    const failed = await harness.waitForText('审批失败：approval unavailable');
    expect(failed).toContain('审批 local_exec_shell');
    harness.input('y');
    await harness.waitFor((screen) => !screen.includes('审批 local_exec_shell'), 'approval retry to close');
    expect(attempts).toBe(2);
  });

  it.each([
    ['y', 'allow_once'],
    ['s', 'allow_for_session'],
    ['a', 'allow_always'],
    ['n', 'deny_once'],
    ['N', 'deny_for_session'],
    ['A', 'deny_always'],
    ['\x1b', 'abort'],
  ] as const)('TUI-041 maps %j to %s exactly once', async (input, expected) => {
    const harness = track(new TuiHarness({ caseId: `TUI-041-${expected}` }));
    await harness.open();
    harness.emit('approval:request', {
      requestId: `approval-${expected}`,
      toolName: 'local_exec_shell',
      arguments: { command: 'echo ok' },
    });
    await harness.waitForText('审批 local_exec_shell');
    harness.input(input);
    await harness.waitFor(() => harness.approvals.length === 1, `decision ${expected}`);
    harness.input(input);
    expect(harness.approvals).toEqual([{
      requestId: `approval-${expected}`,
      kind: expected,
    }]);
  });

  it('TUI-052 becomes writable after a busy-session lock is released', async () => {
    const busy = ['chat-1'];
    let streamCalls = 0;
    const harness = track(new TuiHarness({
      caseId: 'TUI-052',
      chats: [{ id: 'chat-1', title: 'Notes' }],
      stream: async function* () {
        streamCalls += 1;
        yield { type: 'content', content: 'writable' };
      },
      session: { busyChatIds: busy },
    }));
    await harness.open();
    expect(harness.screen()).toContain('只读');
    busy.splice(0);

    harness.input('\x0c');
    await harness.waitFor(
      () => harness.snapshot().chats?.[0]?.busy === false,
      'released chat list',
    );
    harness.input('\r');
    await harness.waitFor((screen) => !screen.includes('只读'), 'writable chat');
    harness.submit('hello');
    await harness.waitForText('writable');
    expect(streamCalls).toBe(1);
  });

  it('TUI-054 TUI-056 refreshes an open chat list and preserves selection', async () => {
    const refreshed = deferred<{ status: number; data: unknown }>();
    let listCalls = 0;
    const harness = track(new TuiHarness({
      caseId: 'TUI-054',
      request: async (method, requestPath) => {
        if (requestPath === '/api/v2/local-settings/llm') {
          return { status: 200, data: { model: 'demo-model' } };
        }
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          listCalls += 1;
          if (listCalls === 1) {
            return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Notes' }] } };
          }
          return refreshed.promise;
        }
        if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
        if (requestPath.endsWith('/goal')) return { status: 200, data: { goal: null } };
        if (requestPath.endsWith('/loops')) return { status: 200, data: { loops: [] } };
        return { status: 200, data: { id: 'chat-1', title: 'Notes' } };
      },
    }));
    await harness.open();
    harness.input('\x0c');
    expect(harness.screen()).toContain('* chat-1');
    refreshed.resolve({
      status: 200,
      data: {
        chats: [
          { id: 'chat-1', title: 'Notes' },
          { id: 'chat-2', title: 'Build' },
        ],
      },
    });
    const screen = await harness.waitForText('chat-2');
    expect(screen).toContain('* chat-1');
  });

  it('TUI-066B TUI-066C reports attachment errors and removes a pending attachment', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-edge-files-'));
    try {
      await fs.mkdir(path.join(root, 'folder'));
      await fs.writeFile(path.join(root, 'notes.txt'), 'notes');
      const harness = track(new TuiHarness({
        caseId: 'TUI-066B',
        session: { cwd: root },
      }));
      await harness.open();

      harness.submit('/attach missing.txt');
      await harness.waitForText('找不到文件');
      harness.submit('/attach folder');
      await harness.waitForText('不是文件');
      harness.submit('/attach notes.txt');
      await harness.waitForText('附件 notes.txt');
      harness.input('\x7f');
      expect(harness.screen()).not.toContain('附件 notes.txt');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('TUI-066B retains a failed attachment and sends it after a successful retry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-attachment-retry-'));
    try {
      await fs.writeFile(path.join(root, 'notes.txt'), 'notes');
      let saves = 0;
      const sent: Array<{ message?: string }> = [];
      const harness = track(new TuiHarness({
        caseId: 'TUI-066B-retry',
        stream: async function* (_requestPath, body) {
          sent.push(body as { message?: string });
          yield { type: 'content', content: 'done' };
        },
        session: {
          cwd: root,
          saveAttachments: async (_chatId, files) => {
            saves += 1;
            if (saves === 1) {
              return files.map((file) => ({ name: file.name, path: '', error: 'copy failed' }));
            }
            return files.map((file) => ({ name: file.name, path: `/stored/${file.name}` }));
          },
        },
      }));
      await harness.open();
      harness.submit('/attach notes.txt');
      await harness.waitForText('附件 notes.txt');
      harness.submit('send');
      const failed = await harness.waitForText('copy failed');
      expect(failed).toContain('附件 notes.txt');

      harness.input('\r');
      await harness.waitFor((screen) => screen.includes('done') && !screen.includes('附件 notes.txt'), 'attachment retry');
      expect(saves).toBe(2);
      expect(sent[1]?.message).toContain('/stored/notes.txt');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('TUI-068 TUI-069 TUI-076 surfaces export, editor, and clipboard failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-command-errors-'));
    try {
      const notDirectory = path.join(root, 'file');
      await fs.writeFile(notDirectory, 'x');
      const harness = track(new TuiHarness({
        caseId: 'TUI-068-errors',
        stream: async function* () {
          yield { type: 'content', content: 'latest answer' };
        },
        session: {
          exportDir: notDirectory,
          writeClipboard: async () => {
            throw new Error('clipboard unavailable');
          },
          editInEditor: async () => {
            throw new Error('editor exited 1');
          },
        },
      }));
      await harness.open();
      harness.input('\x1bc');
      await harness.waitForText('没有可复制的回答');
      harness.submit('hello');
      await harness.waitForText('latest answer');
      harness.input('\x1bc');
      await harness.waitForText('剪贴板不可用');
      harness.input('\x1be');
      await harness.waitForText('编辑器不可用');
      harness.submit('/export');
      await harness.waitForText('命令失败：');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('TUI-062A TUI-062B TUI-062C TUI-062D distinguishes empty and failed panels', async () => {
    const harness = track(new TuiHarness({
      caseId: 'TUI-062A-errors',
      request: async (method, requestPath) => {
        if (requestPath === '/api/v2/local-settings/llm') {
          return { status: 200, data: { model: 'demo-model' } };
        }
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: 'Notes' }] } };
        }
        if (requestPath.endsWith('/messages')) return { status: 200, data: { messages: [] } };
        if (requestPath.endsWith('/goal')) return { status: 200, data: { goal: null } };
        if (requestPath.endsWith('/loops')) return { status: 200, data: { loops: [] } };
        if (requestPath === '/api/v2/usage/summary') return { status: 503, data: {} };
        if (requestPath === '/api/v2/chat-agents/skills') {
          return { status: 200, data: { skills: [] } };
        }
        if (requestPath === '/api/v2/mcp/servers') return { status: 503, data: {} };
        if (requestPath.endsWith('/tasks')) return { status: 503, data: {} };
        return { status: 200, data: { id: 'chat-1', title: 'Notes' } };
      },
    }));
    await harness.open();

    harness.submit('/status');
    await harness.waitForText('用量不可用');
    harness.submit('/skills');
    await harness.waitForText('没有技能');
    harness.submit('/mcp');
    await harness.waitForText('MCP 不可用 (503)');
    harness.submit('/tasks');
    await harness.waitForText('后台任务不可用 (503)');
  });

  it('TUI-078 rejects an unknown local command without sending it as chat', async () => {
    let streamCalls = 0;
    const harness = track(new TuiHarness({
      caseId: 'TUI-078',
      stream: async function* () {
        streamCalls += 1;
      },
    }));
    await harness.open();
    harness.submit('/does-not-exist');
    await harness.waitForText('unknown command /does-not-exist');
    expect(harness.screen()).not.toContain('user /does-not-exist');
    expect(streamCalls).toBe(0);
  });

  it('TUI-096 applies loop updates only to the current chat', async () => {
    const harness = track(new TuiHarness({
      caseId: 'TUI-096',
      chats: [{ id: 'chat-1', title: 'Notes' }],
    }));
    await harness.open();
    harness.emit('loop-changed', {
      chatId: 'chat-2',
      loops: [{ id: 'foreign', prompt: 'other', intervalSeconds: 60 }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.screen()).not.toContain('Loop');

    harness.emit('loop-changed', {
      chatId: 'chat-1',
      loops: [{ id: 'local', prompt: 'check', intervalSeconds: 60 }],
    });
    await harness.waitForText('Loop · 1 个运行中');
    harness.emit('loop-changed', { chatId: 'chat-1', loops: [] });
    await harness.waitFor((screen) => !screen.includes('Loop ·'), 'loop banner to disappear');
  });

  function track(harness: TuiHarness): TuiHarness {
    harnesses.push(harness);
    return harness;
  }
});
