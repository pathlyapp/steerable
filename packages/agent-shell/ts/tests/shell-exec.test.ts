/**
 * Shell 执行：前缀策略、PTY、远端 SSH。
 * 策略和 argv 规划不启动进程；执行器测试用注入的 backend 记录是否真的拉起。
 */
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { LocalExecutor, type LocalExecRequest } from '../src/local-executor.js';
import { ToolRouter } from '../src/tool-router.js';
import {
  evaluateExecPolicy,
  planSshArgv,
  splitShellScript,
  type ExecPolicy,
  type ShellProcessBackend,
  type ShellRunSpec,
} from '../src/shell-exec.js';

const forbidRm: ExecPolicy = {
  rules: [{ argv: ['rm'], decision: 'forbidden', justification: 'destructive' }],
};

function recordingBackend(): { backend: ShellProcessBackend; calls: ShellRunSpec[] } {
  const calls: ShellRunSpec[] = [];
  return {
    calls,
    backend: {
      async run(spec) {
        calls.push(spec);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    },
  };
}

describe('splitShellScript', () => {
  it('splits unquoted operators into separate argv lists', () => {
    expect(splitShellScript('echo a && echo b')).toEqual([
      ['echo', 'a'],
      ['echo', 'b'],
    ]);
    expect(splitShellScript('echo a | wc -l')).toEqual([
      ['echo', 'a'],
      ['wc', '-l'],
    ]);
  });

  it('keeps operators and spaces that sit inside quotes', () => {
    expect(splitShellScript('echo "a && b"')).toEqual([['echo', 'a && b']]);
    expect(splitShellScript("git commit -m 'hello world'")).toEqual([
      ['git', 'commit', '-m', 'hello world'],
    ]);
  });

  it('splits semicolons, or-lists, and newlines, but not redirections', () => {
    expect(splitShellScript('echo ok; echo more')).toEqual([
      ['echo', 'ok'],
      ['echo', 'more'],
    ]);
    expect(splitShellScript('echo ok || echo more')).toEqual([
      ['echo', 'ok'],
      ['echo', 'more'],
    ]);
    expect(splitShellScript('echo ok\necho more')).toEqual([
      ['echo', 'ok'],
      ['echo', 'more'],
    ]);
    expect(splitShellScript('echo hi 2>&1')).toEqual([['echo', 'hi', '2>&1']]);
  });
});

describe('evaluateExecPolicy', () => {
  it('allows a command when no rule matches', () => {
    expect(evaluateExecPolicy('git status', { rules: [] }).decision).toBe('allow');
    expect(evaluateExecPolicy('git status', forbidRm).decision).toBe('allow');
  });

  it('forbids a matching prefix and a later command in the same script', () => {
    const direct = evaluateExecPolicy('rm -rf /tmp/x', forbidRm);
    expect(direct.decision).toBe('forbidden');
    expect(direct.command).toEqual(['rm', '-rf', '/tmp/x']);
    expect(direct.rule?.justification).toBe('destructive');
    expect(evaluateExecPolicy('echo ok && rm -rf /tmp/x', forbidRm).decision).toBe('forbidden');
  });

  it('keeps the stricter decision when a shorter prefix also matches', () => {
    const policy: ExecPolicy = {
      rules: [
        { argv: ['git'], decision: 'prompt' },
        { argv: ['git', 'status'], decision: 'allow' },
      ],
    };
    expect(evaluateExecPolicy('git status', policy).decision).toBe('prompt');
    expect(evaluateExecPolicy('git push origin', {
      rules: [{ argv: ['git', 'push'], decision: 'prompt' }],
    }).decision).toBe('prompt');
  });

  it('does not treat a quoted command as a second program', () => {
    expect(evaluateExecPolicy('echo "rm -rf /"', forbidRm).decision).toBe('allow');
    expect(evaluateExecPolicy('echo ok; rm x', forbidRm).decision).toBe('forbidden');
    expect(evaluateExecPolicy('echo ok || rm x', forbidRm).decision).toBe('forbidden');
    expect(evaluateExecPolicy('echo ok\nrm x', forbidRm).decision).toBe('forbidden');
  });
});

describe('planSshArgv', () => {
  it('runs the script as one remote bash argv and does not wrap it in a local shell', () => {
    const plan = planSshArgv({
      command: 'echo hi',
      pty: false,
      endpoint: { kind: 'ssh', destination: 'devbox' },
    });
    expect(plan.file).toBe('ssh');
    expect(plan.transport).toBe('ssh');
    expect(plan.pty).toBe(false);
    expect(plan.args).toEqual([
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      'devbox',
      '--',
      'bash', '-lc', 'echo hi',
    ]);
  });

  it('asks ssh for a tty and cds on the remote host', () => {
    const plan = planSshArgv({
      command: 'pwd',
      cwd: "/work's",
      pty: true,
      endpoint: { kind: 'ssh', destination: 'devbox', remoteCwd: '/ignored' },
    });
    expect(plan.pty).toBe(true);
    expect(plan.args).toContain('-tt');
    expect(plan.args.at(-1)).toBe("cd '/work'\\''s' && pwd");
  });

  it('uses pwsh on the remote when the caller asked for powershell', () => {
    const plan = planSshArgv({
      command: 'Get-Date',
      pty: false,
      shell: 'powershell',
      endpoint: { kind: 'ssh', destination: 'devbox' },
    });
    expect(plan.args.slice(-5)).toEqual([
      'pwsh', '-NoProfile', '-NonInteractive', '-Command', 'Get-Date',
    ]);
  });

  it('uses the endpoint remote directory when the call omits cwd', () => {
    const plan = planSshArgv({
      command: 'pwd',
      pty: false,
      endpoint: { kind: 'ssh', destination: 'devbox', remoteCwd: '/opt/work' },
    });
    expect(plan.args.at(-1)).toBe("cd '/opt/work' && pwd");
  });

  it('rejects an empty destination before any argv is built', () => {
    expect(() => planSshArgv({
      command: 'echo hi',
      pty: false,
      endpoint: { kind: 'ssh', destination: '  ' },
    })).toThrow(/destination/);
  });
});

describe('LocalExecutor shell policy and transport', () => {
  it('does not spawn a forbidden command', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setExecPolicy(forbidRm);
    const result = await executor.executeShell({ command: 'rm -rf /tmp/x' });
    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.execDecision).toBe('forbidden');
    expect(result.needsFollowup).toBeUndefined();
    expect(result.error).toContain('rm -rf /tmp/x');
    expect(result.error).toContain('destructive');
  });

  it('holds a prompt decision until the caller passes approval', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setExecPolicy({ rules: [{ argv: ['git', 'push'], decision: 'prompt' }] });
    const held = await executor.executeShell({ command: 'git push' });
    expect(calls).toEqual([]);
    expect(held).toMatchObject({
      success: false,
      execDecision: 'prompt',
      needsFollowup: true,
    });
    const allowed = await executor.executeShell({ command: 'git push', execApproval: 'allow' });
    expect(allowed.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].transport).toBe('local');
  });

  it('still blocks the dangerous-command list before the backend runs', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setExecPolicy({ rules: [{ argv: ['sudo'], decision: 'allow' }] });
    const result = await executor.executeShell({ command: 'sudo touch /tmp/nope' });
    expect(calls).toEqual([]);
    expect(result.error).toContain('Blocked dangerous command');
  });

  it('sends an ssh endpoint to ssh and does not invoke the local shell', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setShellEndpoint({ kind: 'ssh', destination: 'devbox' });
    const result = await executor.executeShell({ command: 'echo hi', cwd: '/remote/src' });
    expect(result).toMatchObject({ success: true, transport: 'ssh', pty: false });
    expect(calls[0].file).toBe('ssh');
    expect(calls[0].args).toContain('devbox');
    expect(calls[0].args.at(-1)).toContain("cd '/remote/src' && echo hi");
    expect(calls[0].args).not.toContain('/bin/zsh');
    expect(calls[0].args).not.toContain('/bin/bash');
  });

  it('does not let approval bypass a forbidden command', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setExecPolicy({
      rules: [
        { argv: ['git', 'push'], decision: 'prompt' },
        { argv: ['rm'], decision: 'forbidden', justification: 'destructive' },
      ],
    });
    const result = await executor.executeShell({
      command: 'git push && rm -rf /tmp/x',
      execApproval: 'allow',
    });
    expect(calls).toEqual([]);
    expect(result.execDecision).toBe('forbidden');
    expect(result.needsFollowup).toBeUndefined();
  });

  it('uses the endpoint remote directory and pwsh without local powershell rewriting', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setShellEndpoint({ kind: 'ssh', destination: 'devbox', remoteCwd: '/opt/work' });
    await executor.executeShell({ command: 'Get-Date', shell: 'powershell' });
    expect(calls[0].args.slice(-5)).toEqual([
      'pwsh', '-NoProfile', '-NonInteractive', '-Command', "Set-Location '/opt/work'; Get-Date",
    ]);
    expect(calls[0].args.at(-1)).not.toContain('LASTEXITCODE');
  });

  it('rejects an empty ssh destination without spawning', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setShellEndpoint({ kind: 'ssh', destination: '  ' });
    const result = await executor.executeShell({ command: 'echo hi' });
    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/destination/);
  });

  it('reports a non-zero exit and a timeout from the planned runner', async () => {
    const calls: ShellRunSpec[] = [];
    const executor = new LocalExecutor();
    executor.setShellBackend({
      async run(spec) {
        calls.push(spec);
        if (spec.args.join(' ').includes('sleep')) {
          return { exitCode: -1, stdout: '', stderr: '', timedOut: true, error: 'short' };
        }
        return { exitCode: 3, stdout: 'nope', stderr: 'err' };
      },
    });
    executor.setExecPolicy({ rules: [] });
    const failed = await executor.executeShell({ command: 'false', pty: true });
    expect(failed).toMatchObject({ success: false, exitCode: 3, transport: 'local', pty: true });
    const timedOut = await executor.executeShell({ command: 'sleep 30', pty: true, timeout: 5 });
    expect(timedOut.success).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.error).toContain('DO NOT blindly re-run');
  });

  it('keeps a local pty on this machine and forwards request env only there', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    await executor.executeShell({ command: 'echo hi', pty: true, env: { SECRET_TOKEN: 'local' } });
    expect(calls[0]).toMatchObject({ transport: 'local', pty: true });
    expect(calls[0].env?.SECRET_TOKEN).toBe('local');
    expect(calls[0].file).not.toBe('ssh');
  });

  it('marks a local pty run and keeps request env off the ssh argv', async () => {
    const { backend, calls } = recordingBackend();
    const executor = new LocalExecutor();
    executor.setShellBackend(backend);
    executor.setShellEndpoint({ kind: 'ssh', destination: 'devbox' });
    await executor.executeShell({
      command: 'echo hi',
      pty: true,
      env: { SECRET_TOKEN: 'nope' },
    });
    expect(calls[0].pty).toBe(true);
    expect(calls[0].args).toContain('-tt');
    expect(calls[0].args.join(' ')).not.toContain('SECRET_TOKEN');
    expect(calls[0].env?.SECRET_TOKEN).toBeUndefined();
  });
});

