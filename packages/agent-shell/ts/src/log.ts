/**
 * 宿主日志单例。场景包和产品代码从这里拿同一个实例：
 *
 *   import { log } from '@steerable/agent-shell/log';
 *
 * 文件落在 `<userData>/logs/main.log`。写失败只留在 stderr，不拖垮宿主。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getUserDataDir } from './runtime.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * 终端回显范围。`routine` 关掉 log/info/debug/warn，error 仍走 stderr；
 * `all` 连 error 一起关掉，给占满整个终端的界面用。日志文件照写。
 */
export type LogConsoleSilence = 'routine' | 'all';

const consoleMethods = ['log', 'info', 'debug', 'warn', 'error'] as const;
type ConsoleMethod = (typeof consoleMethods)[number];
const routineMethods: readonly ConsoleMethod[] = ['log', 'info', 'debug', 'warn'];
let saved: Pick<Console, ConsoleMethod> | null = null;

/**
 * 关掉宿主日志和 console 的终端回显，直到 {@link restoreLogConsole}。
 * 命令行占用 stdout 输出结果或画界面时调用。
 * @param scope 关掉的范围。
 */
export function silenceLogConsole(scope: LogConsoleSilence): void {
  saved ??= Object.fromEntries(consoleMethods.map((name) => [name, console[name]])) as Pick<Console, ConsoleMethod>;
  for (const name of scope === 'all' ? consoleMethods : routineMethods) console[name] = () => {};
}

/** 恢复调用 {@link silenceLogConsole} 之前的 console。 */
export function restoreLogConsole(): void {
  if (!saved) return;
  for (const name of consoleMethods) console[name] = saved[name];
  saved = null;
}

function formatArg(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return part.stack ?? part.message;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function write(level: LogLevel, args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(' ')}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.info(line);
  try {
    const file = path.join(getUserDataDir(), 'logs', 'main.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch (error) {
    console.error('[log] failed to write main.log', error);
  }
}

export const log = {
  error: (...args: unknown[]) => write('error', args),
  warn: (...args: unknown[]) => write('warn', args),
  info: (...args: unknown[]) => write('info', args),
  debug: (...args: unknown[]) => write('debug', args),
};
