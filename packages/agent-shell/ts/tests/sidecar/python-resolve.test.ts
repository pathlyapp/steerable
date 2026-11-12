/**
 * resolveSidecarPython 的覆盖优先级：显式参数 > STEERABLE_SIDECAR_PYTHON
 * （Tauri 宿主注入打包的 python-runtime 解释器）> 内置布局探测。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSidecarPython } from '../../src/sidecar/supervisor.js';

describe('resolveSidecarPython overrides', () => {
  let scratch = '';
  let prevEnv: string | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'python-resolve-'));
    prevEnv = process.env.STEERABLE_SIDECAR_PYTHON;
    delete process.env.STEERABLE_SIDECAR_PYTHON;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.STEERABLE_SIDECAR_PYTHON;
    else process.env.STEERABLE_SIDECAR_PYTHON = prevEnv;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('uses STEERABLE_SIDECAR_PYTHON when the file exists', () => {
    const override = join(scratch, 'override-python');
    writeFileSync(override, '');
    process.env.STEERABLE_SIDECAR_PYTHON = override;
    expect(resolveSidecarPython()).toBe(override);
  });

  it('prefers an explicit interpreter over STEERABLE_SIDECAR_PYTHON', () => {
    const override = join(scratch, 'override-python');
    writeFileSync(override, '');
    process.env.STEERABLE_SIDECAR_PYTHON = override;
    expect(resolveSidecarPython('/explicit/python3')).toBe('/explicit/python3');
  });
});
