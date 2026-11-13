/**
 * Locates the platform runtime bundle installed by `@steerable/runtime-<target>`.
 *
 * A global npm install of the CLI has no packaged `python-runtime/` directory
 * and no framework checkout, so the last fallback before failing is the
 * per-platform package npm picked for this host. The package carries a
 * `runtime.json` descriptor with relative paths and SHA-256 digests; the
 * sidecar interpreter and egress proxy are hashed on first use, the whole
 * declared set only under `doctor --deep`.
 *
 * Lives in Tier 1 because both the host shell (bundled resources, egress
 * proxy) and the published runtime (`@steerable/agent-runtime`) resolve the
 * same bundle, and neither may depend on the host shell.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { hostRuntimeTarget, RUNTIME_TARGETS, type RuntimeTarget } from '@steerable/agent-protocol';

/** One file the platform package declares, relative to the package root. */
export interface RuntimeFile {
  path: string;
  sha256: string;
}

/** Parsed `runtime.json` of one platform package. */
export interface PlatformRuntimeManifest {
  schemaVersion: 1;
  target: RuntimeTarget;
  /** Rust engine version this bundle was built against. */
  engineVersion: string;
  /** Package version that shipped the bundle. */
  packageVersion: string;
  sidecarPython: string;
  runCodePython: string;
  egressProxy: string | null;
  winSpawnHelper: string | null;
  files: RuntimeFile[];
}

/** A resolved, digest-checked platform runtime. */
export interface PlatformRuntime {
  manifest: PlatformRuntimeManifest;
  packageName: string;
  packageDir: string;
  sidecarPython: string;
  runCodePython: string;
  egressProxy: string | null;
  winSpawnHelper: string | null;
}

/** Why no platform runtime was resolved. */
export type PlatformRuntimeFailureReason =
  | 'unsupported_platform'
  | 'not_installed'
  | 'invalid_manifest'
  | 'digest_mismatch';

export interface PlatformRuntimeFailure {
  kind: 'error';
  reason: PlatformRuntimeFailureReason;
  /** Host target, or null when the platform itself is unpublished. */
  target: RuntimeTarget | null;
  detail: string;
  /** File that failed the digest check, when `reason` is `digest_mismatch`. */
  file?: string;
  expected?: string;
  actual?: string;
}

export type PlatformRuntimeResult = { kind: 'ok'; runtime: PlatformRuntime } | PlatformRuntimeFailure;

/** Default package scope for platform bundles. */
export const PLATFORM_PACKAGE_SCOPE = '@steerable/runtime-';

let cached: PlatformRuntimeResult | null = null;

/** Drops the per-process cache; tests and `doctor --deep` use it. */
export function resetPlatformRuntimeCache(): void {
  cached = null;
}

/** @param target A published runtime target. @returns The npm package name that ships it. */
export function platformPackageName(target: RuntimeTarget): string {
  return `${PLATFORM_PACKAGE_SCOPE}${target}`;
}

/**
 * Resolves the platform runtime for this host, checking the two executables
 * the sidecar boot path needs.
 *
 * The result is cached per process: a global install cannot gain a different
 * bundle while the process runs, and hashing the interpreter on every tool
 * call would add startup cost for no benefit.
 *
 * @returns The resolved runtime, or a structured failure that names the fix.
 */
export function resolvePlatformRuntime(): PlatformRuntimeResult {
  if (cached) return cached;
  cached = resolveUncached();
  return cached;
}

