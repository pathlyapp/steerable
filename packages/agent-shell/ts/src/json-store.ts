/**
 * JSON 键值存储工厂（agent-mcp-servers.json / agent-projects.json /
 * agent-local-scripts.json）。文件在 getUserDataDir() 下，由 conf 读写；
 * 桌面与 BS server 得到同一个文件路径。
 *
 * conf@10 的 d.ts 是 ESM 风格但包本身没有 `type: module`，NodeNext 下类型
 * 解析会塌成 namespace——所以这里声明用到的最小接口并做一次强转，不依赖
 * 它的声明文件。
 */
import ConfImport from 'conf';
import { getUserDataDir } from './runtime.js';
import { fileLockPath } from './storage/process-locks.js';
import { acquireWriteLease } from './storage/write-lease.js';

export interface JsonStore<T extends Record<string, unknown>> {
  get<Key extends keyof T>(key: Key): T[Key];
  get<Key extends keyof T>(key: Key, defaultValue: Required<T>[Key]): Required<T>[Key];
  set<Key extends keyof T>(key: Key, value?: T[Key]): void;
}

type ConfCtor = new <T extends Record<string, unknown>>(options: {
  cwd: string;
  name: string;
  defaults?: Partial<T>;
}) => JsonStore<T>;

const Conf = ConfImport as unknown as ConfCtor;

export function createJsonStore<T extends Record<string, unknown>>(options: {
  name: string;
  defaults?: Partial<T>;
}): JsonStore<T> {
  const store = new Conf<T>({
    cwd: getUserDataDir(),
    name: options.name,
    defaults: options.defaults,
  });
  const lockPath = fileLockPath(getUserDataDir(), options.name);
  return {
    get: store.get.bind(store) as JsonStore<T>['get'],
    // set is wrapped below so two processes cannot clobber a read-modify-write.
    set(key, value) {
      const lease = acquireWriteLease(lockPath, 5_000);
      try {
        store.set(key, value);
      } finally {
        lease.release();
      }
    },
  };
}
