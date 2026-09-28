import { StoreAlreadyOwnedError } from './write-lease.js';

/** Maps write-lease contention to a readable startup failure and process exit. */
export function acquireWriteLeaseOrExit<T>(
  acquire: () => T,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): T {
  try {
    return acquire();
  } catch (error) {
    if (error instanceof StoreAlreadyOwnedError) {
      console.error(
        `[bs] 本地数据库正在被另一个进程使用（${error.lockPath}）。\n` +
          '[bs] 再打开一次桌面应用会回到已经打开的窗口。\n' +
          '[bs] 如果终端里的 pnpm dev:bs 占着数据库，请先在那个终端按 Ctrl+C 停掉，再重新打开。',
      );
      queueMicrotask(() => exitProcess(1));
    }
    throw error;
  }
}
