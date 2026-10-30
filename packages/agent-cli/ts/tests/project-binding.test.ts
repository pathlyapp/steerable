import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { createCli } from '../src/cli.js';
import {
  projectStatusLabel,
  protectedRunMessage,
  protectedTuiMessage,
  resolveProjectRequest,
  shortenProjectPath,
  type ProjectRequest,
} from '../src/project-binding.js';
import { visibleText } from '../src/tui/screen.js';
import { AgentTui } from '../src/tui/session.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function request(overrides: Partial<ProjectRequest> = {}): ProjectRequest {
  return {
    cwd: '/work/repo',
    noProject: false,
    home: '/Users/me',
    platform: 'darwin',
    realpath: (target) => target,
    isDirectory: () => true,
    ...overrides,
  };
}

describe('resolveProjectRequest', () => {
  it('binds the current directory when no flag is set', () => {
    expect(resolveProjectRequest(request())).toEqual({
      kind: 'bind',
      dir: '/work/repo',
      explicit: false,
    });
  });

  it('keeps a per-chat workspace for --no-project', () => {
    expect(resolveProjectRequest(request({ noProject: true }))).toEqual({ kind: 'none' });
  });

  it('rejects --no-project combined with a directory flag', () => {
    const spec = resolveProjectRequest(request({ noProject: true, projectArg: '/work/repo' }));
    expect(spec.kind).toBe('error');
    if (spec.kind === 'error') expect(spec.message).toContain('不能与');
  });

  it('treats --cwd and --project as the same directory', () => {
    const spec = resolveProjectRequest(request({
      projectArg: '/work/repo',
      cwdArg: '/work/link',
      realpath: (target) => (target.endsWith('/link') ? '/work/repo' : target),
    }));
    expect(spec).toEqual({ kind: 'bind', dir: '/work/repo', explicit: true });
  });

  it('rejects --cwd and --project when they are different directories', () => {
    const spec = resolveProjectRequest(request({ projectArg: '/work/a', cwdArg: '/work/b' }));
    expect(spec.kind).toBe('error');
    if (spec.kind === 'error') expect(spec.message).toContain('不同目录');
  });

  it('reports a missing directory and a file', () => {
    const missing = resolveProjectRequest(request({
      projectArg: 'gone',
      realpath: () => {
        throw new Error('ENOENT');
      },
    }));
    expect(missing.kind).toBe('error');
    if (missing.kind === 'error') expect(missing.message).toContain('目录不存在：/work/repo/gone');

    const file = resolveProjectRequest(request({ projectArg: '/work/file', isDirectory: () => false }));
    expect(file.kind).toBe('error');
    if (file.kind === 'error') expect(file.message).toContain('不是目录');
  });

  it('refuses to bind home, root, and system directories unless asked', () => {
    const home = resolveProjectRequest(request({ cwd: '/Users/me' }));
    expect(home).toMatchObject({ kind: 'error', reason: 'protected', protectedKind: 'home' });
    if (home.kind === 'error') expect(home.message).toBe(protectedRunMessage('home'));

    const root = resolveProjectRequest(request({ cwd: '/' }));
    expect(root).toMatchObject({ reason: 'protected', protectedKind: 'root' });

    const system = resolveProjectRequest(request({ projectArg: '/usr' }));
    expect(system).toEqual({ kind: 'bind', dir: '/usr', explicit: true });

    const linux = resolveProjectRequest(request({ cwd: '/etc', platform: 'linux' }));
    expect(linux).toMatchObject({ protectedKind: 'system' });

    const windows = resolveProjectRequest(request({
      cwd: 'C:\\Windows',
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      home: 'C:\\Users\\me',
    }));
    expect(windows).toMatchObject({ protectedKind: 'system' });

    const drive = resolveProjectRequest(request({
      cwd: 'C:\\',
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      home: 'C:\\Users\\me',
    }));
    expect(drive).toMatchObject({ protectedKind: 'root' });

    const asked = resolveProjectRequest(request({
      cwd: 'C:\\Users\\me',
      projectArg: 'C:\\Windows',
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      home: 'C:\\Users\\me',
    }));
    expect(asked).toEqual({ kind: 'bind', dir: 'C:\\Windows', explicit: true });

    const underSystem = resolveProjectRequest(request({ cwd: '/usr/local' }));
    expect(underSystem).toEqual({ kind: 'bind', dir: '/usr/local', explicit: false });
    const underVar = resolveProjectRequest(request({ cwd: '/var/log', platform: 'linux' }));
    expect(underVar).toEqual({ kind: 'bind', dir: '/var/log', explicit: false });

    const foldedHome = resolveProjectRequest(request({
      cwd: 'c:\\users\\me',
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      home: 'C:\\Users\\Me',
    }));
    expect(foldedHome).toMatchObject({ protectedKind: 'home' });

    const foldedSystem = resolveProjectRequest(request({
      cwd: 'C:\\windows',
      platform: 'win32',
      systemRoot: 'C:\\WINDOWS',
      home: 'D:\\Users\\me',
    }));
    expect(foldedSystem).toMatchObject({ protectedKind: 'system' });
  });

  it('shortens a project path from the left and labels an unbound workspace', () => {
    expect(shortenProjectPath('/Users/me/code/my-repo')).toBe('…/code/my-repo');
    const long = '/Users/me/work/clients/2026/october/phase1/repo-with-a-very-long-directory-name-extra';
    expect(long.length).toBeGreaterThan(80);
    expect(shortenProjectPath(long)).toBe('…/phase1/repo-with-a-very-long-directory-name-extra');
    expect(projectStatusLabel({ name: 'my-repo', folderPath: '/Users/me/code/my-repo' })).toBe('项目 my-repo · …/code/my-repo');
    expect(projectStatusLabel(null)).toBe('独立工作区');
    expect(protectedTuiMessage('home')).toContain('tui --no-project');
  });
});

