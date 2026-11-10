/**
 * First-run behaviour: the credential preflight, the failure text, and the
 * exit codes a script can branch on.
 *
 * These are the paths a new user hits before anything else works, so they get
 * assertions on the exact commands printed, not only on the exit code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';
import { createCli } from '../src/cli.js';
import { preflightApiKey } from '../src/credentials.js';
import { EXIT_CONFIG, EXIT_OK, EXIT_TURN_FAILED, EXIT_USAGE, exitCodeHelp } from '../src/exit-codes.js';
import { failureLines, failureReport } from '../src/failure-text.js';
import { classifyErrorMessage } from '@steerable/agent-protocol';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-first-run-'));
  dirs.push(dir);
  return dir;
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

/** A client whose settings say what the test needs and whose stream is scripted. */
function client(options: {
  settings?: Record<string, unknown>;
  events?: SSEEvent[];
  onRequest?: (method: string, path: string) => void;
} = {}): AgentClient {
  return {
    lastStatus: 200,
    request: async (method, requestPath) => {
      options.onRequest?.(method, requestPath);
      if (requestPath === '/api/v2/local-settings/llm') {
        return { status: 200, data: options.settings ?? { provider: 'openai-compat', model: 'deepseek-chat', apiKey: 'sk-test' } };
      }
      return { status: 200, data: { chatId: 'chat-1', chats: [] } };
    },
    stream: async function* () {
      for (const event of options.events ?? [{ type: 'done' } as SSEEvent]) yield event;
    },
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
  };
}

describe('credential preflight', () => {
  it('passes a settings payload that carries a key', () => {
    expect(preflightApiKey({ provider: 'openai-compat', apiKey: 'sk' }, {})).toEqual({ ok: true });
  });

  it('passes when the environment supplies the key', () => {
    expect(
      preflightApiKey({ provider: 'openai-compat', vendorId: 'deepseek' }, { DEEPSEEK_API_KEY: 'sk-env' }),
    ).toEqual({ ok: true });
  });

  it('passes a local provider without a key', () => {
    expect(preflightApiKey({ provider: 'ollama' }, {})).toEqual({ ok: true });
  });

  it('names the environment variables when nothing is configured', () => {
    expect(preflightApiKey({ provider: 'anthropic' }, {})).toEqual({
      ok: false,
      envNames: ['ANTHROPIC_API_KEY'],
    });
  });

  it('passes a payload that is not LLM settings at all', () => {
    // An endpoint change must not block every turn.
    expect(preflightApiKey({ chatId: 'chat-1' }, {})).toEqual({ ok: true });
  });
});

