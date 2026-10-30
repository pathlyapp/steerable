import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { autoAnswer, decisionFor, resolveApprovalRequest } from '../src/approve.js';
import { createCli } from '../src/cli.js';
import { cliText } from '../src/copy.js';
import { runHelp, tuiHelp } from '../src/help.js';
import { visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';
import { toolStatus } from '../src/tui/transcript.js';

describe('decisionFor', () => {
  const read = { policy: 'allow-read' as const, answerAsk: false };
  const deny = { policy: 'deny' as const, answerAsk: false };
  const all = { policy: 'allow-all' as const, answerAsk: true };
  const ask = { policy: 'ask' as const, answerAsk: false };

  it('covers every policy, mode, and surface', () => {
    expect(decisionFor(all, { mode: 'read' }, 'run')).toBe('allow_once');
    expect(decisionFor(all, { mode: 'destructive' }, 'tui')).toBe('allow_once');
    expect(decisionFor(all, {}, 'run')).toBe('allow_once');
    expect(decisionFor(read, { mode: 'read' }, 'run')).toBe('allow_once');
    expect(decisionFor(read, { mode: 'other' }, 'run')).toBe('deny_once');
    expect(decisionFor(read, { mode: 'destructive' }, 'tui')).toBe('prompt');
    expect(decisionFor(read, {}, 'run')).toBe('deny_once');
    expect(decisionFor(deny, { mode: 'read' }, 'run')).toBe('deny_once');
    expect(decisionFor(deny, { mode: 'read' }, 'tui')).toBe('deny_once');
    expect(decisionFor(ask, { mode: 'read' }, 'tui')).toBe('prompt');
    expect(resolveApprovalRequest(undefined, 'run')).toEqual({ policy: 'deny', answerAsk: false });
    expect(resolveApprovalRequest(undefined, 'tui')).toEqual({ policy: 'ask', answerAsk: false });
    expect(resolveApprovalRequest('allow-all', 'run')?.answerAsk).toBe(true);
    expect(resolveApprovalRequest('nope', 'run')).toBeNull();
  });

  it('fills every question from the command-line dictionary', () => {
    expect(autoAnswer([{ id: 'a' }, { id: 'b' }])).toEqual({
      a: cliText('ask.unattended'),
      b: cliText('ask.unattended'),
    });
  });
});

describe('run unattended output', () => {
  it('records approvals and ask answers in --json', async () => {
    const answers: unknown[] = [];
    const gate = deferred();
    let remaining = 2;
    const finish = () => {
      remaining -= 1;
      if (remaining === 0) gate.resolve();
    };
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          yield approval('delete_file', 'files', 'destructive');
          yield ask('继续吗', [{ id: 'q1' }]);
        },
        decideApproval: async () => {
          finish();
          return true;
        },
        answerAsk: async (_id, body) => {
          answers.push(body);
          finish();
          return true;
        },
        stream: async function* () {
          await gate.promise;
          yield { type: 'content', content: 'ok' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout.text()) as {
      autoAnswered: Array<{ kind: string; toolName?: string; decision?: string; prompt?: string }>;
    };
    expect(result.autoAnswered).toEqual([
      { kind: 'approval', toolName: 'delete_file', category: 'files', decision: 'allow_once' },
      { kind: 'ask_user', prompt: '继续吗' },
    ]);
    expect(answers).toEqual([{ answers: { q1: cliText('ask.unattended') } }]);
  });

  it('records a shell, egress, an external tool, and an ask for allow-all', async () => {
    const gate = deferred();
    let remaining = 4;
    const finish = () => {
      remaining -= 1;
      if (remaining === 0) gate.resolve();
    };
    const stdout = capture();
    const stderr = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--json', '--no-project'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          yield* fourRequests();
        },
        decideApproval: async () => {
          finish();
          return true;
        },
        answerAsk: async () => {
          finish();
          return true;
        },
        stream: async function* () {
          await gate.promise;
          yield { type: 'content', content: 'ok' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(0);
    expect(stderr.text()).toContain(cliText('cli.approveAllWarning'));
    const result = JSON.parse(stdout.text()) as {
      exitCode: number;
      autoAnswered: Array<{ kind: string; toolName?: string; category?: string; decision?: string; prompt?: string }>;
    };
    expect(result.exitCode).toBe(0);
    expect(result.autoAnswered).toEqual([
      { kind: 'approval', toolName: 'local_exec_shell', category: 'shell', decision: 'allow_once' },
      { kind: 'approval', toolName: 'network_egress', category: 'network_egress', decision: 'allow_once' },
      { kind: 'approval', toolName: 'browser_navigate', category: 'browser', decision: 'allow_once' },
      { kind: 'ask_user', prompt: '继续吗' },
    ]);
  });

  it('exits 3 and records a denied shell outside the project', async () => {
    const gate = deferred();
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          yield outsideShell();
        },
        decideApproval: async () => {
          gate.resolve();
          return true;
        },
        stream: async function* () {
          await gate.promise;
          yield { type: 'content', content: 'denied' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(3);
    const result = JSON.parse(stdout.text()) as {
      ok: boolean;
      exitCode: number;
      autoAnswered: Array<{ kind: string; toolName?: string; decision?: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.autoAnswered).toEqual([
      { kind: 'approval', toolName: 'local_exec_shell', category: 'shell', decision: 'deny_once' },
    ]);
  });

  it('allows a read tool and exits 3 when the outside shell is denied', async () => {
    const gate = deferred();
    let remaining = 2;
    const finish = () => {
      remaining -= 1;
      if (remaining === 0) gate.resolve();
    };
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-read', '--json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          yield approval('read_file', 'files', 'read');
          yield outsideShell();
        },
        decideApproval: async () => {
          finish();
          return true;
        },
        stream: async function* () {
          await gate.promise;
          yield { type: 'content', content: 'partial' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(3);
    const result = JSON.parse(stdout.text()) as {
      autoAnswered: Array<{ toolName?: string; decision?: string }>;
    };
    expect(result.autoAnswered).toEqual([
      { kind: 'approval', toolName: 'read_file', category: 'files', decision: 'allow_once' },
      { kind: 'approval', toolName: 'local_exec_shell', category: 'shell', decision: 'deny_once' },
    ]);
  });

  it.each(['allow-read', 'deny'] as const)('answers an ask with an empty object under %s', async (policy) => {
    const bodies: unknown[] = [];
    const gate = deferred();
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', policy, '--json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          yield ask('继续吗', [{ id: 'q1' }]);
        },
        answerAsk: async (_id, body) => {
          bodies.push(body);
          gate.resolve();
          return true;
        },
        stream: async function* () {
          await gate.promise;
          yield { type: 'content', content: 'ok' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(0);
    expect(bodies).toEqual([{}]);
    const result = JSON.parse(stdout.text()) as { ok: boolean; autoAnswered: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.autoAnswered).toEqual([]);
  });

  it('writes an auto_answered line for --stream-json', async () => {
    const gate = deferred();
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--stream-json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          yield approval('web_fetch', 'network_egress', 'other');
        },
        decideApproval: async () => {
          gate.resolve();
          return true;
        },
        stream: async function* () {
          await gate.promise;
          yield { type: 'content', content: 'ok' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(0);
    const lines = stdout.text().trim().split('\n').map((line) => JSON.parse(line) as { type?: string; toolName?: string });
    expect(lines.map((line) => line.type)).toContain('auto_answered');
    expect(lines.find((line) => line.type === 'auto_answered')).toMatchObject({
      kind: 'approval',
      toolName: 'web_fetch',
      category: 'network_egress',
      decision: 'allow_once',
    });
  });

  it('writes one auto_answered line for each of the four requests', async () => {
    const gate = deferred();
    let remaining = 4;
    const finish = () => {
      remaining -= 1;
      if (remaining === 0) gate.resolve();
    };
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--stream-json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          yield* fourRequests();
        },
        decideApproval: async () => {
          finish();
          return true;
        },
        answerAsk: async () => {
          finish();
          return true;
        },
        stream: async function* () {
          await gate.promise;
          yield { type: 'content', content: 'ok' } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(0);
    const lines = stdout.text().trim().split('\n').map((line) => JSON.parse(line) as { type?: string; toolName?: string; kind?: string });
    const answered = lines.filter((line) => line.type === 'auto_answered');
    expect(answered.map((line) => line.toolName ?? line.kind)).toEqual([
      'local_exec_shell',
      'network_egress',
      'browser_navigate',
      'ask_user',
    ]);
  });

  it('documents STEERABLE_APPROVAL=0 in run and tui help', () => {
    for (const help of [runHelp(), tuiHelp()]) {
      expect(help).toContain('STEERABLE_APPROVAL=0');
      expect(help).toContain('destructive');
      expect(help).toContain('--approve allow-all');
    }
  });
});

describe('tui unattended status', () => {
  it('keeps approval off, marks the tool, and returns to ask', async () => {
    const decisions: string[] = [];
    const gate = deferred();
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async (_id, kind) => {
        decisions.push(kind);
        return true;
      },
      stream: async function* () {
        await gate.promise;
        yield { type: 'tool_call', payload: { name: 'delete_file', arguments: {} } } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    expect(visibleText(session.render(80))).toContain(cliText('tui.approvalClosed'));
    events.push(approval('delete_file', 'files', 'destructive'));
    await waitFor(() => decisions.includes('allow_once'));
    gate.resolve();
    for (const char of 'go') session.handleInput(char);
    session.handleInput('\r');
    await session.settled();
    await waitFor(() => visibleText(session.render(80)).includes(cliText('tui.toolAuto')));
    expect(visibleText(session.render(80))).not.toContain('审批 delete_file');
    for (const char of '/permissions') session.handleInput(char);
    session.handleInput('\r');
    await session.settled();
    const after = visibleText(session.render(80));
    expect(after).not.toContain(cliText('tui.approvalClosed'));
    expect(after).toContain('权限 询问');
    events.push({
      channel: 'approval:request',
      payload: {
        requestId: 'delete_file-2',
        toolName: 'delete_file',
        category: 'files',
        mode: 'destructive',
      },
    });
    await waitFor(() => visibleText(session.render(80)).includes('审批 delete_file'));
    expect(decisions).toEqual(['allow_once']);
  });

  it('submits a bracketed paste and finishes without an approval row', async () => {
    const bodies: unknown[] = [];
    const decisions: string[] = [];
    const session = new AgentTui(client({
      decideApproval: async (_id, kind) => {
        decisions.push(kind);
        return true;
      },
      stream: async function* (_path, body) {
        bodies.push(body);
        yield { type: 'content', content: '写好了' } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    session.handleInput('\x1b[200~创建 hello.txt\x1b[201~');
    session.handleInput('\r');
    await session.settled();
    await waitFor(() => visibleText(session.render(80)).includes('写好了'));
    const screen = visibleText(session.render(80));
    expect(screen).toContain('user 创建 hello.txt');
    expect(screen).toContain(cliText('tui.approvalClosed'));
    expect(screen).not.toMatch(/审批 \S/);
    expect(screen).not.toContain('追问');
    expect(bodies).toEqual([expect.objectContaining({ message: '创建 hello.txt' })]);
    expect(decisions).toEqual([]);
  });

  it('auto-allows a read tool and still prompts for the rest', async () => {
    const decisions: string[] = [];
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async (_id, kind) => {
        decisions.push(kind);
        return true;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-read', answerAsk: false },
      onExit() {},
    });
    await session.open();
    expect(visibleText(session.render(80))).toContain(cliText('tui.approvalRead'));
    events.push(approval('browser_scroll', 'browser', 'read'));
    await waitFor(() => decisions.includes('allow_once'));
    events.push(approval('local_exec_shell', 'shell', 'destructive'));
    await waitFor(() => visibleText(session.render(80)).includes('审批 local_exec_shell'));
    expect(decisions).toEqual(['allow_once']);
  });

  it('shows an ask under allow-read instead of answering it', async () => {
    const answers: unknown[] = [];
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      answerAsk: async (_id, body) => {
        answers.push(body);
        return true;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-read', answerAsk: false },
      onExit() {},
    });
    await session.open();
    events.push(ask('继续吗', [{ id: 'q1' }]));
    await waitFor(() => visibleText(session.render(80)).includes('追问 继续吗'));
    expect(answers).toEqual([]);
  });

  it('shows the unattended answer on the ask line', async () => {
    const answers: unknown[] = [];
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      answerAsk: async (_id, body) => {
        answers.push(body);
        return true;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    events.push({
      channel: 'ask-user:request',
      payload: {
        requestId: 'ask-1',
        intro: '继续吗',
        questions: [
          { id: 'q1', text: '要不要同时改重试次数？' },
          { id: 'q2', text: '要不要记一条说明？' },
        ],
      },
    });
    await waitFor(() => visibleText(session.render(80)).includes(cliText('tui.toolAutoAnswer')));
    const folded = visibleText(session.render(80));
    expect(folded).toContain('继续吗');
    expect(folded).not.toContain('要不要同时改重试次数？');
    expect(folded).not.toContain(cliText('ask.unattended'));
    session.handleInput('\x0f');
    const screen = visibleText(session.render(80));
    expect(screen).toContain('问 要不要同时改重试次数？');
    expect(screen).toContain('问 要不要记一条说明？');
    expect(screen).toContain(`答 ${cliText('ask.unattended')}`);
    expect(answers).toEqual([{ answers: { q1: cliText('ask.unattended'), q2: cliText('ask.unattended') } }]);
  });

  it('answers a shell, egress, an external tool, and an ask without an approval row', async () => {
    const decisions: string[] = [];
    const answers: unknown[] = [];
    const gate = deferred();
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async (_id, kind) => {
        decisions.push(kind);
        if (decisions.length === 3) gate.resolve();
        return true;
      },
      answerAsk: async (_id, body) => {
        answers.push(body);
        return true;
      },
      stream: async function* () {
        await gate.promise;
        for (const name of ['local_exec_shell', 'network_egress', 'browser_navigate']) {
          yield { type: 'tool_call', payload: { name, arguments: {} } } as SSEEvent;
        }
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    for (const event of fourRequests()) events.push(event);
    await waitFor(() => decisions.length === 3 && answers.length === 1);
    for (const char of 'go') session.handleInput(char);
    session.handleInput('\r');
    await session.settled();
    await waitFor(() => visibleText(session.render(100)).split(cliText('tui.toolAuto')).length >= 4);
    const screen = visibleText(session.render(100));
    expect(screen).toContain(cliText('tui.approvalClosed'));
    expect(screen).not.toContain('审批 local_exec_shell');
    expect(screen).not.toContain('审批 network_egress');
    expect(screen).not.toContain('审批 browser_navigate');
    expect(screen).toContain(cliText('tui.toolAutoAnswer'));
    expect(screen).toContain('继续吗');
    expect(decisions).toEqual(['allow_once', 'allow_once', 'allow_once']);
    expect(answers).toEqual([{ answers: { q1: cliText('ask.unattended') } }]);
  });

  it('labels a tool covered by a session allow', () => {
    expect(toolStatus({
      tool: 'browser_click',
      success: true,
      approval: { kind: 'allow_for_session', cached: true },
    })).toBe(cliText('tui.toolSessionAllow'));
    expect(toolStatus({
      tool: 'browser_navigate',
      success: true,
      approval: { kind: 'allow_for_session', cached: false },
    })).toBe('✓');
  });
});

function approval(
  toolName: string,
  category: string,
  mode: string,
  extra: Record<string, unknown> = {},
): { channel: string; payload: unknown } {
  return {
    channel: 'approval:request',
    payload: { requestId: `${toolName}-1`, toolName, category, mode, ...extra },
  };
}

function outsideShell(): { channel: string; payload: unknown } {
  return approval('local_exec_shell', 'shell', 'destructive', {
    outsideWorkspace: true,
    arguments: { command: 'ls', cwd: '/tmp/outside' },
  });
}

function fourRequests(): Array<{ channel: string; payload: unknown }> {
  return [
    outsideShell(),
    approval('network_egress', 'network_egress', 'other'),
    approval('browser_navigate', 'browser', 'external'),
    ask('继续吗', [{ id: 'q1' }]),
  ];
}

function ask(prompt: string, questions: Array<{ id: string; text?: string }>): { channel: string; payload: unknown } {
  return { channel: 'ask-user:request', payload: { requestId: 'ask-1', prompt, questions } };
}

function client(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    lastStatus: 200,
    request: async () => ({ status: 200, data: { chatId: 'chat-1', chats: [], model: 'demo' } }),
    stream: async function* () {
      yield { type: 'content', content: 'ok' } as SSEEvent;
      yield { type: 'done' } as SSEEvent;
    },
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
    ...overrides,
  };
}

function queue(): {
  stream: AgentClient['events'];
  push: (event: { channel: string; payload: unknown }) => void;
} {
  const pending: Array<{ channel: string; payload: unknown }> = [];
  let notify: (() => void) | null = null;
  return {
    push(event) {
      pending.push(event);
      notify?.();
      notify = null;
    },
    stream: async function* () {
      for (;;) {
        while (pending.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        const event = pending.shift();
        if (event) yield event;
      }
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
