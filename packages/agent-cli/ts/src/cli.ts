import path from 'node:path';
import { parseArgs } from 'node:util';
import { getBrand } from '@steerable/agent-shell/brand';
import { restoreLogConsole, silenceLogConsole } from '@steerable/agent-shell/log';
import {
  collectPackCliCommands,
  type CliCommandSpec,
} from '@steerable/agent-shell/host/pack-cli';
import { getUserDataDir } from '@steerable/agent-shell/runtime';
import {
  applyHostRuntimeEnv,
  createLocalClient,
  listBusyChatIds,
  type AgentClient,
  type LocalClientOptions,
} from '@steerable/agent-client';

import { parseApprovePolicy } from './approve.js';
import { chatCommand, configCommand, mcpCommand, skillsCommand, type CommandIO } from './commands.js';
import { chatHelp, configHelp, doctorHelp, mcpHelp, rootHelp, runHelp, skillsHelp, tuiHelp } from './help.js';
import { runTurn, type RunRequest } from './run.js';
import { runTui } from './tui/run.js';

export interface CliOptions {
  argv?: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream;
  stdinIsTTY?: boolean;
  createClient?: (options: LocalClientOptions) => Promise<AgentClient>;
  installSignals?: boolean;
  commands?: readonly CliCommandSpec[];
}

export async function createCli(options: CliOptions = {}): Promise<number> {
  const ownsTerminal = (options.stdout ?? process.stdout) === process.stdout;
  if (ownsTerminal) silenceLogConsole('routine');
  try {
    return await runCli(options);
  } finally {
    if (ownsTerminal) restoreLogConsole();
  }
}