describe('local_exec_shell pty default', () => {
  it('asks for a pty unless the caller turns it off', async () => {
    const seen: LocalExecRequest[] = [];
    const router = new ToolRouter(
      {} as never,
      { list: () => [] } as never,
      async (request) => {
        seen.push(request);
        return { success: true };
      },
    );
    await router.execute({ name: 'local_exec_shell', arguments: { command: 'echo hi' } });
    await router.execute({
      name: 'local_exec_shell',
      arguments: { command: 'echo hi', pty: false },
    });
    expect(seen.map((request) => request.pty)).toEqual([true, false]);
  });
});

describe('LocalExecutor real pty', () => {
  it.skipIf(process.platform === 'win32')('sees a tty when pty is set and a pipe otherwise', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shell-pty-'));
    const command = 'node -e \'process.stdout.write(process.stdout.isTTY ? "PTY_TTY_YES" : "PTY_TTY_NO")\'';
    const executor = new LocalExecutor();
    const piped = await executor.executeShell({ command, cwd: dir, timeout: 15000 });
    const tty = await executor.executeShell({ command, cwd: dir, timeout: 15000, pty: true });
    expect(piped.stdout).toContain('PTY_TTY_NO');
    expect(tty.stdout).toContain('PTY_TTY_YES');
    expect(tty.pty).toBe(true);
  }, 20000);
});
