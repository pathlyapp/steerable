import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyHostRuntimeEnv } from '../src/host-runtime-env.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('applyHostRuntimeEnv', () => {
  it('fills an unset variable from host-runtime.json when the file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-runtime-env-'));
    dirs.push(dir);
    const python = path.join(dir, 'python');
    fs.writeFileSync(python, '');
    fs.writeFileSync(path.join(dir, 'host-runtime.json'), JSON.stringify({ python }));
    const env: NodeJS.ProcessEnv = {};
    const report = applyHostRuntimeEnv(dir, env);
    expect(env.STEERABLE_PYTHON).toBe(python);
    expect(report.entries.find((entry) => entry.key === 'STEERABLE_PYTHON')).toMatchObject({
      source: 'file',
      path: python,
    });
  });

  it('keeps an explicit environment variable and skips a missing path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-runtime-env-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'host-runtime.json'),
      JSON.stringify({ python: path.join(dir, 'missing'), sidecarPython: path.join(dir, 'also-missing') }),
    );
    const env: NodeJS.ProcessEnv = { STEERABLE_PYTHON: '/already/set' };
    const report = applyHostRuntimeEnv(dir, env);
    expect(env.STEERABLE_PYTHON).toBe('/already/set');
    expect(env.STEERABLE_SIDECAR_PYTHON).toBeUndefined();
    expect(report.entries.find((entry) => entry.key === 'STEERABLE_PYTHON')?.source).toBe('env');
    expect(report.entries.find((entry) => entry.key === 'STEERABLE_SIDECAR_PYTHON')?.source).toBe('missing');
  });
});
