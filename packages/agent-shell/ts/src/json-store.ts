/**
 * JSON 键值存储工厂（agent-mcp-servers.json / agent-projects.json /
 * agent-local-scripts.json）。文件在 getUserDataDir() 下，由 conf 读写；
 * 桌面与 BS server 得到同一个文件路径。
 *
 * conf@10 的 d.ts 是 ESM 风格但包本身没有 `type: module`，NodeNext 下类型
 * 解析会塌成 namespace——所以这里声明用到的最小接口并做一次强转，不依赖
 * 它的声明文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import ConfImport from 'conf';
import { getUserDataDir } from './runtime.js';
import { fileLockPath } from './storage/process-locks.js';
import { acquireWriteLease } from './storage/write-lease.js';

export interface JsonStore<T extends Record<string, unknown>> {
  get<Key extends keyof T>(key: Key): T[Key];
  get<Key extends keyof T>(key: Key, defaultValue: Required<T>[Key]): Required<T>[Key];
  set<Key extends keyof T>(key: Key, value?: T[Key]): void;
  mutate<Key extends keyof T>(key: Key, update: (current: T[Key]) => T[Key]): T[Key];
}

type ConfCtor = new <T extends Record<string, unknown>>(options: {
  cwd: string;
  configName: string;
  defaults?: Partial<T>;
}) => JsonStore<T>;

const Conf = ConfImport as unknown as ConfCtor;

export function createJsonStore<T extends Record<string, unknown>>(options: {
  name: string;
  defaults?: Partial<T>;
}): JsonStore<T> {
  const cwd = getUserDataDir();
  const store = new Conf<T>({
    cwd,
    configName: options.name,
    defaults: defaultsFromLegacy(cwd, options.name, options.defaults),
  });
  const lockPath = fileLockPath(getUserDataDir(), options.name);
  return {
    get: store.get.bind(store) as JsonStore<T>['get'],
    set(key, value) {
      const lease = acquireWriteLease(lockPath, 5_000);
      try {
        store.set(key, value);
      } finally {
        lease.release();
      }
    },
    mutate(key, update) {
      const lease = acquireWriteLease(lockPath, 5_000);
      try {
        const next = update(store.get(key));
        store.set(key, next);
        return next;
      } finally {
        lease.release();
      }
    },
  };
}

/**
 * Older builds passed `name` to conf, which only reads `configName` and
 * therefore stored every registry in `config.json`. Copy this registry's
 * keys once, and leave the old file in place.
 */
function defaultsFromLegacy<T extends Record<string, unknown>>(
  cwd: string,
  name: string,
  defaults: Partial<T> | undefined,
): Partial<T> | undefined {
  if (defaults === undefined) return undefined;
  const target = path.join(cwd, `${name}.json`);
  const legacy = path.join(cwd, 'config.json');
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return defaults;
  const record = readRecord(legacy);
  if (!record) return defaults;
  const seeded: Partial<T> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (key in record) seeded[key as keyof T] = record[key] as T[keyof T];
  }
  return seeded;
}

function readRecord(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
