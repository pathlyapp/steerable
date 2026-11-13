/**
 * `children` reads the durable child-agent index, so these tests pin the two
 * things a caller depends on: the listing survives a turn boundary (it is not
 * a live-pool view), and a child that has not finished is reported as such
 * instead of being silently omitted or blocking a script.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import { createCli } from '../src/cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'children-test-'));
  dirs.push(dir);
  return dir;
}

function client(request: AgentClient['request']): AgentClient {
  return {
    lastStatus: 200,
    request,
    stream: async function* () {},
    events: async function* () {},
    decideApproval: async () => true,
    answerAsk: async () => true,
    close: async () => {},
  };
}

async function run(argv: string[], request: AgentClient['request']) {
  const stdout = capture();
  const stderr = capture();
  const dir = tempDir();
  const code = await createCli({
    argv: [...argv, '--data-dir', dir],
    stdout: stdout.stream,
    stderr: stderr.stream,
    createClient: async () => client(request),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const ROWS = [
  {
    recordId: 'chat-1:child:0.1',
    parentRecordId: 'chat-1',
    childId: '0.1',
    depth: 1,
    profile: 'explore',
    engine: 'coreloop',
    status: 'completed',
    resumable: true,
    live: false,
    promptTokens: 8000,
    completionTokens: 120,
    usageKnown: true,
    createdAt: '2026-11-12T10:00:00Z',
    updatedAt: '2026-11-12T10:01:00Z',
    answerPreview: 'version 1.0.8',
  },
  {
    recordId: 'chat-1:child:0.2',
    parentRecordId: 'chat-1',
    childId: '0.2',
    depth: 1,
    profile: 'coder',
    engine: 'acp',
    status: 'interrupted',
    resumable: true,
    live: false,
    promptTokens: null,
    completionTokens: null,
    usageKnown: false,
    createdAt: '2026-11-12T10:02:00Z',
    updatedAt: '2026-11-12T10:03:00Z',
  },
];

describe('children commands', () => {
  it('lists children with profile, depth, status and tokens', async () => {
    const result = await run(['children', 'list', '--session', 'chat-1'], async (method, requestPath) => {
      expect(method).toBe('GET');
      expect(requestPath).toContain('/api/v2/children');
      expect(requestPath).toContain('session=chat-1');
      return { status: 200, data: { parentRecordId: 'chat-1', children: ROWS } };
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0.1');
    expect(result.stdout).toContain('explore');
    expect(result.stdout).toContain('completed (resumable)');
    expect(result.stdout).toContain('8120');
    // An external-engine child reports no token bill; the column says so
    // rather than printing a misleading zero.
    expect(result.stdout).toContain('interrupted (resumable)');
    expect(result.stdout).toContain('-');
  });

  it('passes --active through so finished children are dropped', async () => {
    let seen = '';
    const result = await run(['children', 'list', '--session', 'chat-1', '--active'], async (_method, requestPath) => {
      seen = requestPath;
      return { status: 200, data: { parentRecordId: 'chat-1', children: [ROWS[1]] } };
    });

    expect(result.code).toBe(0);
    expect(seen).toContain('active=1');
  });

  it('emits the raw rows as JSON', async () => {
    const result = await run(['children', 'list', '--session', 'chat-1', '--json'], async () => ({
      status: 200,
      data: { parentRecordId: 'chat-1', children: ROWS },
    }));

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as typeof ROWS;
    expect(parsed.map((row) => row.childId)).toEqual(['0.1', '0.2']);
    expect(parsed[0]!.recordId).toBe('chat-1:child:0.1');
  });

  it('says so when a session spawned nothing', async () => {
    const result = await run(['children', 'list', '--session', 'chat-9'], async () => ({
      status: 200,
      data: { parentRecordId: 'chat-9', children: [] },
    }));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no sub-agents');
  });

  it('prints a finished child answer', async () => {
    const result = await run(
      ['children', 'answer', '--session', 'chat-1', '--child', '0.1'],
      async () => ({ status: 200, data: { parentRecordId: 'chat-1', children: ROWS } }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0.1 · explore · completed');
    expect(result.stdout).toContain('version 1.0.8');
  });

  it('exits 6 for a child that is still running, without --wait', async () => {
    const running = [{ ...ROWS[1]!, status: 'running', live: true, resumable: false }];
    const result = await run(
      ['children', 'answer', '--session', 'chat-1', '--child', '0.2'],
      async () => ({ status: 200, data: { parentRecordId: 'chat-1', children: running } }),
    );

    expect(result.code).toBe(6);
    expect(result.stderr).toContain('still running');
    expect(result.stderr).toContain('--wait');
  });

  it('exits 2 for a child that is not in the session', async () => {
    const result = await run(
      ['children', 'answer', '--session', 'chat-1', '--child', '9.9'],
      async () => ({ status: 200, data: { parentRecordId: 'chat-1', children: ROWS } }),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no child 9.9');
  });

  it('requires --child for answer', async () => {
    const result = await run(['children', 'answer', '--session', 'chat-1'], async () => ({
      status: 200,
      data: { children: [] },
    }));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('missing --child');
  });

  it('rejects an unknown subcommand', async () => {
    const result = await run(['children', 'nope'], async () => ({ status: 200, data: {} }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown children command');
  });

  it('surfaces a failed list as exit 1', async () => {
    const result = await run(['children', 'list'], async () => ({
      status: 503,
      data: { detail: 'sidecar unavailable' },
    }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('children list failed');
  });
});
