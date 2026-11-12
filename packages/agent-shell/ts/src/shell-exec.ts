/**
 * Shell 执行规划：前缀策略，以及本地 / SSH 的启动参数。
 * 这里不启动进程。多条前缀同时命中时，取更严的决定：
 * allow < prompt < forbidden。
 */

export type ExecDecisionName = 'allow' | 'prompt' | 'forbidden';

const DECISION_RANK: Record<ExecDecisionName, number> = {
  allow: 0,
  prompt: 1,
  forbidden: 2,
};

export interface PrefixRule {
  argv: string[];
  decision: ExecDecisionName;
  justification?: string;
}

export interface ExecPolicy {
  rules: PrefixRule[];
}

export interface ExecEvaluation {
  decision: ExecDecisionName;
  command: string[];
  rule?: PrefixRule;
}

export interface SshEndpoint {
  kind: 'ssh';
  destination: string;
  remoteCwd?: string;
}

export type ShellEndpoint = { kind: 'local' } | SshEndpoint;

export interface ShellRunSpec {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty: boolean;
  transport: 'local' | 'ssh';
}

export interface ShellRunLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  gui: boolean;
}

export interface ShellRunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
  stillRunning?: boolean;
  error?: string;
}

export interface ShellProcessBackend {
  run(spec: ShellRunSpec, limits: ShellRunLimits): Promise<ShellRunOutcome>;
}

export function splitShellScript(script: string): string[][] {
  return splitSegments(script).map(tokenize).filter((argv) => argv.length > 0);
}

export function evaluateExecPolicy(script: string, policy: ExecPolicy): ExecEvaluation {
  const commands = splitShellScript(script);
  let best: ExecEvaluation = { decision: 'allow', command: commands[0] ?? [] };
  for (const command of commands) {
    for (const rule of policy.rules) {
      if (rule.argv.length === 0 || !isPrefix(rule.argv, command)) continue;
      const stricter = DECISION_RANK[rule.decision] > DECISION_RANK[best.decision];
      const sameDecisionLonger =
        rule.decision === best.decision && rule.argv.length > (best.rule?.argv.length ?? 0);
      if (stricter || sameDecisionLonger) {
        best = { decision: rule.decision, command, rule };
      }
    }
  }
  return best;
}

export function planSshArgv(input: {
  command: string;
  cwd?: string;
  pty: boolean;
  shell?: 'powershell';
  endpoint: SshEndpoint;
}): ShellRunSpec {
  const destination = input.endpoint.destination.trim();
  if (!destination) {
    throw new Error('ssh destination is required');
  }
  const cwd = input.cwd ?? input.endpoint.remoteCwd;
  const script = remoteScript(input.command, cwd, input.shell);
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  if (input.pty) args.push('-tt');
  args.push(destination, '--');
  if (input.shell === 'powershell') {
    args.push('pwsh', '-NoProfile', '-NonInteractive', '-Command', script);
  } else {
    args.push('bash', '-lc', script);
  }
  return { file: 'ssh', args, pty: input.pty, transport: 'ssh' };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function remoteScript(command: string, cwd: string | undefined, shell: 'powershell' | undefined): string {
  if (!cwd) return command;
  if (shell === 'powershell') return `Set-Location ${shellQuote(cwd)}; ${command}`;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

function isPrefix(prefix: string[], argv: string[]): boolean {
  if (prefix.length > argv.length) return false;
  return prefix.every((token, index) => token === argv[index]);
}

function splitSegments(script: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < script.length) {
        current += script[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < script.length) {
      current += ch + script[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = script.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '|&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      current += segment[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}
