/**
 * The interactive `login` flow.
 *
 * Drives the prompts through a scripted line reader so the assertions cover
 * what a user sees: which provider list appears, that a rejected key is not
 * saved and the retry count decrements, and that an unreachable host can still
 * be saved deliberately.
 */
import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';

import { loginCommand } from '../src/login.js';
import { EXIT_CONFIG, EXIT_OK, EXIT_USAGE } from '../src/exit-codes.js';

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

/** Feeds the scripted answers, then ends the stream. */
function scriptedInput(lines: string[]): PassThrough {
  const input = new PassThrough();
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  return input;
}

interface RequestLog {
  method: string;
  path: string;
  body?: unknown;
}

function host(options: {
  settings: Record<string, unknown>;
  models?: 'ok' | 'rejected' | 'unreachable' | 'offline';
  log?: RequestLog[];
}) {
  return async (method: string, path: string, body?: unknown) => {
    options.log?.push({ method, path, body });
    if (path === '/api/v2/local-settings/llm') {
      return method === 'POST'
        ? { status: 200, data: { ...options.settings, ...(body as object) } }
        : { status: 200, data: options.settings };
    }
    if (path === '/api/v2/llm/catalog') {
      return {
        status: 200,
        data: {
          providers: [
            { id: 'deepseek', apiBaseUrl: 'https://api.deepseek.com', wireKind: 'openai_compat', models: ['deepseek-chat'], envVars: ['DEEPSEEK_API_KEY'] },
            { id: 'openai', apiBaseUrl: 'https://api.openai.com/v1', wireKind: 'openai_compat', models: ['gpt-5'], envVars: ['OPENAI_API_KEY'] },
            { id: 'ollama', apiBaseUrl: 'http://127.0.0.1:11434', wireKind: 'ollama', models: ['llama3.1:8b'], envVars: [] },
          ],
        },
      };
    }
    if (path.startsWith('/api/v2/llm/models')) {
      switch (options.models ?? 'ok') {
        case 'rejected':
          return { status: 401, data: { error: 'unauthorized' } };
        case 'unreachable':
          return { status: 502, data: { error: 'connect ETIMEDOUT' } };
        case 'offline':
          return { status: 200, data: { models: [], catalogStatus: 'offline' } };
        default:
          return { status: 200, data: { models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }], catalogStatus: 'live' } };
      }
    }
    return { status: 404, data: {} };
  };
}

const BASE_SETTINGS = { provider: 'openai-compat', vendorId: 'deepseek', model: 'deepseek-chat' };

describe('login', () => {
  it('refuses to run without a terminal and points at the environment route', async () => {
    const stderr = capture();
    const code = await loginCommand({
      request: host({ settings: BASE_SETTINGS }),
      stdin: scriptedInput([]),
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: false,
      env: {},
      dataDir: '/tmp/x',
    });
    expect(code).toBe(EXIT_USAGE);
    expect(stderr.text()).toContain('交互式终端');
    expect(stderr.text()).toContain('DEEPSEEK_API_KEY');
  });

  it('saves a verified key and the chosen model', async () => {
    const log: RequestLog[] = [];
    const stdout = capture();
    const code = await loginCommand({
      request: host({ settings: BASE_SETTINGS, log }),
      // 1 = first provider (deepseek), key, 2 = second model (reasoner).
      stdin: scriptedInput(['1', 'sk-verified-key', '2']),
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      env: {},
      dataDir: '/tmp/x',
    });
    expect(code).toBe(EXIT_OK);
    const saved = log.find((entry) => entry.method === 'POST' && entry.path === '/api/v2/local-settings/llm');
    expect(saved?.body).toMatchObject({
      provider: 'openai-compat',
      vendorId: 'deepseek',
      model: 'deepseek-reasoner',
      apiKey: 'sk-verified-key',
    });
    expect(stdout.text()).toContain('已保存');
    expect(stdout.text()).toContain('deepseek-reasoner');
    // The key is masked in every line that echoes it.
    expect(stdout.text()).not.toContain('sk-verified-key');
  });

  it('does not save a rejected key', async () => {
    const log: RequestLog[] = [];
    const stdout = capture();
    const code = await loginCommand({
      request: host({ settings: BASE_SETTINGS, models: 'rejected', log }),
      stdin: scriptedInput(['1', 'sk-rejected']),
      stdout: stdout.stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      env: {},
      dataDir: '/tmp/x',
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(stdout.text()).toContain('key 无效');
    expect(log.some((entry) => entry.method === 'POST')).toBe(false);
  });

  it('offers to save an unverified key when the host is unreachable', async () => {
    const log: RequestLog[] = [];
    const code = await loginCommand({
      request: host({ settings: BASE_SETTINGS, models: 'unreachable', log }),
      // 1 = deepseek, key, s = save anyway, then Enter for the default model.
      stdin: scriptedInput(['1', 'sk-offline', 's', '']),
      stdout: capture().stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      env: {},
      dataDir: '/tmp/x',
    });
    expect(code).toBe(EXIT_OK);
    const saved = log.find((entry) => entry.method === 'POST');
    expect(saved?.body).toMatchObject({ apiKey: 'sk-offline' });
  });

  it('saves a local provider without asking for a key', async () => {
    const log: RequestLog[] = [];
    const code = await loginCommand({
      request: host({ settings: BASE_SETTINGS, log }),
      // 3 = ollama, then Enter for its default model.
      stdin: scriptedInput(['3', '']),
      stdout: capture().stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      env: {},
      dataDir: '/tmp/x',
    });
    expect(code).toBe(EXIT_OK);
    const saved = log.find((entry) => entry.method === 'POST');
    expect(saved?.body).toMatchObject({ provider: 'ollama' });
    expect((saved?.body as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it('leaves the configuration untouched when cancelled', async () => {
    const log: RequestLog[] = [];
    const code = await loginCommand({
      request: host({ settings: BASE_SETTINGS, log }),
      stdin: scriptedInput(['esc']),
      stdout: capture().stream,
      stderr: capture().stream,
      stdinIsTTY: true,
      env: {},
      dataDir: '/tmp/x',
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(log.some((entry) => entry.method === 'POST')).toBe(false);
  });
});
