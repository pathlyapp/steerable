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
