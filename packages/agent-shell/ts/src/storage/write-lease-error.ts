import { StoreAlreadyOwnedError } from './write-lease.js';

interface ElectronExit {
  app: { exit(code: number): void };
  dialog: { showErrorBox(title: string, message: string): void };
}

/** Maps write-lease contention to the desktop's user-facing startup failure. */
export function acquireWriteLeaseOrExit<T>(
  acquire: () => T,
  loadElectron: () => Promise<ElectronExit> = () =>
    import('electron') as unknown as Promise<ElectronExit>,
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
      void loadElectron()
        .then(({ app, dialog }) => {
          dialog.showErrorBox(
            '无法再开一个',
            '再打开一次应用时，会回到已经打开的窗口。\n\n这次没有回到那个窗口，是因为本地数据库正被另一个进程占用。如果终端里还在跑 pnpm dev:bs，先停掉它，再重新打开。',
          );
          app.exit(1);
        })
        .catch(() => exitProcess(1));
    }
    throw error;
  }
}