describe('run preflight', () => {
  it('prints the three fixes and exits 78 without creating a chat', async () => {
    const stderr = capture();
    const stdout = capture();
    const requests: string[] = [];
    const code = await createCli({
      argv: ['run', 'hello', '--no-project'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdinIsTTY: false,
      createClient: async () =>
        client({
          settings: { provider: 'openai-compat', vendorId: 'deepseek', model: 'deepseek-chat' },
          onRequest: (method, requestPath) => requests.push(`${method} ${requestPath}`),
        }),
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(stderr.text()).toContain('还没有配置模型的 API key');
    expect(stderr.text()).toContain('steerable-cli login');
    expect(stderr.text()).toContain('export DEEPSEEK_API_KEY=sk-...');
    expect(stderr.text()).toContain('steerable-cli config set apiKey sk-...');
    expect(stderr.text()).not.toContain('\n    at ');
    // Nothing beyond the settings read: an unconfigured install leaves no chat.
    expect(requests).toEqual(['GET /api/v2/local-settings/llm']);
    expect(stdout.text()).toBe('');
  });

  it('emits a structured error under --stream-json', async () => {
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'hello', '--no-project', '--stream-json'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: false,
      createClient: async () =>
        client({ settings: { provider: 'openai-compat', vendorId: 'deepseek', model: 'deepseek-chat' } }),
    });
    expect(code).toBe(EXIT_CONFIG);
    const event = JSON.parse(stdout.text().trim()) as Record<string, unknown>;
    expect(event.type).toBe('error');
    expect(event.code).toBe('missing_api_key');
    expect(event.env).toEqual(['DEEPSEEK_API_KEY']);
    expect(Array.isArray(event.fix)).toBe(true);
  });

  it('starts the turn when --no-preflight is passed', async () => {
    const stdout = capture();
    const code = await createCli({
      argv: ['run', 'hello', '--no-project', '--no-preflight'],
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: false,
      createClient: async () =>
        client({
          settings: { provider: 'openai-compat', vendorId: 'deepseek', model: 'deepseek-chat' },
          events: [{ type: 'content', content: 'ok' } as SSEEvent, { type: 'done' } as SSEEvent],
        }),
    });
    expect(code).toBe(EXIT_OK);
    expect(stdout.text()).toBe('ok');
  });
});

describe('turn failure text', () => {
  it('classifies an auth failure and points at login', () => {
    const report = failureReport({
      message: 'coreloop stream failed: LoopError: openai_compat: HTTP 401 (auth): Authentication Fails',
      providerLabel: 'deepseek',
      host: 'api.deepseek.com',
    });
    expect(report.kind).toBe('auth');
    expect(report.headline).toContain('拒绝了 API key');
    expect(report.fixes.join('\n')).toContain('steerable-cli login');
    // The provider's own text survives for searching, without our prefix.
    const lines = failureLines(report);
    expect(lines.at(-1)).toBe('    openai_compat: HTTP 401 (auth): Authentication Fails');
  });

  it('points an environment-sourced key at the variable that supplied it', () => {
    const report = failureReport({
      message: 'HTTP 403',
      providerLabel: 'deepseek',
      host: 'api.deepseek.com',
      credentialSource: 'env',
      envName: 'DEEPSEEK_API_KEY',
    });
    expect(report.fixes[0]).toContain('DEEPSEEK_API_KEY');
  });

  it('tells the user how to resume a transport failure', () => {
    const report = failureReport({
      message: 'connect ECONNREFUSED',
      providerLabel: 'deepseek',
      host: 'api.deepseek.com',
      chatId: 'chat-9',
      completedSteps: 3,
    });
    expect(report.headline).toContain('连不上模型服务');
    expect(report.fixes[0]).toContain('steerable-cli run --chat chat-9');
    expect(report.fixes[1]).toContain('3 步不会重做');
  });

  it('reports a budget-free rate limit without pretending it is final', () => {
    const report = failureReport({
      message: 'HTTP 429 rate limit',
      providerLabel: 'deepseek',
      host: 'api.deepseek.com',
    });
    expect(report.kind).toBe('rate_limit');
    expect(report.fixes[0]).toContain('稍后继续');
  });
});

describe('classifyErrorMessage', () => {
  it('recognizes the provider failures that need different fixes', () => {
    expect(classifyErrorMessage('HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyErrorMessage('429 Too Many Requests')).toBe('rate_limit');
    expect(classifyErrorMessage('502 Bad Gateway')).toBe('server');
    expect(classifyErrorMessage('socket hang up')).toBe('transport');
    expect(classifyErrorMessage('maximum context length exceeded')).toBe('context_overflow');
    expect(classifyErrorMessage('something else entirely')).toBe('unknown');
  });
});

describe('--version', () => {
  it('prints the package version without starting a client', async () => {
    const stdout = capture();
    let created = false;
    const code = await createCli({
      argv: ['--version'],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () => {
        created = true;
        return client();
      },
    });
    expect(code).toBe(EXIT_OK);
    expect(stdout.text().trim()).toMatch(/^\d+\.\d+\.\d+/);
    // Answering "which build is this?" must not boot a host.
    expect(created).toBe(false);
  });

  it('accepts the short flag', async () => {
    const stdout = capture();
    const code = await createCli({
      argv: ['-v'],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () => client(),
    });
    expect(code).toBe(EXIT_OK);
    expect(stdout.text().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('exit codes', () => {
  it('documents every documented code in help order', () => {
    const help = exitCodeHelp();
    for (const code of [0, 1, 2, 3, 4, 6, 75, 78, 130]) {
      expect(help).toContain(`  ${code}`);
    }
  });

  it('uses 78 for configuration and 2 for usage', () => {
    expect(EXIT_CONFIG).toBe(78);
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_TURN_FAILED).toBe(1);
  });
});

describe('login without a terminal', () => {
  it('explains the environment variable route and exits 2', async () => {
    const stderr = capture();
    const code = await createCli({
      argv: ['login'],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: false,
      createClient: async () => client(),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text()).toContain('交互式终端');
    expect(stderr.text()).toContain('export DEEPSEEK_API_KEY');
    expect(stderr.text()).toContain('config set apiKey');
  });
});

describe('doctor report', () => {
  it('lists each check with a status and a fix', async () => {
    const dir = tempDir();
    const stdout = capture();
    const runtimePython = path.join(dir, 'python3');
    fs.writeFileSync(runtimePython, '');
    const code = await createCli({
      argv: ['doctor', '--data-dir', dir],
      stdout: stdout.stream,
      stderr: capture().stream,
      // The runner may or may not have a platform package installed; pin the
      // interpreters so the assertion is about the report, not the machine.
      env: {
        ...process.env,
        STEERABLE_SIDECAR_PYTHON: runtimePython,
        STEERABLE_PYTHON: runtimePython,
        STEERABLE_EGRESS_PROXY_BIN: runtimePython,
        DEEPSEEK_API_KEY: 'sk-test',
      },
      createClient: async () => client(),
    });
    const text = stdout.text();
    expect(code).toBe(EXIT_OK);
    expect(text).toContain('sidecar Python');
    expect(text).toContain('API key');
    expect(text).toContain('全部通过');
    expect(text).not.toContain('\n    at ');
  });

  it('fails with 78 and a fix line when the key is missing', async () => {
    const dir = tempDir();
    const stdout = capture();
    const code = await createCli({
      argv: ['doctor', '--data-dir', dir],
      stdout: stdout.stream,
      stderr: capture().stream,
      createClient: async () =>
        client({ settings: { provider: 'openai-compat', vendorId: 'deepseek', model: 'deepseek-chat' } }),
    });
    const text = stdout.text();
    expect(code).toBe(EXIT_CONFIG);
    expect(text).toContain('fail');
    expect(text).toContain('修复：steerable-cli login');
  });
});
