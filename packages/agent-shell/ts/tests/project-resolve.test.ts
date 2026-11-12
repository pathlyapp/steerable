import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createJsonStore } from '../src/json-store.js';
import { ProjectRegistry, type ProjectRecord } from '../src/project-registry.js';

function memoryStore(seed: ProjectRecord[] = []) {
  let data = seed;
  return {
    get: () => data,
    set: (_key: 'projects', value: ProjectRecord[]) => {
      data = value;
    },
  };
}

const realpath = (target: string) => target;

describe('ProjectRegistry.createUnique', () => {
  it('keeps the name, then appends -2 and -3, ignoring case', () => {
    const registry = new ProjectRegistry(memoryStore());
    expect(registry.createUnique({ name: 'pkg', folderPath: '/work/a' }).name).toBe('pkg');
    expect(registry.createUnique({ name: 'PKG', folderPath: '/work/b' }).name).toBe('PKG-2');
    registry.create({ name: 'pkg-3', folderPath: '/work/c' });
    expect(registry.createUnique({ name: 'pkg', folderPath: '/work/d' }).name).toBe('pkg-4');
    expect(() => registry.createUnique({ name: '  ', folderPath: '/work/e' })).toThrow('项目名称不能为空');
    expect(() => registry.createUnique({ name: 'pkg', folderPath: '  ' })).toThrow('项目文件夹不能为空');
  });
});

describe('ProjectRegistry.resolveByFolder', () => {
  it('reuses an exact folder and a containing project, then creates a unique cli name', () => {
    const registry = new ProjectRegistry(memoryStore());
    registry.create({ name: 'other', folderPath: '/work/other' });
    const parent = registry.create({ name: 'repo', folderPath: '/work/repo' });

    const exact = registry.resolveByFolder('/work/repo', { origin: 'cli', realpath });
    expect(exact.created).toBe(false);
    expect(exact.project.id).toBe(parent.id);
    expect(exact.project.origin).toBeUndefined();

    const nested = registry.resolveByFolder('/work/repo/pkg', { origin: 'cli', realpath });
    expect(nested.created).toBe(false);
    expect(nested.project.id).toBe(parent.id);

    const created = registry.resolveByFolder('/work/repo-name', { origin: 'cli', realpath });
    expect(created.created).toBe(true);
    expect(created.project.origin).toBe('cli');
    expect(created.project.folderPath).toBe('/work/repo-name');

    registry.create({ name: 'pkg', folderPath: '/elsewhere/pkg' });
    const renamed = registry.resolveByFolder('/fresh/pkg', { origin: 'cli', realpath });
    expect(renamed.project.name).toBe('pkg-2');
    expect(renamed.project.origin).toBe('cli');
  });

  it('follows a symlink to the stored folder', () => {
    const registry = new ProjectRegistry(memoryStore());
    const stored = registry.create({ name: 'repo', folderPath: '/work/repo' });
    const found = registry.findByFolder('/work/link', (target) => (target === '/work/link' ? '/work/repo' : target));
    expect(found?.id).toBe(stored.id);
  });

  it('keeps the recorded path when the directory has been removed', () => {
    const registry = new ProjectRegistry(memoryStore());
    const stored = registry.create({ name: 'repo', folderPath: '/gone/repo' });
    const found = registry.findByFolder('/gone/repo', () => {
      throw new Error('ENOENT');
    });
    expect(found?.id).toBe(stored.id);
  });

  it('reuses a Windows folder when only the letter case differs', () => {
    const registry = new ProjectRegistry(memoryStore());
    const stored = registry.create({ name: 'repo', folderPath: 'C:\\Work\\Repo' });
    const exact = registry.resolveByFolder('c:\\work\\repo', { platform: 'win32', realpath });
    expect(exact.created).toBe(false);
    expect(exact.project.id).toBe(stored.id);

    const nested = registry.resolveByFolder('c:\\work\\repo\\src', { platform: 'win32', realpath });
    expect(nested.created).toBe(false);
    expect(nested.project.id).toBe(stored.id);

    const sibling = registry.resolveByFolder('C:\\Work\\Repo-extra', { origin: 'cli', platform: 'win32', realpath });
    expect(sibling.created).toBe(true);
    expect(sibling.project.id).not.toBe(stored.id);
    expect(sibling.project.name).toBe('Repo-extra');
  });

  it('reuses a child directory whose name starts with ..', () => {
    const registry = new ProjectRegistry(memoryStore());
    const stored = registry.create({ name: 'repo', folderPath: '/work/repo' });
    const nested = registry.resolveByFolder('/work/repo/..notes', { origin: 'cli', realpath });
    expect(nested.created).toBe(false);
    expect(nested.project.id).toBe(stored.id);
  });

  it('keeps POSIX paths case-sensitive', () => {
    const registry = new ProjectRegistry(memoryStore());
    registry.create({ name: 'repo', folderPath: '/Work/Repo' });
    const created = registry.resolveByFolder('/work/repo', { origin: 'cli', platform: 'darwin', realpath });
    expect(created.created).toBe(true);
    expect(created.project.folderPath).toBe('/work/repo');
  });

  it('picks the longest containing project', () => {
    const registry = new ProjectRegistry(memoryStore());
    registry.create({ name: 'root', folderPath: '/work' });
    const inner = registry.create({ name: 'inner', folderPath: '/work/repo' });
    const resolved = registry.resolveByFolder('/work/repo/src', { realpath });
    expect(resolved.project.id).toBe(inner.id);
    expect(resolved.created).toBe(false);
  });
});

