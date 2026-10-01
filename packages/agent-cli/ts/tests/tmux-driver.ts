import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

interface TmuxDriverOptions {
  caseId: string;
  cwd: string;
  width?: number;
  height?: number;
  env?: NodeJS.ProcessEnv;
}

export class TmuxDriver {
  readonly session: string;

  private readonly caseId: string;
  private readonly cwd: string;
  private readonly width: number;
  private readonly height: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly inputs: string[] = [];
  private startupOutput = '';

  constructor(options: TmuxDriverOptions) {
    this.caseId = options.caseId;
    this.cwd = options.cwd;
    this.width = options.width ?? 100;
    this.height = options.height ?? 32;
    this.env = {
      ...process.env,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      ...options.env,
    };
    const worker = process.env.VITEST_POOL_ID ?? '0';
    this.session = safeName(`${options.caseId}-${process.pid}-${worker}`);
  }

  static isAvailable(): boolean {
    return spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
  }

  start(command: string, args: string[] = []): void {
    this.kill();
    const result = this.tmux([
      'new-session',
      '-d',
      '-s',
      this.session,
      '-x',
      String(this.width),
      '-y',
      String(this.height),
      command,
      ...args,
    ]);
    this.startupOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assertOk(result, `start tmux session ${this.session}`);
  }

  send(...keys: string[]): void {
    this.inputs.push(keys.join(' '));
    assertOk(this.tmux(['send-keys', '-t', this.session, ...keys]), `send ${keys.join(' ')}`);
  }

  resize(width: number, height: number): void {
    this.inputs.push(`resize ${width}x${height}`);
    assertOk(
      this.tmux(['resize-window', '-t', this.session, '-x', String(width), '-y', String(height)]),
      `resize to ${width}x${height}`,
    );
  }

  capture(ansi = false): string {
    const result = this.tmux([
      'capture-pane',
      '-p',
      ...(ansi ? ['-e'] : []),
      '-t',
      this.session,
    ]);
    return result.status === 0 ? result.stdout ?? '' : '';
  }

  async waitFor(text: string, timeoutMs = 5_000): Promise<string> {
    return this.waitForScreen((screen) => screen.includes(text), `text ${JSON.stringify(text)}`, timeoutMs);
  }

  async waitForScreen(
    predicate: (screen: string) => boolean,
    expectation: string,
    timeoutMs = 5_000,
  ): Promise<string> {
    const started = Date.now();
    let pane = this.capture();
    while (!predicate(pane)) {
      if (Date.now() - started >= timeoutMs) {
        const error = new Error(`${this.caseId} timed out waiting for ${expectation}\n${pane}`);
        await this.writeFailureArtifacts(error);
        throw error;
      }
      await delay(25);
      pane = this.capture();
    }
    return pane;
  }

  async waitUntilGone(timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (this.exists()) {
      if (Date.now() - started >= timeoutMs) {
        const error = new Error(`${this.caseId} tmux session did not exit\n${this.capture()}`);
        await this.writeFailureArtifacts(error);
        throw error;
      }
      await delay(25);
    }
  }

  exists(): boolean {
    return this.tmux(['has-session', '-t', this.session]).status === 0;
  }

  format(expression: string): string {
    const result = this.tmux(['display-message', '-p', '-t', this.session, expression]);
    assertOk(result, `read tmux format ${expression}`);
    return (result.stdout ?? '').trim();
  }

  kill(): void {
    this.tmux(['kill-session', '-t', this.session]);
  }

  async writeFailureArtifacts(error: unknown): Promise<void> {
    const root = process.env.TUI_ARTIFACT_DIR
      ?? path.resolve(import.meta.dirname, '../test-results/tui');
    const dir = path.join(root, safeName(this.caseId));
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, 'pane.txt'), `${this.capture()}\n`),
      fs.writeFile(path.join(dir, 'pane.ansi'), this.capture(true)),
      fs.writeFile(path.join(dir, 'input.log'), `${this.inputs.join('\n')}\n`),
      fs.writeFile(path.join(dir, 'process.log'), this.startupOutput),
      fs.writeFile(path.join(dir, 'environment.json'), `${JSON.stringify({
        caseId: this.caseId,
        error: error instanceof Error ? error.message : String(error),
        platform: process.platform,
        node: process.version,
        tmux: commandVersion('tmux', ['-V']),
        term: this.env.TERM,
        lang: this.env.LANG,
        width: this.width,
        height: this.height,
      }, null, 2)}\n`),
    ]);
  }

  private tmux(args: string[]): SpawnSyncReturns<string> {
    return spawnSync('tmux', args, {
      cwd: this.cwd,
      env: this.env,
      encoding: 'utf8',
    });
  }
}

function commandVersion(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function assertOk(result: SpawnSyncReturns<string>, action: string): void {
  if (result.status === 0) return;
  throw new Error(`${action} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
