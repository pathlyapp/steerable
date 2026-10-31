import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { autoAnswer, decisionFor, resolveApprovalRequest, UNATTENDED_APPROVAL_REASON } from '../src/approve.js';
import { createCli } from '../src/cli.js';
import { runTurn } from '../src/run.js';
import { cliText } from '../src/copy.js';
import { runHelp, tuiHelp } from '../src/help.js';
import { visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';
import { toolOutput, toolStatus } from '../src/tui/transcript.js';

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
          yield ask('继续吗', [{ id: 'q1', text: '要不要同时改重试次数？' }]);
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
      { kind: 'ask_user', prompt: '要不要同时改重试次数？' },
    ]);
    expect(answers).toEqual([{ answers: { q1: cliText('ask.unattended') }, unattended: true }]);
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
    const decisions: Array<{ kind: string; reason?: string }> = [];
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
        decideApproval: async (_id, kind, reason) => {
          decisions.push({ kind, reason });
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
    expect(decisions).toEqual([
      { kind: 'allow_once', reason: UNATTENDED_APPROVAL_REASON },
      { kind: 'deny_once', reason: undefined },
    ]);
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

  it('writes auto_answered immediately before the tool event', async () => {
    const toolSeen = deferred();
    const decided = deferred();
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--stream-json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          await toolSeen.promise;
          yield approval('web_fetch', 'network_egress', 'other');
        },
        decideApproval: async () => {
          decided.resolve();
          return true;
        },
        stream: async function* () {
          yield { type: 'tool_call', payload: { id: 'c1', name: 'web_fetch', arguments: {} } } as SSEEvent;
          toolSeen.resolve();
          await decided.promise;
          yield { type: 'tool_result', payload: { id: 'c1', name: 'web_fetch', success: true } } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(0);
    const types = stdout.text().trim().split('\n').map((line) => (JSON.parse(line) as { type?: string }).type);
    const answerAt = types.indexOf('auto_answered');
    expect(types[answerAt + 1]).toBe('tool_call');
  });

  it('writes auto_answered immediately before the executed_actions snapshot', async () => {
    const toolSeen = deferred();
    const decided = deferred();
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--stream-json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          await toolSeen.promise;
          yield approval('web_fetch', 'network_egress', 'other');
        },
        decideApproval: async () => {
          decided.resolve();
          return true;
        },
        stream: async function* () {
          yield {
            type: 'executed_actions',
            actions: [{ id: 'c1', tool: 'web_fetch' }],
          } as SSEEvent;
          toolSeen.resolve();
          await decided.promise;
          yield {
            type: 'executed_actions',
            actions: [{ id: 'c1', tool: 'web_fetch', success: true, durationMs: 10 }],
          } as SSEEvent;
          yield { type: 'done' } as SSEEvent;
        },
      }),
    });
    expect(code).toBe(0);
    const types = stdout.text().trim().split('\n').map((line) => (JSON.parse(line) as { type?: string }).type);
    const answerAt = types.indexOf('auto_answered');
    expect(types[answerAt + 1]).toBe('executed_actions');
    expect(types.filter((type) => type === 'executed_actions')).toHaveLength(2);
  });

  it('keeps an earlier auto_answered line when the stream ends before the other tool is approved', async () => {
    const toolSeen = deferred();
    const firstDecided = deferred();
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'go', '--approve', 'allow-all', '--stream-json', '--no-project'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      createClient: async () => client({
        events: async function* () {
          await toolSeen.promise;
          yield approval('local_exec_shell', 'shell', 'destructive');
        },
        decideApproval: async () => {
          firstDecided.resolve();
          return true;
        },
        stream: async function* () {
          yield {
            type: 'executed_actions',
            actions: [
              { id: 'a', tool: 'local_exec_shell' },
              { id: 'b', tool: 'browser_navigate' },
            ],
          } as SSEEvent;
          toolSeen.resolve();
          await firstDecided.promise;
        },
      }),
    });
    expect(code).toBe(0);
    const types = stdout.text().trim().split('\n').map((line) => (JSON.parse(line) as { type?: string }).type);
    const answerAt = types.indexOf('auto_answered');
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(types[answerAt + 1]).toBe('executed_actions');
  });

  it('prints settled tool progress on stderr', async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runTurn(client({
      stream: async function* () {
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'call-1',
            tool: 'local_write_file',
            view: { title: 'hello.txt' },
          }],
        } as SSEEvent;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'call-1',
            tool: 'local_write_file',
            view: { title: 'hello.txt' },
            success: true,
            durationMs: 100,
          }, {
            id: 'call-2',
            tool: 'local_exec_shell',
            view: { title: 'ls' },
            success: true,
            durationMs: 200,
            approval: { kind: 'allow_for_session', cached: true },
          }],
        } as SSEEvent;
        yield { type: 'content', content: 'done' } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      task: 'go',
      chatId: 'chat-1',
      files: [],
      policy: 'deny',
      json: false,
      streamJson: false,
    }, stdout.stream, stderr.stream, new AbortController().signal);
    expect(code).toBe(0);
    expect(stderr.text()).toBe('▸ local_write_file  hello.txt  ✓ 0.1s\n▸ local_exec_shell  ls  ✓ 0.2s 本会话已允许\n');
    expect(stdout.text()).toBe('done');
  });

  it('prints an auto-allowed egress host on stderr', async () => {
    const stdout = capture();
    const stderr = capture();
    const seen = deferred();
    const code = await runTurn(client({
      events: async function* () {
        yield approval('network_egress', 'network_egress', 'other', {
          arguments: { host: 'registry.example.org', port: 443 },
        });
      },
      decideApproval: async () => {
        seen.resolve();
        return true;
      },
      stream: async function* () {
        await seen.promise;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'egress-1',
            tool: 'network_egress',
            arguments: { host: 'registry.example.org', port: 443, url: 'https://registry.example.org/pkg' },
            success: true,
            approval: { kind: 'allow_once', auto: true },
          }],
        } as SSEEvent;
        yield { type: 'content', content: 'ok' } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      task: 'go',
      chatId: 'chat-1',
      files: [],
      policy: 'allow-all',
      json: false,
      streamJson: false,
    }, stdout.stream, stderr.stream, new AbortController().signal);
    expect(code).toBe(0);
    expect(stderr.text()).toContain('▸ network_egress  registry.example.org  ✓ 自动\n');
    expect(stderr.text().match(/network_egress/g)).toHaveLength(1);
    expect(stderr.text()).not.toContain('https://registry.example.org');
    expect(stdout.text()).toBe('ok');
  });

  it('includes the bound project in --json', async () => {
    const stdout = capture();
    const code = await runTurn(client(), {
      task: 'go',
      chatId: 'chat-1',
      projectId: 'p_51a0',
      files: [],
      policy: 'deny',
      json: true,
      streamJson: false,
    }, stdout.stream, capture().stream, new AbortController().signal);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: true,
      chatId: 'chat-1',
      projectId: 'p_51a0',
      text: 'ok',
      exitCode: 0,
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

  it('keeps the auto mark after the tool row settles', async () => {
    const gate = deferred();
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async () => {
        gate.resolve();
        return true;
      },
      stream: async function* () {
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'call-1',
            tool: 'local_exec_shell',
            arguments: { command: 'npm test' },
            view: { title: 'npm test' },
          }],
        } as SSEEvent;
        await gate.promise;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'call-1',
            tool: 'local_exec_shell',
            arguments: { command: 'npm test' },
            view: { title: 'npm test' },
            success: true,
            durationMs: 8200,
          }],
        } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    const sending = (async () => {
      for (const char of 'go') session.handleInput(char);
      session.handleInput('\r');
      await session.settled();
    })();
    await waitFor(() => visibleText(session.render(90)).includes('…'));
    events.push(approval('local_exec_shell', 'shell', 'destructive'));
    await sending;
    expect(visibleText(session.render(90))).toContain('▸ local_exec_shell  npm test  ✓ 8.2s 自动');
  });

  it('shows a failed auto-approved command as a failure', async () => {
    const gate = deferred();
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async () => {
        gate.resolve();
        return true;
      },
      stream: async function* () {
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'call-1',
            tool: 'local_exec_shell',
            arguments: { command: 'sudo reboot' },
            view: { title: 'sudo reboot' },
          }],
        } as SSEEvent;
        await gate.promise;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'call-1',
            tool: 'local_exec_shell',
            arguments: { command: 'sudo reboot' },
            view: { title: 'sudo reboot' },
            success: false,
            error: 'Blocked dangerous command: \\bsudo\\s',
            durationMs: 100,
          }],
        } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    const sending = (async () => {
      for (const char of 'go') session.handleInput(char);
      session.handleInput('\r');
      await session.settled();
    })();
    await waitFor(() => visibleText(session.render(90)).includes('…'));
    events.push(approval('local_exec_shell', 'shell', 'destructive', {
      arguments: { command: 'sudo reboot' },
    }));
    await sending;
    const folded = visibleText(session.render(90));
    expect(folded).toContain('▸ local_exec_shell  sudo reboot  ✗ 0.1s');
    expect(folded).not.toContain(cliText('tui.toolAuto'));
    session.handleInput('\x0f');
    expect(visibleText(session.render(90))).toContain('Blocked dangerous command');
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
    expect(folded).toContain('要不要同时改重试次数？');
    expect(folded).not.toContain('要不要记一条说明？');
    expect(folded).not.toContain(cliText('ask.unattended'));
    session.handleInput('\x0f');
    const screen = visibleText(session.render(80));
    expect(screen).toContain('问 要不要同时改重试次数？');
    expect(screen).toContain('问 要不要记一条说明？');
    expect(screen).toContain(`答 ${cliText('ask.unattended')}`);
    expect(answers).toEqual([{ answers: { q1: cliText('ask.unattended'), q2: cliText('ask.unattended') }, unattended: true }]);
  });

  it('keeps one expandable ask line after the tool row settles', async () => {
    const answered = deferred();
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      answerAsk: async () => {
        answered.resolve();
        return true;
      },
      stream: async function* () {
        yield {
          type: 'executed_actions',
          actions: [{ id: 'ask-1', tool: 'ask_user', view: { title: '继续吗' } }],
        } as SSEEvent;
        await answered.promise;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'ask-1',
            tool: 'ask_user',
            view: { title: '继续吗' },
            success: true,
            durationMs: 120,
          }],
        } as SSEEvent;
        yield { type: 'content', content: '好' } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    const sending = (async () => {
      for (const char of 'go') session.handleInput(char);
      session.handleInput('\r');
      await session.settled();
    })();
    await waitFor(() => visibleText(session.render(80)).includes('▸ ask_user'));
    events.push({
      channel: 'ask-user:request',
      payload: {
        requestId: 'ask-1',
        prompt: '继续吗',
        questions: [{ id: 'q1', text: '要不要同时改重试次数？' }],
      },
    });
    await sending;
    const folded = visibleText(session.render(80));
    expect(folded.match(/▸ ask_user/g)).toHaveLength(1);
    expect(folded).toContain(`✓ ${cliText('tui.toolAutoAnswer')}`);
    expect(folded).toContain('要不要同时改重试次数？');
    expect(folded).not.toContain(cliText('ask.unattended'));
    session.handleInput('\x0f');
    const open = visibleText(session.render(80));
    expect(open.match(/▸ ask_user/g)).toHaveLength(1);
    expect(open).toContain('问 要不要同时改重试次数？');
    expect(open).toContain(`答 ${cliText('ask.unattended')}`);
  });

  it('restores the unattended ask when the chat is opened again', async () => {
    const phrase = cliText('ask.unattended');
    const session = new AgentTui(client({
      request: async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: '修复登录超时' }] } };
        }
        if (requestPath === '/api/v2/chats/chat-1/messages') {
          return {
            status: 200,
            data: {
              messages: [{
                role: 'assistant',
                content: '好',
                createdAt: '2026-10-31T01:00:00.000Z',
                messageMetadata: JSON.stringify({
                  timeline: [{
                    type: 'tools',
                    actions: [{
                      id: 'shell-1',
                      tool: 'local_exec_shell',
                      arguments: { command: 'npm test' },
                      success: true,
                      durationMs: 8200,
                      approval: { kind: 'allow_once', auto: true },
                    }, {
                      id: 'ask-1',
                      tool: 'ask_user',
                      view: { title: '继续吗' },
                      success: true,
                      durationMs: 120,
                      result: {
                        intro: '继续吗',
                        questions: [
                          { id: 'q1', text: '要不要同时改重试次数？' },
                          { id: 'q2', text: '要不要记一条说明？' },
                        ],
                        answers: { q1: phrase, q2: phrase },
                      },
                    }],
                  }],
                }),
              }],
            },
          };
        }
        if (requestPath.startsWith('/api/v2/chats/')) {
          return { status: 200, data: { id: 'chat-1', title: '修复登录超时' } };
        }
        return { status: 200, data: { model: 'demo' } };
      },
    }), {
      product: 'Demo',
      onExit() {},
    });
    await session.open();
    const folded = visibleText(session.render(80));
    expect(folded).toContain('▸ ask_user');
    expect(folded).toContain('npm test');
    expect(folded).toContain(`✓ 8.2s ${cliText('tui.toolAuto')}`);
    expect(folded).toContain('要不要同时改重试次数？');
    expect(folded).not.toContain('要不要记一条说明？');
    expect(folded).toContain(`✓ ${cliText('tui.toolAutoAnswer')}`);
    expect(folded).not.toContain(phrase);
    session.handleInput('\x0f');
    const open = visibleText(session.render(80));
    expect(open).toContain('问 要不要同时改重试次数？');
    expect(open).toContain('问 要不要记一条说明？');
    expect(open).toContain(`答 ${phrase}`);
  });

  it('answers a shell, egress, an external tool, and an ask without an approval row', async () => {
    const decisions: Array<{ kind: string; reason?: string }> = [];
    const answers: unknown[] = [];
    const gate = deferred();
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async (_id, kind, reason) => {
        decisions.push({ kind, reason });
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
    expect(decisions).toEqual([
      { kind: 'allow_once', reason: UNATTENDED_APPROVAL_REASON },
      { kind: 'allow_once', reason: UNATTENDED_APPROVAL_REASON },
      { kind: 'allow_once', reason: UNATTENDED_APPROVAL_REASON },
    ]);
    expect(answers).toEqual([{ answers: { q1: cliText('ask.unattended') }, unattended: true }]);
  });

  it('keeps the auto mark after the turn is reloaded from history', async () => {
    const phrase = cliText('ask.unattended');
    const events = queue();
    const decisions: string[] = [];
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async (_id, kind) => {
        decisions.push(kind);
        return true;
      },
      answerAsk: async () => true,
      request: async (_method, requestPath) => {
        if (requestPath === '/api/v2/chats/chat-1/messages') {
          return {
            status: 200,
            data: {
              messages: [{
                role: 'assistant',
                content: '好',
                createdAt: '2026-10-31T01:00:00.000Z',
                messageMetadata: JSON.stringify({
                  timeline: [
                    {
                      type: 'tools',
                      actions: [
                        {
                          id: 'shell-1',
                          tool: 'local_exec_shell',
                          arguments: { command: 'npm test' },
                          success: true,
                          durationMs: 8200,
                        },
                        {
                          id: 'egress-1',
                          tool: 'network_egress',
                          arguments: { host: 'registry.example.org', port: 443 },
                          success: true,
                          durationMs: 100,
                        },
                        {
                          id: 'egress-2',
                          tool: 'network_egress',
                          arguments: { host: 'pypi.example.org', port: 8443 },
                          success: true,
                          durationMs: 100,
                        },
                        {
                          id: 'browser-1',
                          tool: 'browser_navigate',
                          success: true,
                          durationMs: 200,
                        },
                        {
                          id: 'ask-1',
                          tool: 'ask_user',
                          view: { title: '继续吗' },
                          success: true,
                          durationMs: 50,
                          result: {
                            questions: [{ id: 'q1', text: '要不要同时改重试次数？' }],
                            answers: { q1: phrase },
                          },
                        },
                      ],
                    },
                    { type: 'text', content: '好' },
                  ],
                }),
              }],
            },
          };
        }
        return { status: 200, data: { chatId: 'chat-1', chats: [], model: 'demo' } };
      },
      stream: async function* () {
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
    await waitFor(() => decisions.length === 3);
    for (const char of 'go') session.handleInput(char);
    session.handleInput('\r');
    await session.settled();
    await waitFor(() => visibleText(session.render(100)).split(cliText('tui.toolAuto')).length >= 4);
    events.push({ channel: 'chat-turn-finished', payload: { chatId: 'chat-1' } });
    await waitFor(() => visibleText(session.render(100)).includes('npm test'));
    const screen = visibleText(session.render(100));
    expect(screen.split(cliText('tui.toolAuto')).length).toBeGreaterThanOrEqual(4);
    expect(screen).toContain('▸ local_exec_shell');
    expect(screen).toContain('▸ network_egress  registry.example.org');
    expect(screen).toContain('pypi.example.org:8443');
    expect(screen).not.toContain(':443');
    expect(screen).toContain(`✓ 8.2s ${cliText('tui.toolAuto')}`);
    expect(screen).toContain(cliText('tui.toolAutoAnswer'));
    expect(screen).toContain('要不要同时改重试次数？');
    session.handleInput('\x0f');
    expect(visibleText(session.render(100))).toContain(`答 ${phrase}`);
  });

  it('keeps an egress grant that history does not store', async () => {
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async () => true,
      request: async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: '修复登录超时' }] } };
        }
        if (requestPath === '/api/v2/chats/chat-1/messages') {
          return {
            status: 200,
            data: {
              messages: [{
                role: 'assistant',
                content: '好',
                createdAt: '2026-10-31T01:00:00.000Z',
                messageMetadata: JSON.stringify({
                  timeline: [{
                    type: 'tools',
                    actions: [{
                      id: 'shell-1',
                      tool: 'local_exec_shell',
                      arguments: { command: 'npm test' },
                      success: true,
                      durationMs: 8200,
                      approval: { kind: 'allow_once', auto: true },
                    }],
                  }],
                }),
              }],
            },
          };
        }
        if (requestPath.startsWith('/api/v2/chats/')) {
          return { status: 200, data: { id: 'chat-1', title: '修复登录超时' } };
        }
        return { status: 200, data: { model: 'demo' } };
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    events.push(approval('network_egress', 'network_egress', 'other', {
      arguments: { host: 'registry.example.org', port: 443 },
    }));
    await waitFor(() => visibleText(session.render(100)).includes('registry.example.org'));
    events.push({ channel: 'chat-turn-finished', payload: { chatId: 'chat-1' } });
    await waitFor(() => visibleText(session.render(100)).includes('npm test'));
    const screen = visibleText(session.render(100));
    expect(screen).toContain('▸ network_egress  registry.example.org');
    expect(screen).toContain('✓ 自动');
    expect(screen).not.toContain(':443');
    expect(screen.match(/▸ network_egress/g)).toHaveLength(1);
  });

  it('shows a stored egress grant when the chat is opened again', async () => {
    const session = new AgentTui(client({
      request: async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: '修复登录超时' }] } };
        }
        if (requestPath === '/api/v2/chats/chat-1/messages') {
          return {
            status: 200,
            data: {
              messages: [{
                role: 'assistant',
                content: '好',
                createdAt: '2026-10-31T01:00:00.000Z',
                messageMetadata: JSON.stringify({
                  timeline: [{
                    type: 'tools',
                    actions: [{
                      id: 'egress-1',
                      tool: 'network_egress',
                      arguments: { host: 'registry.example.org', port: 443 },
                      success: true,
                      approval: { kind: 'allow_once', auto: true },
                    }],
                  }],
                }),
              }],
            },
          };
        }
        if (requestPath.startsWith('/api/v2/chats/')) {
          return { status: 200, data: { id: 'chat-1', title: '修复登录超时' } };
        }
        return { status: 200, data: { model: 'demo' } };
      },
    }), { product: 'Demo', onExit() {} });
    await session.open();
    const screen = visibleText(session.render(100));
    expect(screen).toContain('▸ network_egress  registry.example.org');
    expect(screen).toContain('✓ 自动');
    expect(screen).not.toContain(':443');
    expect(screen.match(/▸ network_egress/g)).toHaveLength(1);
  });

  it('keeps one egress row when the saved snapshot arrives', async () => {
    const events = queue();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async () => true,
      request: async (method, requestPath) => {
        if (method === 'GET' && requestPath === '/api/v2/chats') {
          return { status: 200, data: { chats: [{ id: 'chat-1', title: '修复登录超时' }] } };
        }
        if (requestPath.startsWith('/api/v2/chats/')) {
          return { status: 200, data: { id: 'chat-1', title: '修复登录超时' } };
        }
        return { status: 200, data: { model: 'demo', chatId: 'chat-1' } };
      },
      stream: async function* () {
        await gate;
        yield {
          type: 'executed_actions',
          actions: [{
            id: 'egress-1',
            tool: 'network_egress',
            arguments: { host: 'registry.example.org', port: 443 },
            success: true,
            approval: { kind: 'allow_once', auto: true },
          }],
        } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    for (const char of 'go') session.handleInput(char);
    session.handleInput('\r');
    events.push(approval('network_egress', 'network_egress', 'other', {
      arguments: { host: 'registry.example.org', port: 443 },
    }));
    await waitFor(() => visibleText(session.render(100)).includes('registry.example.org'));
    release();
    await session.settled();
    const screen = visibleText(session.render(100));
    expect(screen.match(/▸ network_egress/g)).toHaveLength(1);
    expect(screen).toContain('✓ 自动');
    expect(screen).not.toContain(':443');
  });

  it('shows the egress host on an auto-allowed row', async () => {
    const events = queue();
    const session = new AgentTui(client({
      events: events.stream,
      decideApproval: async () => true,
    }), {
      product: 'Demo',
      approvalPolicy: { policy: 'allow-all', answerAsk: true },
      onExit() {},
    });
    await session.open();
    events.push(approval('network_egress', 'network_egress', 'other', {
      arguments: { host: 'registry.example.org', port: 443 },
    }));
    await waitFor(() => visibleText(session.render(100)).includes('registry.example.org'));
    const screen = visibleText(session.render(100));
    expect(screen).toContain('▸ network_egress  registry.example.org');
    expect(screen).toContain('✓ 自动');
    expect(screen).not.toContain(':443');
    expect(screen).not.toContain('审批 network_egress');
    events.push(approval('network_egress', 'network_egress', 'other', {
      requestId: 'network_egress-2',
      arguments: { host: 'pypi.example.org', port: 8443 },
    }));
    await waitFor(() => visibleText(session.render(100)).includes('pypi.example.org:8443'));
    const both = visibleText(session.render(100));
    expect(both.match(/▸ network_egress/g)).toHaveLength(2);
    expect(both).toContain('registry.example.org');
    expect(both).toContain('pypi.example.org:8443');
  });

  it('shows the approval target instead of the argument JSON', async () => {
    const events = queue();
    const session = new AgentTui(client({ events: events.stream }), {
      product: 'Demo',
      onExit() {},
    });
    await session.open();
    events.push(approval('network_egress', 'network_egress', 'other', {
      arguments: { host: 'registry.example.org', port: 443 },
    }));
    await waitFor(() => visibleText(session.render(100)).includes('审批 network_egress registry.example.org:443'));
    const screen = visibleText(session.render(100));
    expect(screen).not.toContain('"host"');
    events.push(approval('network_egress', 'network_egress', 'other', {
      requestId: 'network_egress-2',
      arguments: { host: 'pypi.example.org', port: 8443 },
    }));
    await waitFor(() => visibleText(session.render(100)).includes('审批 network_egress pypi.example.org:8443'));
    events.push(approval('browser_navigate', 'browser', 'external', {
      requestId: 'browser-1',
      arguments: { url: 'https://www.example.com/about' },
    }));
    await waitFor(() => visibleText(session.render(100)).includes('审批 browser_navigate https://www.example.com/about'));
    expect(visibleText(session.render(100))).not.toContain('"url"');
  });

  it('rebuilds ask lines from a stored result', () => {
    const phrase = cliText('ask.unattended');
    const unattended = {
      tool: 'ask_user',
      success: true,
      durationMs: 120,
      result: {
        questions: [
          { id: 'q1', text: '要不要同时改重试次数？' },
          { id: 'q2', text: '要不要记一条说明？' },
        ],
        answers: { q1: phrase, q2: phrase },
      },
    };
    expect(toolStatus(unattended)).toBe(`✓ ${cliText('tui.toolAutoAnswer')}`);
    expect(toolOutput(unattended)).toBe(`问 要不要同时改重试次数？\n问 要不要记一条说明？\n答 ${phrase}`);
    const answered = {
      tool: 'ask_user',
      success: true,
      result: {
        questions: [
          { id: 'q1', text: '哪一个？' },
          { id: 'q2', text: '记下来吗？' },
        ],
        answers: { q1: '蓝', q2: ['甲', '乙'] },
      },
    };
    expect(toolStatus(answered)).toBe('✓');
    expect(toolOutput(answered)).toBe('问 哪一个？\n答 蓝\n问 记下来吗？\n答 甲、乙');
    const failed = {
      tool: 'ask_user',
      success: false,
      error: 'cancelled',
      result: {
        questions: [{ id: 'q1', text: '继续？' }],
        answers: { q1: phrase },
      },
    };
    expect(toolStatus(failed)).toBe('✗');
    expect(toolOutput(failed)).toBe('cancelled');
    const preview = JSON.stringify({
      success: true,
      data: {
        value: {
          intro: '继续吗',
          questions: [{ id: 'q1', text: '要不要同时改重试次数？' }],
          answers: { q1: phrase },
        },
      },
    });
    expect(toolOutput({ tool: 'ask_user', success: true, result: preview })).toBe(
      `问 要不要同时改重试次数？\n答 ${phrase}`,
    );
    expect(toolStatus({
      tool: 'ask_user',
      success: true,
      result: { questions: [{ id: 'q1', text: '继续？' }], answers: { q1: '自己决定' }, unattended: true },
    })).toBe(`✓ ${cliText('tui.toolAutoAnswer')}`);
    expect(toolStatus({
      tool: 'local_exec_shell',
      success: true,
      durationMs: 8200,
      approval: { kind: 'allow_once', auto: true },
    })).toBe(`✓ 8.2s ${cliText('tui.toolAuto')}`);
    expect(toolStatus({
      tool: 'local_exec_shell',
      success: false,
      error: 'failed',
      approval: { kind: 'allow_once', auto: true },
    })).toBe('✗');
  });

  it('labels a tool covered by a session allow', () => {
    expect(toolStatus({
      tool: 'browser_click',
      success: true,
      durationMs: 300,
      approval: { kind: 'allow_for_session', cached: true },
    })).toBe(`✓ 0.3s ${cliText('tui.toolSessionAllow')}`);
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
  return { channel: 'ask-user:request', payload: { requestId: 'ask-1', intro: prompt, questions } };
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
