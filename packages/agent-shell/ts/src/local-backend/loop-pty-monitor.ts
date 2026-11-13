import { randomUUID } from 'node:crypto';

import type {
  TerminalSession,
  TerminalSpawnOptions,
} from '../terminal-manager.js';
import type { WakeResult } from './router.js';

const WAKE_PREFIX = '__STEERABLE_LOOP_WAKE__:';

interface LoopTerminal {
  spawn(options?: TerminalSpawnOptions): TerminalSession;
  write(id: string, data: string): boolean;
  kill(id: string): boolean;
  on(event: 'data', listener: (sessionId: string, chunk: string) => void): unknown;
  on(event: 'exit', listener: (sessionId: string, code: number, signal: string | null) => void): unknown;
  off(event: 'data', listener: (sessionId: string, chunk: string) => void): unknown;
  off(event: 'exit', listener: (sessionId: string, code: number, signal: string | null) => void): unknown;
}

export interface MonitoredLoop {
  id: string;
  chatId: string;
  terminalSessionId: string;
  prompt: string;
  intervalSeconds: number;
}

export interface StartMonitoredLoop {
  chatId: string;
  prompt: string;
  intervalSeconds: number;
  cwd?: string;
}

type WakeChat = (
  chatId: string,
  input: { trigger: 'loop'; message: string; sourceId: string },
) => Promise<WakeResult>;

/** Cursor-style local loop: a background PTY emits markers that wake one chat. */
export class LoopPtyMonitor {
  private readonly loops = new Map<string, MonitoredLoop>();
  private readonly loopByTerminal = new Map<string, string>();
  private readonly buffers = new Map<string, string>();

  private readonly onData = (sessionId: string, chunk: string): void => {
    const loopId = this.loopByTerminal.get(sessionId);
    if (!loopId) return;
    const buffered = (this.buffers.get(sessionId) ?? '') + chunk;
    const lines = buffered.split(/\r?\n/);
    this.buffers.set(sessionId, lines.pop() ?? '');
    for (const line of lines) {
      if (!line.includes(`${WAKE_PREFIX}${loopId}`)) continue;
      const loop = this.loops.get(loopId);
      if (!loop) continue;
      void this.wakeChat(loop.chatId, {
        trigger: 'loop',
        message: buildLoopWakePrompt(loop),
        sourceId: loop.id,
      }).catch((error: unknown) => {
        console.warn('[loop-monitor] chat wake failed', {
          loopId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  private readonly onExit = (
    sessionId: string,
    _code: number,
    _signal: string | null,
  ): void => {
    const loopId = this.loopByTerminal.get(sessionId);
    if (!loopId) return;
    this.remove(loopId);
  };

  constructor(
    private readonly terminals: LoopTerminal,
    private readonly wakeChat: WakeChat,
    private readonly onChange?: (chatId: string, loops: MonitoredLoop[]) => void,
  ) {
    terminals.on('data', this.onData);
    terminals.on('exit', this.onExit);
  }

  /** Start a loop whose first marker is emitted after the requested interval. */
  start(input: StartMonitoredLoop): MonitoredLoop {
    if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0) {
      throw new Error('intervalSeconds must be a positive integer');
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('prompt must not be empty');

    const id = randomUUID();
    const session = this.terminals.spawn({
      shell: process.platform === 'win32' ? 'powershell.exe' : 'sh',
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    const loop: MonitoredLoop = {
      id,
      chatId: input.chatId,
      terminalSessionId: session.id,
      prompt,
      intervalSeconds: input.intervalSeconds,
    };
    this.loops.set(id, loop);
    this.loopByTerminal.set(session.id, id);
    this.buffers.set(session.id, '');
    this.onChange?.(input.chatId, this.list(input.chatId));

    const script = loopScript(session.shell, id, input.intervalSeconds);
    if (!this.terminals.write(session.id, script)) {
      this.remove(id);
      this.terminals.kill(session.id);
      throw new Error(`failed to start loop in terminal ${session.id}`);
    }
    return { ...loop };
  }

  /** List all monitored loops, optionally restricted to one chat. */
  list(chatId?: string): MonitoredLoop[] {
    return [...this.loops.values()]
      .filter((loop) => chatId === undefined || loop.chatId === chatId)
      .map((loop) => ({ ...loop }));
  }

  /** Stop one monitored loop. */
  stop(loopId: string): boolean {
    const loop = this.loops.get(loopId);
    if (!loop) return false;
    this.remove(loopId);
    this.terminals.kill(loop.terminalSessionId);
    return true;
  }

  /** Detach monitor listeners. Host shutdown separately kills all PTYs. */
  dispose(): void {
    this.terminals.off('data', this.onData);
    this.terminals.off('exit', this.onExit);
    this.loops.clear();
    this.loopByTerminal.clear();
    this.buffers.clear();
  }

  private remove(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (!loop) return;
    this.loops.delete(loopId);
    this.loopByTerminal.delete(loop.terminalSessionId);
    this.buffers.delete(loop.terminalSessionId);
    this.onChange?.(loop.chatId, this.list(loop.chatId));
  }
}

function buildLoopWakePrompt(loop: MonitoredLoop): string {
  return `This is a scheduled loop wake.
Loop ID: ${loop.id}
Use current workspace and external state to perform this task:

<loop-task>
${loop.prompt}
</loop-task>

If the task describes finite monitoring, verify its terminal condition from current evidence. Success, failure, cancellation, or another explicitly requested terminal state ends that monitoring. When it is terminal, call loop_stop with id "${loop.id}" exactly once, then report the final outcome. If it is not terminal, report the current state and leave the loop running for its next wake.

Do not stop open-ended recurring work unless the task itself says when it ends. Do not create a replacement loop.`;
}

function loopScript(shell: string, id: string, intervalSeconds: number): string {
  const lower = shell.toLowerCase();
  if (lower.includes('powershell') || lower.includes('pwsh')) {
    return `while ($true) { Start-Sleep -Seconds ${intervalSeconds}; Write-Output ('__STEERABLE_'+'LOOP_WAKE__:'+'${id}') }\r`;
  }
  if (lower.includes('cmd.exe')) {
    return `set "__SLP=__STEERABLE_" & for /L %i in (0,0,1) do @(timeout /t ${intervalSeconds} /nobreak >nul & echo %__SLP%LOOP_WAKE__:${id})\r`;
  }
  return `while true; do sleep ${intervalSeconds}; printf '__STEERABLE_%s_WAKE__:%s\\n' 'LOOP' '${id}'; done\r`;
}