describe('project binding command', () => {
  it('prints the first bind and creates the chat in that project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-bind-'));
    dirs.push(dir);
    const calls: Array<{ path: string; body: unknown }> = [];
    const stderr = capture();
    const code = await createCli({
      argv: ['run', 'hello', '--project', dir],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      createClient: async () => recordingClient(calls),
    });
    expect(code).toBe(0);
    expect(stderr.text()).toContain(`已绑定项目 repo：${fs.realpathSync(dir)}`);
    expect(calls[0]).toMatchObject({
      path: '/api/v2/projects/resolve',
      body: { folderPath: fs.realpathSync(dir), origin: 'cli' },
    });
    expect(calls[1]).toMatchObject({
      path: '/api/v2/chats/new',
      body: { projectId: 'proj-1' },
    });
  });

  it('exits 2 when the product has projects disabled', async () => {
    const stderr = capture();
    let started = false;
    const code = await createCli({
      argv: ['run', 'hello', '--project', os.tmpdir()],
      stdout: capture().stream,
      stderr: stderr.stream,
      stdinIsTTY: true,
      createClient: async () => {
        started = true;
        return recordingClient([], 403);
      },
    });
    expect(started).toBe(true);
    expect(code).toBe(2);
    expect(stderr.text()).toContain('该产品未启用项目模式，请使用 --no-project。');
  });

  it('exits 2 before starting the host when the directory is missing', async () => {
    let started = false;
    const stderr = capture();
    const code = await createCli({
      argv: ['run', 'hello', '--project', path.join(os.tmpdir(), 'missing-agent-cli-project')],
      stdout: capture().stream,
      stderr: stderr.stream,
      createClient: async () => {
        started = true;
        throw new Error('host should stay down');
      },
    });
    expect(started).toBe(false);
    expect(code).toBe(2);
    expect(stderr.text()).toContain('目录不存在');
  });

  it('shows the protected-directory screen and leaves on q', async () => {
    const stderr = capture();
    const stdin = Readable.from(['q']);
    const previousCwd = process.cwd();
    process.chdir(os.homedir());
    try {
      const code = await createCli({
        argv: ['tui'],
        stdout: capture().stream,
        stderr: stderr.stream,
        stdin,
        stdinIsTTY: true,
        createClient: async () => {
          throw new Error('host should stay down');
        },
      });
      expect(code).toBe(2);
      expect(stderr.text()).toContain('不会自动把家目录绑定为项目');
      expect(stderr.text()).toContain('<product> tui --project');
      expect(stderr.text()).toContain('q 退出');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('names the command when refusing to bind the home directory', async () => {
    const stderr = capture();
    const previousCwd = process.cwd();
    process.chdir(os.homedir());
    try {
      const code = await createCli({
        argv: ['run', '整理下载目录'],
        commandName: 'aroli',
        stdout: capture().stream,
        stderr: stderr.stream,
        stdinIsTTY: true,
        createClient: async () => {
          throw new Error('host should stay down');
        },
      });
      expect(code).toBe(2);
      expect(stderr.text()).toContain('请改用：aroli run --project <目录> "…"');
      expect(stderr.text()).toContain('aroli run --no-project');
      expect(stderr.text()).not.toContain('<product>');
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('tui project label', () => {
  it('shows the project on the status line and reuses it for /new', async () => {
    const bodies: unknown[] = [];
    const session = new AgentTui(recordingClient(bodies), {
      product: 'Demo',
      projectId: 'proj-1',
      projectLabel: '项目 repo · …/code/repo',
      onExit() {},
    });
    await session.open();
    expect(visibleText(session.render(80))).toContain('项目 repo · …/code/repo');
    for (const char of '/new') session.handleInput(char);
    session.handleInput('\r');
    await session.settled();
    expect(bodies).toContainEqual({
      path: '/api/v2/chats/new',
      body: { projectId: 'proj-1' },
    });
  });
});

function recordingClient(calls: Array<{ path: string; body: unknown }>, status = 200): AgentClient {
  return {
    lastStatus: 200,
    request: async (_method, requestPath, body) => {
      calls.push({ path: requestPath, body });
      if (requestPath === '/api/v2/projects/resolve') {
        return {
          status,
          data: status === 200
            ? { project: { id: 'proj-1', name: 'repo', folderPath: fs.realpathSync(String((body as { folderPath?: string }).folderPath)) }, created: true }
            : { error: 'Projects are disabled for this product' },
        };
      }
      return { status: 200, data: { chatId: 'chat-1', chats: [], model: 'demo' } };
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