describe('project resolve across processes', () => {
  it('creates one project when two processes bind the same directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-projects-race-'));
    const dataDir = path.join(root, 'data');
    const folder = path.join(root, 'repo');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(folder);
    const gate = path.join(root, 'gate');
    const script = path.join(root, 'bind.mjs');
    fs.writeFileSync(script, childScript());
    try {
      const first = spawnBind(script, dataDir, folder, gate);
      const second = spawnBind(script, dataDir, folder, gate);
      await Promise.all([first.ready, second.ready]);
      fs.writeFileSync(gate, 'go');
      const results = await Promise.all([first.done, second.done]);
      expect(results.map((result) => result.code)).toEqual([0, 0]);
      const projects = results.map((result) => JSON.parse(result.stdout) as { id: string; created: boolean });
      expect(new Set(projects.map((project) => project.id)).size).toBe(1);
      expect(projects.filter((project) => project.created)).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('binds a symlink and a subdirectory to the project that owns the real directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-projects-link-'));
    const dataDir = path.join(root, 'data');
    const folder = path.join(root, 'repo');
    const nested = path.join(folder, 'src');
    const link = path.join(root, 'link');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(nested, { recursive: true });
    fs.symlinkSync(folder, link, 'dir');
    const gate = path.join(root, 'gate');
    fs.writeFileSync(gate, 'go');
    const script = path.join(root, 'bind.mjs');
    fs.writeFileSync(script, childScript());
    try {
      const bound = await finishBind(spawnBind(script, dataDir, folder, gate));
      const viaLink = await finishBind(spawnBind(script, dataDir, link, gate));
      const viaChild = await finishBind(spawnBind(script, dataDir, nested, gate));
      expect(viaLink).toEqual({ id: bound.id, created: false });
      expect(viaChild).toEqual({ id: bound.id, created: false });
      expect(bound.created).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function childScript(): string {
  const registry = new URL('../src/project-registry.ts', import.meta.url);
  const store = new URL('../src/json-store.ts', import.meta.url);
  return `
import fs from 'node:fs';
import { createJsonStore } from ${JSON.stringify(store.href)};
import { ProjectRegistry } from ${JSON.stringify(registry.href)};
const dataDir = process.argv[2];
const folder = process.argv[3];
const gate = process.argv[4];
process.env.DEEPPATH_USER_DATA_DIR = dataDir;
const registry = new ProjectRegistry(createJsonStore({
  name: 'agent-projects',
  defaults: { projects: [] },
}));
process.stdout.write('ready\\n');
while (!fs.existsSync(gate)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
const resolved = registry.resolveByFolder(folder, { origin: 'cli' });
process.stdout.write(JSON.stringify({ id: resolved.project.id, created: resolved.created }));
`;
}

async function finishBind(child: ReturnType<typeof spawnBind>): Promise<{ id: string; created: boolean }> {
  await child.ready;
  const result = await child.done;
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as { id: string; created: boolean };
}

function spawnBind(script: string, dataDir: string, folder: string, gate: string): {
  ready: Promise<void>;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
} {
  const loader = viteNodeLoader();
  const child = spawn(process.execPath, [loader, script, dataDir, folder, gate], {
    env: { ...process.env, DEEPPATH_USER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bind child did not start: ${stderr}`)), 8_000);
    const watch = () => {
      if (!stdout.includes('ready')) return;
      clearTimeout(timer);
      child.stdout.off('data', watch);
      resolve();
    };
    child.stdout.on('data', watch);
    watch();
  });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) resolve({ code, stdout: stdout.replace('ready\n', ''), stderr });
      else reject(new Error(`bind child exited ${code}: ${stderr}\n${stdout}`));
    });
  });
  return { ready, done };
}

describe('project file', () => {
  it('copies projects out of the shared config.json once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-projects-file-'));
    const previous = process.env.DEEPPATH_USER_DATA_DIR;
    process.env.DEEPPATH_USER_DATA_DIR = root;
    const project = {
      id: 'p1',
      name: 'repo',
      folderPath: '/work/repo',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      projects: [project],
      mcpServers: [{ id: 'mcp-1' }],
      localScripts: [],
    }));
    try {
      const registry = new ProjectRegistry(createJsonStore({
        name: 'agent-projects',
        defaults: { projects: [] },
      }));
      expect(registry.list().map((item) => item.id)).toEqual(['p1']);
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'agent-projects.json'), 'utf8')) as {
        projects: Array<{ id: string }>;
      };
      expect(saved.projects.map((item) => item.id)).toEqual(['p1']);
      const legacy = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) as {
        mcpServers: Array<{ id: string }>;
      };
      expect(legacy.mcpServers.map((item) => item.id)).toEqual(['mcp-1']);

      registry.create({ name: 'other', folderPath: '/work/other' });
      const mcp = createJsonStore<{ mcpServers: Array<{ id: string }> }>({
        name: 'agent-mcp-servers',
        defaults: { mcpServers: [] },
      });
      expect(mcp.get('mcpServers').map((item) => item.id)).toEqual(['mcp-1']);
      const projectsAfter = JSON.parse(fs.readFileSync(path.join(root, 'agent-projects.json'), 'utf8')) as {
        projects: unknown[];
      };
      expect(projectsAfter.projects).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.DEEPPATH_USER_DATA_DIR;
      else process.env.DEEPPATH_USER_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function viteNodeLoader(): string {
  const requireFromVitest = createRequire(new URL('../node_modules/vitest/package.json', import.meta.url));
  return requireFromVitest.resolve('vite-node/vite-node.mjs');
}
