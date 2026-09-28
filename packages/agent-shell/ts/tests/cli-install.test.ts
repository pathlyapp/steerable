import { describe, expect, it } from 'vitest';

import { installCliLink, resolveCliScript } from '../src/cli-install.js';

describe('installCliLink', () => {
  it('writes an executable wrapper into a home directory that is already on PATH', () => {
    const files = new Map<string, string>();
    const modes = new Map<string, number>();
    const dirs = new Set<string>(['/home/me/.local/bin']);
    const result = installCliLink({
      binName: 'aroli',
      scriptPath: '/app/products/aroli/cli.mjs',
      nodePath: '/usr/local/bin/node',
      home: '/home/me',
      pathEnv: '/usr/bin:/home/me/.local/bin',
      platform: 'linux',
      exists: (target) => dirs.has(target) || files.has(target),
      canWrite: (dir) => dir.startsWith('/home/me'),
      mkdir: (dir) => dirs.add(dir),
      writeFile: (file, contents) => files.set(file, contents),
      chmod: (file, mode) => modes.set(file, mode),
    });
    expect(result).toEqual({ path: '/home/me/.local/bin/aroli', onPath: true });
    expect(files.get('/home/me/.local/bin/aroli')).toBe(
      "#!/bin/sh\nexec '/usr/local/bin/node' '/app/products/aroli/cli.mjs' \"$@\"\n",
    );
    expect(modes.get('/home/me/.local/bin/aroli')).toBe(0o755);
  });

  it('creates ~/.local/bin when no home directory is on PATH', () => {
    const files = new Map<string, string>();
    const dirs = new Set<string>(['/home/me']);
    const result = installCliLink({
      binName: 'ciflog',
      scriptPath: '/app/products/ciflog/cli.js',
      nodePath: '/node',
      home: '/home/me',
      pathEnv: '/usr/bin:/usr/local/bin',
      platform: 'darwin',
      exists: (target) => dirs.has(target) || files.has(target),
      canWrite: (dir) => dir.startsWith('/home/me'),
      mkdir: (dir) => dirs.add(dir),
      writeFile: (file, contents) => files.set(file, contents),
      chmod: () => undefined,
    });
    expect(result.onPath).toBe(false);
    expect(result.path).toBe('/home/me/.local/bin/ciflog');
    expect(dirs.has('/home/me/.local/bin')).toBe(true);
  });

  it('writes a cmd wrapper on Windows', () => {
    const files = new Map<string, string>();
    const result = installCliLink({
      binName: 'etown',
      scriptPath: 'C:\\app\\cli.js',
      nodePath: 'C:\\node\\node.exe',
      home: 'C:\\Users\\me',
      pathEnv: 'C:\\Windows;C:\\Users\\me\\bin',
      platform: 'win32',
      exists: () => true,
      canWrite: () => true,
      mkdir: () => undefined,
      writeFile: (file, contents) => files.set(file, contents),
      chmod: () => undefined,
    });
    expect(result).toEqual({ path: 'C:\\Users\\me\\bin\\etown.cmd', onPath: true });
    expect(files.get(result.path)).toContain('"C:\\node\\node.exe" "C:\\app\\cli.js"');
  });
});

describe('resolveCliScript', () => {
  it('prefers the repo launcher, then the packaged entry', () => {
    expect(resolveCliScript('/repo', 'aroli', (target) => target.endsWith('cli.mjs'))).toBe(
      '/repo/products/aroli/cli.mjs',
    );
    expect(resolveCliScript('/app', 'aroli', (target) => target.endsWith('cli.js') && !target.includes('/dist/'))).toBe(
      '/app/products/aroli/cli.js',
    );
  });
});
