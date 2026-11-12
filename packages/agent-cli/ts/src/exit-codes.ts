/**
 * Command-line exit codes.
 *
 * Scripts branch on these, so the numbering is a contract: values are appended,
 * never reused, and the full list is printed by `--help`.
 */

/** The turn finished. */
export const EXIT_OK = 0;
/** The turn failed. */
export const EXIT_TURN_FAILED = 1;
/** The invocation was wrong: unknown flag, missing argument, wrong value. */
export const EXIT_USAGE = 2;
/** An approval was denied under `--approve deny`. */
export const EXIT_DENIED = 3;
/** The turn exhausted its token budget. */
export const EXIT_BUDGET = 4;
/** Another process holds the chat's write lock. */
export const EXIT_CHAT_BUSY = 6;
/** The data on disk was written by a newer program. */
export const EXIT_STORAGE_UPGRADE = 75;
/** Configuration or the runtime is missing: no key, no runtime bundle, old Node. */
export const EXIT_CONFIG = 78;
/** Interrupted with Ctrl+C. */
export const EXIT_INTERRUPTED = 130;

/** One row of the exit-code table in help output. */
export const EXIT_CODES: readonly { code: number; text: string }[] = [
  { code: EXIT_OK, text: '成功' },
  { code: EXIT_TURN_FAILED, text: '回合失败' },
  { code: EXIT_USAGE, text: '用法错误' },
  { code: EXIT_DENIED, text: '审批被拒' },
  { code: EXIT_BUDGET, text: '预算耗尽' },
  { code: EXIT_CHAT_BUSY, text: '会话正被其他进程使用' },
  { code: EXIT_STORAGE_UPGRADE, text: '数据需要升级' },
  { code: EXIT_CONFIG, text: '配置或运行时缺失（没有 API key、缺运行时、Node 版本不够）' },
  { code: EXIT_INTERRUPTED, text: '被中断' },
];

/**
 * @returns The exit-code section shared by every help screen.
 */
export function exitCodeHelp(): string {
  const rows = EXIT_CODES.map((row) => `  ${String(row.code).padEnd(4)} ${row.text}`).join('\n');
  return `退出码：\n${rows}`;
}