async function runCli(options: CliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let packCommands: CliCommandSpec[];
  try {
    packCommands = collectPackCliCommands(options.commands ?? []);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const argv = options.argv ?? process.argv.slice(2);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        chat: { type: 'string' },
        approve: { type: 'string' },
        json: { type: 'boolean' },
        'stream-json': { type: 'boolean' },
        cwd: { type: 'string' },
        timeout: { type: 'string' },
        'data-dir': { type: 'string' },
        agent: { type: 'string' },
        file: { type: 'string', multiple: true },
        format: { type: 'string' },
      },
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${rootHelp(packCommands)}\n`);
    return 2;
  }

  const command = parsed.positionals[0];
  if (parsed.values.help && !command) {
    stdout.write(`${rootHelp(packCommands)}\n`);
    return 0;
  }
  if (!command) return tuiCommand(parsed, options, stdout, stderr);
  if (command === 'run') return runCommand(parsed, options, stdout, stderr);
  if (command === 'chat') return dispatch(parsed, options, stdout, stderr, chatHelp(), chatCommand);
  if (command === 'skills') return dispatch(parsed, options, stdout, stderr, skillsHelp(), skillsCommand);
  if (command === 'mcp') return dispatch(parsed, options, stdout, stderr, mcpHelp(), mcpCommand);
  if (command === 'config') return dispatch(parsed, options, stdout, stderr, configHelp(), configCommand);
  if (command === 'doctor') return doctorCommand(parsed, options, stdout, stderr);
  if (command === 'tui') return tuiCommand(parsed, options, stdout, stderr);
  const pack = packCommands.find((entry) => entry.name === command);
  if (pack) return runPackCommand(pack, parsed, options, stdout, stderr);
  stderr.write(`unknown command: ${command}\n${rootHelp(packCommands)}\n`);
  return 2;
}

async function runPackCommand(
  command: CliCommandSpec,
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(`<product> ${command.name}\n${command.summary}\n`);
    return 0;
  }
  return withClient(parsed, options, async (client) => command.run(parsed.positionals.slice(1), {
    write: (text) => stdout.write(text),
    writeError: (text) => stderr.write(text),
    request: (method, requestPath, body) => client.request(method, requestPath, body),
  }), stderr);
}

async function runCommand(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(`${runHelp()}\n`);
    return 0;
  }
  const policy = parseApprovePolicy(parsed.values.approve as string | undefined);
  if (!policy) {
    stderr.write(`unknown --approve value\n${runHelp()}\n`);
    return 2;
  }
  let timeoutMs: number | undefined;
  if (typeof parsed.values.timeout === 'string') {
    const parsedTimeout = parseTimeout(parsed.values.timeout);
    if (parsedTimeout === null) {
      stderr.write(`invalid --timeout\n${runHelp()}\n`);
      return 2;
    }
    timeoutMs = parsedTimeout;
  }
  const task = await readTask(parsed.positionals.slice(1), options);
  if (!task.trim()) {
    stderr.write(`missing task\n${runHelp()}\n`);
    return 2;
  }
  const request: RunRequest = {
    task: task.trim(),
    ...(typeof parsed.values.chat === 'string' ? { chatId: parsed.values.chat } : {}),
    ...(typeof parsed.values.agent === 'string' ? { agentId: parsed.values.agent } : {}),
    ...(typeof parsed.values.cwd === 'string' ? { cwd: parsed.values.cwd } : {}),
    files: (parsed.values.file as string[] | undefined) ?? [],
    policy,
    json: parsed.values.json === true,
    streamJson: parsed.values['stream-json'] === true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return withClient(parsed, options, async (client, signal) => runTurn(client, request, stdout, stderr, signal));
}

function commandIO(parsed: ReturnType<typeof parseArgs>): CommandIO {
  return {
    positionals: parsed.positionals,
    help: parsed.values.help === true,
    json: parsed.values.json === true,
    ...(typeof parsed.values.format === 'string' ? { format: parsed.values.format } : {}),
  };
}

async function dispatch(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  help: string,
  command: (
    io: CommandIO,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
    open: (body: (client: AgentClient) => Promise<number>) => Promise<number>,
    help: string,
  ) => Promise<number>,
): Promise<number> {
  return command(commandIO(parsed), stdout, stderr, (body) => withClient(parsed, options, body, stderr), help);
}

async function tuiCommand(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(`${tuiHelp()}\n`);
    return 0;
  }
  const tty = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!tty) {
    stderr.write(`tui needs a terminal. Use run for piped input.\n${tuiHelp()}\n`);
    return 2;
  }
  if ((options.stdout ?? process.stdout) === process.stdout) silenceLogConsole('all');
  return withClient(parsed, options, async (client) => runTui({
    client,
    product: getBrand().displayName,
    dataDir: dataDirFrom(parsed, options.env ?? process.env),
  }), stderr);
}

async function doctorCommand(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(`${doctorHelp()}\n`);
    return 0;
  }
  const dataDir = dataDirFrom(parsed, options.env ?? process.env);
  const report = applyHostRuntimeEnv(dataDir, options.env ?? process.env);
  stdout.write(`data dir: ${dataDir}\n`);
  stdout.write(`log file: ${path.join(dataDir, 'logs', 'main.log')}\n`);
  stdout.write(`runtime file: ${report.fileFound ? report.filePath : 'missing'}\n`);
  for (const entry of report.entries) {
    stdout.write(`${entry.key}: ${entry.source}${entry.path ? ` ${entry.path}` : ''}\n`);
  }
  const python = report.entries.find((entry) => entry.key === 'STEERABLE_PYTHON');
  const sidecar = report.entries.find((entry) => entry.key === 'STEERABLE_SIDECAR_PYTHON');
  if (python?.source === 'missing') stdout.write('missing: run_code\n');
  if (sidecar?.source === 'missing') stdout.write('missing: sidecar python\n');
  return withClient(parsed, options, async () => {
    const busy = listBusyChatIds(dataDir);
    stdout.write(busy.length === 0 ? 'busy chats: none\n' : `busy chats:\n${busy.map((id) => `  ${id}`).join('\n')}\n`);
    return 0;
  }, stderr);
}

async function withClient(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  body: (client: AgentClient, signal: AbortSignal) => Promise<number>,
  stderr: NodeJS.WritableStream = options.stderr ?? process.stderr,
): Promise<number> {
  const env = options.env ?? process.env;
  const dataDir = dataDirFrom(parsed, env);
  env.DEEPPATH_USER_DATA_DIR = dataDir;
  const create = options.createClient ?? ((clientOptions: LocalClientOptions) => createLocalClient(clientOptions));
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    controller.abort();
  };
  if (options.installSignals) process.on('SIGINT', onSigint);
  const timeout = typeof parsed.values.timeout === 'string' ? parseTimeout(parsed.values.timeout) : null;
  const timer = timeout
    ? setTimeout(() => controller.abort(), timeout)
    : undefined;
  let client: AgentClient | null = null;
  try {
    client = await create({
      dataDir,
      env,
      startSidecar: options.createClient ? false : true,
      hasWindow: () => true,
    });
    const code = await body(client, controller.signal);
    if (interrupted) return 130;
    return code;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
    if (options.installSignals) process.off('SIGINT', onSigint);
    await client?.close();
  }
}

function dataDirFrom(parsed: ReturnType<typeof parseArgs>, env: NodeJS.ProcessEnv): string {
  if (typeof parsed.values['data-dir'] === 'string') return parsed.values['data-dir'];
  if (env.DEEPPATH_USER_DATA_DIR) return env.DEEPPATH_USER_DATA_DIR;
  return getUserDataDir();
}

function parseTimeout(raw: string): number | null {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (match[2] === 'ms') return value;
  if (match[2] === 'm') return value * 60_000;
  return value * 1000;
}

async function readTask(words: string[], options: CliOptions): Promise<string> {
  const joined = words.join(' ').trim();
  const tty = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (joined && joined !== '-') return joined;
  if (joined === '-' || !tty) {
    const stdin = options.stdin ?? process.stdin;
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}
