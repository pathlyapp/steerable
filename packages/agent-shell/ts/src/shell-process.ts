/**
 * 本地进程启动：管道用 child_process，PTY 用 node-pty。
 * SSH 也走这里，argv 由 shell-exec 规划好，本文件不再解释命令文本。
 */
import { spawn } from 'child_process';
import * as pty from 'node-pty';
import type { ShellProcessBackend, ShellRunLimits, ShellRunOutcome, ShellRunSpec } from './shell-exec.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export const nodeShellBackend: ShellProcessBackend = {
  run(spec, limits) {
    return spec.pty ? runPty(spec, limits) : runPipe(spec, limits);
  },
};

function runPipe(spec: ShellRunSpec, limits: ShellRunLimits): Promise<ShellRunOutcome> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
    });
    const finish = (outcome: ShellRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const take = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
      if (bytes >= limits.maxOutputBytes) {
        truncated = true;
        return bytes;
      }
      const remain = limits.maxOutputBytes - bytes;
      const safe = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
      chunks.push(safe);
      if (safe.length < chunk.length) truncated = true;
      return bytes + safe.length;
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = take(stdoutChunks, stdoutBytes, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = take(stderrChunks, stderrBytes, chunk);
    });
    const stdout = () => Buffer.concat(stdoutChunks).toString('utf-8');
    const stderr = () => Buffer.concat(stderrChunks).toString('utf-8');
    const timer = setTimeout(() => {
      if (!limits.gui) child.kill();
      finish({
        exitCode: -1,
        stdout: stdout(),
        stderr: stderr(),
        truncated,
        timedOut: true,
        stillRunning: limits.gui,
        error: limits.gui ? undefined : `Command timed out after ${limits.timeoutMs}ms`,
      });
    }, limits.timeoutMs);
    child.on('error', (err) => {
      finish({ exitCode: -1, stdout: stdout(), stderr: stderr(), truncated, error: err.message });
    });
    child.on('close', (exitCode) => {
      finish({
        exitCode: exitCode ?? -1,
        stdout: stdout(),
        stderr: stderr(),
        truncated,
      });
    });
  });
}

function runPty(spec: ShellRunSpec, limits: ShellRunLimits): Promise<ShellRunOutcome> {
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let settled = false;
    const proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spec.cwd,
      env: { ...spec.env, TERM: 'xterm-256color' },
    });
    const finish = (outcome: ShellRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    proc.onData((chunk) => {
      const next = output + chunk;
      if (Buffer.byteLength(next) > limits.maxOutputBytes) {
        truncated = true;
        output = trimToBytes(next, limits.maxOutputBytes);
        return;
      }
      output = next;
    });
    const timer = setTimeout(() => {
      if (!limits.gui) proc.kill();
      finish({
        exitCode: -1,
        stdout: stripAnsi(output),
        stderr: '',
        truncated,
        timedOut: true,
        stillRunning: limits.gui,
        error: limits.gui ? undefined : `Command timed out after ${limits.timeoutMs}ms`,
      });
    }, limits.timeoutMs);
    proc.onExit(({ exitCode }) => {
      finish({
        exitCode: exitCode ?? -1,
        stdout: stripAnsi(output),
        stderr: '',
        truncated,
      });
    });
  });
}

function trimToBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  return buffer.subarray(0, maxBytes).toString('utf-8');
}
