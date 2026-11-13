/**
 * 还在跑的伪终端会话。
 * local_exec_shell 带 yieldMs 时把进程留在这里；write_stdin 按会话号写入，或只取新输出。
 */
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { stripAnsi } from './shell-process.js';

const MAX_SESSION_MS = 10 * 60 * 1000;
const QUIET_MS = 200;
const MAX_YIELD_MS = 120_000;

interface LiveSession {
  id: string;
  proc: pty.IPty;
  raw: string;
  cursor: number;
  exitCode: number | null;
  truncated: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface ShellSessionStatus {
  running: boolean;
  exitCode: number | null;
}

export interface ShellSessionUpdate {
  success: boolean;
  stdout: string;
  running: boolean;
  exitCode: number | null;
  error?: string;
  truncated?: boolean;
}

const sessions = new Map<string, LiveSession>();

function stringEnv(env: Record<string, string> | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') next[key] = value;
  }
  if (env) Object.assign(next, env);
  next.TERM = 'xterm-256color';
  return next;
}

function takeNew(live: LiveSession): string {
  const fresh = stripAnsi(live.raw.slice(live.cursor));
  live.cursor = live.raw.length;
  return fresh;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 打开一个伪终端并记下会话号。调用方负责之后用 read / write 取输出。 */
export function startPtySession(spec: {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes: number;
}): string {
  const id = randomUUID();
  const proc = pty.spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: spec.cwd,
    env: stringEnv(spec.env),
  });
  const live: LiveSession = {
    id,
    proc,
    raw: '',
    cursor: 0,
    exitCode: null,
    truncated: false,
    timer: setTimeout(() => {
      try {
        proc.kill();
      } catch (err) {
        if (!(err instanceof Error)) throw err;
      }
    }, MAX_SESSION_MS),
  };
  live.timer.unref?.();
  proc.onData((chunk) => {
    const next = live.raw + chunk;
    if (Buffer.byteLength(next) > spec.maxOutputBytes) {
      live.truncated = true;
      live.raw = Buffer.from(next).subarray(0, spec.maxOutputBytes).toString('utf-8');
      return;
    }
    live.raw = next;
  });
  proc.onExit(({ exitCode }) => {
    live.exitCode = exitCode ?? -1;
    clearTimeout(live.timer);
  });
  sessions.set(id, live);
  return id;
}

export function shellSessionStatus(sessionId: string): ShellSessionStatus | null {
  const live = sessions.get(sessionId);
  if (!live) return null;
  return { running: live.exitCode === null, exitCode: live.exitCode };
}

/** 等到有一段新输出安静下来、进程退出，或到达 yieldMs。返回这段新输出。 */
export async function readShellSession(sessionId: string, waitMs: number): Promise<string | null> {
  const live = sessions.get(sessionId);
  if (!live) return null;
  const cap = Math.max(0, Math.min(waitMs, MAX_YIELD_MS));
  const started = Date.now();
  let lastLen = live.raw.length;
  let lastChange = started;
  while (Date.now() - started < cap) {
    if (live.exitCode !== null) break;
    if (live.raw.length !== lastLen) {
      lastLen = live.raw.length;
      lastChange = Date.now();
    } else if (lastLen > live.cursor && Date.now() - lastChange >= QUIET_MS) {
      break;
    }
    await delay(20);
  }
  return takeNew(live);
}

export function writeShellSessionChars(sessionId: string, chars: string): { ok: true } | { ok: false; error: string } {
  const live = sessions.get(sessionId);
  if (!live) return { ok: false, error: 'session not found' };
  if (live.exitCode !== null) return { ok: true };
  try {
    live.proc.write(chars);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || 'failed to write stdin' };
  }
}

export async function writeShellStdin(input: {
  sessionId: string;
  chars: string;
  yieldMs: number;
}): Promise<ShellSessionUpdate> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return { success: false, stdout: '', running: false, exitCode: null, error: 'sessionId is required' };
  const existing = shellSessionStatus(sessionId);
  if (!existing) {
    return { success: false, stdout: '', running: false, exitCode: null, error: 'session not found' };
  }
  if (input.chars && existing.running) {
    const wrote = writeShellSessionChars(sessionId, input.chars);
    if (!wrote.ok) {
      return { success: false, stdout: '', running: existing.running, exitCode: existing.exitCode, error: wrote.error };
    }
  }
  const stdout = await readShellSession(sessionId, input.yieldMs);
  const after = shellSessionStatus(sessionId);
  if (stdout === null || !after) {
    return { success: false, stdout: '', running: false, exitCode: null, error: 'session not found' };
  }
  const live = sessions.get(sessionId);
  return {
    success: true,
    stdout,
    running: after.running,
    exitCode: after.exitCode,
    ...(live?.truncated ? { truncated: true } : {}),
  };
}

export function closeShellSession(sessionId: string): void {
  const live = sessions.get(sessionId);
  if (!live) return;
  sessions.delete(sessionId);
  clearTimeout(live.timer);
  if (live.exitCode === null) {
    try {
      live.proc.kill();
    } catch (err) {
      if (!(err instanceof Error)) throw err;
    }
  }
}

/** 测试收尾：关掉还留着的伪终端。 */
export function closeAllShellSessions(): void {
  for (const id of [...sessions.keys()]) closeShellSession(id);
}
