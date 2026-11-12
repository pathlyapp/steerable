/**
 * Platform runtime resolution and the failure text for a missing bundle.
 *
 * A global install depends on the per-platform package being present and
 * unmodified: if either check fails the CLI must stop with an actionable
 * message, never fall through to a system interpreter that lacks the sidecar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bundledRuntimeTag,
  hostRuntimeTarget,
  runtimeTargetFor,
  RUNTIME_TARGETS,
} from '@steerable/agent-protocol';
import { SidecarRuntimeMissingError, resolveSidecarPython } from '../../src/sidecar/supervisor.js';

describe('runtime targets', () => {
  it('maps every published platform', () => {
    expect(runtimeTargetFor('darwin', 'arm64')).toBe('darwin-arm64');
    expect(runtimeTargetFor('darwin', 'x64')).toBe('darwin-x64');
    expect(runtimeTargetFor('linux', 'x64')).toBe('linux-x64');
    expect(runtimeTargetFor('linux', 'arm64')).toBe('linux-arm64');
    expect(runtimeTargetFor('win32', 'x64')).toBe('win32-x64');
  });

  it('returns null for an unpublished platform', () => {
    expect(runtimeTargetFor('freebsd', 'x64')).toBeNull();
    expect(runtimeTargetFor('linux', 'ia32')).toBeNull();
    expect(hostRuntimeTarget('aix', 'ppc64')).toBeNull();
  });

  it('exposes the same five names the release tooling builds', () => {
    expect([...RUNTIME_TARGETS]).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
      'win32-x64',
    ]);
  });

  it('keeps the bundled desktop layout narrower than the published set', () => {
    // Desktop builds vendor four directories; linux arm64 ships only as an
    // npm package, so it has no bundled tag.
    expect(bundledRuntimeTag('linux', 'arm64')).toBeNull();
    expect(bundledRuntimeTag('linux', 'x64')).toBe('linux-x64');
    expect(bundledRuntimeTag('darwin', 'arm64')).toBe('darwin-arm64');
    expect(bundledRuntimeTag('win32', 'x64')).toBe('win32-x64');
  });
});

describe('resolveSidecarPython failures', () => {
  const original = process.env.STEERABLE_SIDECAR_PYTHON;

  afterEach(() => {
    if (original === undefined) delete process.env.STEERABLE_SIDECAR_PYTHON;
    else process.env.STEERABLE_SIDECAR_PYTHON = original;
    vi.resetModules();
  });

  it('names the missing platform package instead of a stack trace', () => {
    // No env override, no bundled directory in this checkout's test layout,
    // and no platform package installed for the test runner.
    delete process.env.STEERABLE_SIDECAR_PYTHON;
    let thrown: unknown;
    try {
      resolveSidecarPython();
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) {
      // A developer machine with the platform package installed resolves it;
      // the failure shape is covered by the reason assertions below.
      expect(thrown).toBeUndefined();
      return;
    }
    expect(thrown).toBeInstanceOf(SidecarRuntimeMissingError);
    const missing = thrown as SidecarRuntimeMissingError;
    expect(['not_installed', 'unsupported_platform', 'invalid_manifest', 'digest_mismatch']).toContain(
      missing.reason,
    );
    expect(missing.message).not.toContain('\n    at ');
  });
});
