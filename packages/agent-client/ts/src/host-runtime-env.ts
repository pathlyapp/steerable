import fs from 'node:fs';
import path from 'node:path';

/** Keys the desktop host records in `<userData>/host-runtime.json`. */
export const HOST_RUNTIME_KEYS = [
  ['STEERABLE_SIDECAR_PYTHON', 'sidecarPython'],
  ['STEERABLE_PYTHON', 'python'],
  ['STEERABLE_EGRESS_PROXY_BIN', 'egressProxyBin'],
  ['DEEPPATH_WIN_SPAWN_HELPER', 'winSpawnHelper'],
  ['DEEPPATH_WEB_DIST', 'webDist'],
] as const;

export interface RuntimeEnvEntry {
  key: (typeof HOST_RUNTIME_KEYS)[number][0];
  source: 'env' | 'file' | 'missing';
  path?: string;
}

export interface RuntimeEnvReport {
  dataDir: string;
  filePath: string;
  fileFound: boolean;
  entries: RuntimeEnvEntry[];
}

/**
 * Fills unset runtime variables from `host-runtime.json`.
 * A path that is not on disk is left unset and reported as missing.
 */
export function applyHostRuntimeEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): RuntimeEnvReport {
  const filePath = path.join(dataDir, 'host-runtime.json');
  const file = readHostRuntimeFile(filePath);
  const entries: RuntimeEnvEntry[] = [];
  for (const [key, field] of HOST_RUNTIME_KEYS) {
    const current = env[key];
    if (current && current.trim()) {
      entries.push({ key, source: 'env', path: current });
      continue;
    }
    const recorded = file?.values[field];
    if (recorded && fs.existsSync(recorded)) {
      env[key] = recorded;
      entries.push({ key, source: 'file', path: recorded });
      continue;
    }
    entries.push({ key, source: 'missing', ...(recorded ? { path: recorded } : {}) });
  }
  return { dataDir, filePath, fileFound: file !== null, entries };
}

function readHostRuntimeFile(filePath: string): { values: Record<string, string> } | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const [, field] of HOST_RUNTIME_KEYS) {
      const value = parsed[field];
      if (typeof value === 'string' && value.trim()) values[field] = value;
    }
    return { values };
  } catch {
    return null;
  }
}
