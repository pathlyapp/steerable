import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { createCli } from '../src/cli.js';
import { ruleStatusLine } from '../src/rules.js';
import { visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ruleStatusLine', () => {
  it('names loaded files on the command line and counts them in the tui', () => {
    const context = { ruleFileCount: 2, rulesActive: true, files: ['AGENTS.md', 'CLAUDE.md'] };
    expect(ruleStatusLine(context, 'cli')).toBe('已加载 2 个规则文件：AGENTS.md、CLAUDE.md');
    expect(ruleStatusLine(context, 'tui')).toBe('已加载 2 个规则文件');
    expect(ruleStatusLine({ ruleFileCount: 2, rulesActive: false }, 'tui')).toBe('有 2 个规则文件未加载（--trust 加载）');
    expect(ruleStatusLine({ ruleFileCount: 0 }, 'cli')).toBeNull();
  });
});

describe('run --trust', () => {
  it('rejects --trust with --no-project', async () => {
    const stderr = capture();
    const code = await createCli({
      argv: ['run', 'go', '--no-project', '--trust', '--data-dir', tempDir()],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      createClient: async () => client(),
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('--trust 需要绑定项目，不能与 --no-project 同用。');
  });

  it('trusts the bound project and prints the loaded rule files', async () => {
    const dir = tempDir();
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const stderr = capture();
    const code = await createCli({
      argv: ['run', 'go', '--project', dir, '--trust', '--data-dir', tempDir()],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      createClient: async () => client(calls, { ruleFileCount: 2, rulesActive: true, files: ['AGENTS.md', 'CLAUDE.md'] }),
    });
    expect(code).toBe(0);
    expect(calls).toContainEqual({
      method: 'PUT',
      path: '/api/v2/projects/proj-1/trust',
      body: { trusted: true },
    });
    expect(stderr.text()).toContain('已加载 2 个规则文件：AGENTS.md、CLAUDE.md');
  });

  it('prints the unloaded count when the project is not trusted', async () => {
    const dir = tempDir();
    const stderr = capture();
    const code = await createCli({
      argv: ['run', 'go', '--project', dir, '--data-dir', tempDir()],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      createClient: async () => client([], { ruleFileCount: 2, rulesActive: false, files: ['AGENTS.md', 'CLAUDE.md'] }),
    });
    expect(code).toBe(0);
    expect(stderr.text()).toContain('有 2 个规则文件未加载（--trust 加载）');
    expect(stderr.text()).not.toContain('已加载');
  });
});

describe('tui rules', () => {
  it('shows unloaded rules, then lists them', async () => {
    const session = new AgentTui(tuiClient({
      ruleFileCount: 2,
      rulesActive: false,
      files: ['AGENTS.md', 'CLAUDE.md'],
      project: { id: 'proj-1' },
    }), {
      product: 'Demo',
      projectId: 'proj-1',
      projectLabel: '项目 repo · …/repo',
      onExit() {},
    });
    await session.open();
    expect(visibleText(session.render(80))).toContain('项目 repo · …/repo │ 有 2 个规则文件未加载（--trust 加载）');
    for (const char of '/rules') session.handleInput(char);
    session.handleInput('\r');
    await session.settled();
    const text = visibleText(session.render(80));
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('CLAUDE.md');
    expect(text).toContain('有 2 个规则文件未加载（--trust 加载）');
  });

  it('refreshes the count after the next turn', async () => {
    let count = 1;
    const session = new AgentTui({
      lastStatus: 200,
      request: async (_method, requestPath) => {
        if (requestPath.endsWith('/project-context')) {
          return {
            status: 200,
            data: { ruleFileCount: count, rulesActive: true, files: ['AGENTS.md'], project: { id: 'proj-1' } },
          };
        }
        return { status: 200, data: { chatId: 'chat-1', chats: [], model: 'demo' } };
      },
      stream: async function* () {
        count = 2;
        yield { type: 'content', content: 'ok' } as SSEEvent;
        yield { type: 'done' } as SSEEvent;
      },
      events: async function* () {},
      decideApproval: async () => true,
      answerAsk: async () => true,
      close: async () => {},
    }, {
      product: 'Demo',
      projectId: 'proj-1',
      projectLabel: '项目 repo · …/repo',
      onExit() {},
    });
    await session.open();
    expect(visibleText(session.render(80))).toContain('已加载 1 个规则文件');
    for (const char of '继续') session.handleInput(char);
    session.handleInput('\r');
    await session.settled();
    expect(visibleText(session.render(80))).toContain('已加载 2 个规则文件');
  });

  it('shows the loaded count after --trust', async () => {
    const session = new AgentTui(tuiClient({
      ruleFileCount: 2,
      rulesActive: true,
      files: ['AGENTS.md', 'CLAUDE.md'],
      project: { id: 'proj-1' },
    }), {
      product: 'Demo',
      projectId: 'proj-1',
      projectLabel: '项目 repo · …/repo',
      onExit() {},
    });
    await session.open();
    expect(visibleText(session.render(80))).toContain('已加载 2 个规则文件');
    expect(visibleText(session.render(80))).not.toContain('未加载');
  });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  dirs.push(dir);
  return dir;
}

function client(
  calls: Array<{ method: string; path: string; body: unknown }> = [],
  context: Record<string, unknown> = {},
): AgentClient {
  return {
    lastStatus: 200,
    request: async (method, requestPath, body) => {
      calls.push({ method, path: requestPath, body });
      if (requestPath === '/api/v2/projects/resolve') {
        const folderPath = String((body as { folderPath?: string }).folderPath ?? '');
        return {
          status: 200,
          data: { project: { id: 'proj-1', name: 'repo-rules', folderPath }, created: false },
        };
      }
      if (requestPath.endsWith('/project-context')) return { status: 200, data: context };
      return { status: 200, data: { chatId: 'chat-1', chats: [] } };
    },
    stream: async function* () {
      yield { type: 'done' } as SSEEvent;
    },
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
  };
}

function tuiClient(context: Record<string, unknown>): AgentClient {
  return client([], context);
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