function resolveUncached(): PlatformRuntimeResult {
  const target = hostRuntimeTarget(process.platform, process.arch);
  if (!target) {
    return {
      kind: 'error',
      reason: 'unsupported_platform',
      target: null,
      detail: `${process.platform}-${process.arch}`,
    };
  }
  const packageName = platformPackageName(target);
  const require = createRequire(import.meta.url);
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${packageName}/runtime.json`);
  } catch {
    // The package is absent, or present without the descriptor: both mean the
    // install cannot supply a verified runtime.
    return {
      kind: 'error',
      reason: 'not_installed',
      target,
      detail: packageName,
    };
  }
  const packageDir = dirname(manifestPath);
  const manifest = readManifest(manifestPath, target, packageName);
  if (typeof manifest === 'string') {
    return { kind: 'error', reason: 'invalid_manifest', target, detail: manifest };
  }
  const sidecarPython = resolveDeclaredFile(packageDir, manifest.sidecarPython);
  const runCodePython = resolveDeclaredFile(packageDir, manifest.runCodePython);
  if (!sidecarPython || !runCodePython) {
    return {
      kind: 'error',
      reason: 'invalid_manifest',
      target,
      detail: `${packageName}: declared interpreter is missing from the package`,
    };
  }
  const sidecarDigest = manifest.files.find((file) => file.path === manifest.sidecarPython);
  const mismatch = sidecarDigest ? verifyFile(packageDir, sidecarDigest) : null;
  if (mismatch) return { ...mismatch, target };
  const proxy = manifest.egressProxy ? resolveDeclaredFile(packageDir, manifest.egressProxy) : null;
  const proxyDigest = manifest.files.find((file) => file.path === manifest.egressProxy);
  if (proxy && proxyDigest) {
    const proxyMismatch = verifyFile(packageDir, proxyDigest);
    if (proxyMismatch) return { ...proxyMismatch, target };
  }
  return {
    kind: 'ok',
    runtime: {
      manifest,
      packageName,
      packageDir,
      sidecarPython,
      runCodePython,
      egressProxy: proxy,
      winSpawnHelper: manifest.winSpawnHelper
        ? resolveDeclaredFile(packageDir, manifest.winSpawnHelper)
        : null,
    },
  };
}

/**
 * Verifies every file the manifest declares, not just the executables the
 * boot path touches. `doctor --deep` reports the first mismatch.
 *
 * @returns The mismatch, or null when every declared file matches.
 */
export function verifyPlatformRuntimeDeep(runtime: PlatformRuntime): PlatformRuntimeFailure | null {
  for (const file of runtime.manifest.files) {
    const mismatch = verifyFile(runtime.packageDir, file);
    if (mismatch) return { ...mismatch, target: runtime.manifest.target };
  }
  return null;
}

function readManifest(manifestPath: string, target: RuntimeTarget, packageName: string): PlatformRuntimeManifest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return `${packageName}: unreadable runtime.json (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${packageName}: runtime.json is not an object`;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return `${packageName}: unknown runtime.json schemaVersion`;
  if (record.target !== target) return `${packageName}: runtime.json targets ${String(record.target)}`;
  if (typeof record.sidecarPython !== 'string' || !record.sidecarPython) {
    return `${packageName}: runtime.json has no sidecarPython`;
  }
  if (typeof record.runCodePython !== 'string' || !record.runCodePython) {
    return `${packageName}: runtime.json has no runCodePython`;
  }
  const files: RuntimeFile[] = [];
  if (Array.isArray(record.files)) {
    for (const entry of record.files) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.path === 'string' && typeof row.sha256 === 'string') {
        files.push({ path: row.path, sha256: row.sha256.toLowerCase() });
      }
    }
  }
  if (files.length === 0) return `${packageName}: runtime.json declares no files`;
  return {
    schemaVersion: 1,
    target,
    engineVersion: typeof record.engineVersion === 'string' ? record.engineVersion : '',
    packageVersion: typeof record.packageVersion === 'string' ? record.packageVersion : '',
    sidecarPython: record.sidecarPython,
    runCodePython: record.runCodePython,
    egressProxy: typeof record.egressProxy === 'string' && record.egressProxy ? record.egressProxy : null,
    winSpawnHelper:
      typeof record.winSpawnHelper === 'string' && record.winSpawnHelper ? record.winSpawnHelper : null,
    files,
  };
}

/** Declared paths are package-relative; anything absolute or escaping the package is refused. */
function resolveDeclaredFile(packageDir: string, relative: string): string | null {
  if (isAbsolute(relative)) return null;
  const resolved = normalize(join(packageDir, relative));
  const root = normalize(packageDir);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return null;
  return existsSync(resolved) ? resolved : null;
}

function verifyFile(packageDir: string, file: RuntimeFile): (Omit<PlatformRuntimeFailure, 'target'> & { kind: 'error' }) | null {
  const path = resolveDeclaredFile(packageDir, file.path);
  if (!path) {
    return {
      kind: 'error',
      reason: 'digest_mismatch',
      detail: `declared file is missing: ${file.path}`,
      file: file.path,
      expected: file.sha256,
      actual: '(missing)',
    };
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual === file.sha256) return null;
  return {
    kind: 'error',
    reason: 'digest_mismatch',
    detail: file.path,
    file: file.path,
    expected: file.sha256,
    actual,
  };
}

/** @returns A one-line description of the supported targets, for error text. */
export function supportedTargetsLine(): string {
  return RUNTIME_TARGETS.join(', ');
}
