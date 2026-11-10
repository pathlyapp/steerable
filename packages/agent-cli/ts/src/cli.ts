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

import { REQUIRED_NODE_TUI, supportsTui } from './node-version.js';
import { doctorExitCode, logFilePath, renderDoctor, runDoctorChecks, type DoctorContext } from './doctor.js';
import { parseApprovePolicy, resolveApprovalRequest } from './approve.js';
import {
  defaultProjectFs,
  projectStatusLabel,
  protectedTuiMessage,
  resolveProjectRequest,
  type ProjectSpec,
} from './project-binding.js';
import { readFileSync } from 'node:fs';
import { chatCommand, configCommand, mcpCommand, skillsCommand, type CommandIO } from './commands.js';
import { EXIT_CONFIG, EXIT_INTERRUPTED, EXIT_OK, EXIT_TURN_FAILED, EXIT_USAGE } from './exit-codes.js';
import { chatHelp, configHelp, doctorHelp, loginHelp, logoutHelp, mcpHelp, renderCommandName, rootHelp, runHelp, skillsHelp, tuiHelp, webHelp } from './help.js';
import { preflightApiKey } from './credentials.js';
import { loginCommand, logoutCommand, preflightFixes } from './login.js';
import { webCommand } from './web.js';
import { runTurn, type RunRequest } from './run.js';
import { cliText } from './copy.js';

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
  /** Bin name written in place of `<product>` in help and protected-directory text. */
  commandName?: string;
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
    return EXIT_USAGE;
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
        version: { type: 'boolean', short: 'v' },
        chat: { type: 'string' },
        approve: { type: 'string' },
        json: { type: 'boolean' },
        'stream-json': { type: 'boolean' },
        cwd: { type: 'string' },
        project: { type: 'string' },
        'no-project': { type: 'boolean', default: false },
        trust: { type: 'boolean', default: false },
        timeout: { type: 'string' },
        'data-dir': { type: 'string' },
        agent: { type: 'string' },
        file: { type: 'string', multiple: true },
        format: { type: 'string' },
        'no-preflight': { type: 'boolean', default: false },
        deep: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        port: { type: 'string' },
        once: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${present(options, rootHelp(packCommands))}\n`);
    return EXIT_USAGE;
  }

  // `--version` answers "which build is this?" — the first thing a user checks
  // after an install or an upgrade, and what a bug report needs.
  if (parsed.values.version === true && !parsed.positionals[0]) {
    stdout.write(`${cliVersion()}\n`);
    return EXIT_OK;
  }

  const command = parsed.positionals[0];
  if (parsed.values.help && !command) {
    stdout.write(`${present(options, rootHelp(packCommands))}\n`);
    return EXIT_OK;
  }
  if (!command) return tuiCommand(parsed, options, stdout, stderr);
  if (command === 'run') return runCommand(parsed, options, stdout, stderr);
  if (command === 'chat') return dispatch(parsed, options, stdout, stderr, present(options, chatHelp()), chatCommand);
  if (command === 'skills') return dispatch(parsed, options, stdout, stderr, present(options, skillsHelp()), skillsCommand);
  if (command === 'mcp') return dispatch(parsed, options, stdout, stderr, present(options, mcpHelp()), mcpCommand);
  if (command === 'config') return dispatch(parsed, options, stdout, stderr, present(options, configHelp()), configCommand);
  if (command === 'doctor') return doctorCommand(parsed, options, stdout, stderr);
  if (command === 'tui') return tuiCommand(parsed, options, stdout, stderr);
  if (command === 'web') return webCommandFrom(parsed, options, stdout, stderr);
  if (command === 'login') return credentialCommand(parsed, options, stdout, stderr, 'login');
  if (command === 'logout') return credentialCommand(parsed, options, stdout, stderr, 'logout');
  const pack = packCommands.find((entry) => entry.name === command);
  if (pack) return runPackCommand(pack, parsed, options, stdout, stderr);
  stderr.write(`unknown command: ${command}\n${present(options, rootHelp(packCommands))}\n`);
  return EXIT_USAGE;
}

async function runPackCommand(
  command: CliCommandSpec,
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(present(options, `<product> ${command.name}\n${command.summary}\n`));
    return EXIT_OK;
  }
  return withClient(parsed, options, async (client) => command.run(parsed.positionals.slice(1), {
    write: (text) => stdout.write(present(options, text)),
    writeError: (text) => stderr.write(present(options, text)),
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
    stdout.write(`${present(options, runHelp())}\n`);
    return EXIT_OK;
  }
  const policy = parseApprovePolicy(parsed.values.approve as string | undefined);
  if (!policy) {
    stderr.write(`unknown --approve value\n${present(options, runHelp())}\n`);
    return EXIT_USAGE;
  }
  let timeoutMs: number | undefined;
  if (typeof parsed.values.timeout === 'string') {
    const parsedTimeout = parseTimeout(parsed.values.timeout);
    if (parsedTimeout === null) {
      stderr.write(`invalid --timeout\n${present(options, runHelp())}\n`);
      return EXIT_USAGE;
    }
    timeoutMs = parsedTimeout;
  }
  const task = await readTask(parsed.positionals.slice(1), options);
  if (!task.trim()) {
    stderr.write(`missing task\n${present(options, runHelp())}\n`);
    return EXIT_USAGE;
  }
  const request: RunRequest = {
    task: task.trim(),
    ...(typeof parsed.values.chat === 'string' ? { chatId: parsed.values.chat } : {}),
    ...(typeof parsed.values.agent === 'string' ? { agentId: parsed.values.agent } : {}),
    files: (parsed.values.file as string[] | undefined) ?? [],
    policy,
    json: parsed.values.json === true,
    streamJson: parsed.values['stream-json'] === true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    verbose: parsed.values.verbose === true,
  };
  const spec = projectSpec(parsed);
  if (spec.kind === 'error') {
    stderr.write(`${present(options, spec.message)}\n`);
    return spec.code;
  }
  return withClient(parsed, options, async (client, signal) => {
    const bound = await bindAndTrust(client, parsed, spec, stderr);
    if (typeof bound === 'number') return bound;
    // After binding, before the chat exists: a usage error must win over the
    // credential check, and a missing key must not leave an empty chat behind.
    if (parsed.values['no-preflight'] !== true) {
      const blocked = await preflightGate(client, request, stdout, stderr);
      if (blocked !== null) return blocked;
    }
    return runTurn(client, {
      ...request,
      ...(bound ? { projectId: bound.id } : {}),
    }, stdout, stderr, signal);
  });
}

/**
 * Blocks a turn that cannot succeed for a configuration reason.
 *
 * The check runs before any model request, so an unconfigured install fails in
 * milliseconds with the exact commands that fix it, instead of after a network
 * round trip with a provider's raw 401.
 *
 * @returns An exit code when the turn must not start, otherwise null.
 */
async function preflightGate(
  client: AgentClient,
  request: RunRequest,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number | null> {
  const response = await client.request('GET', '/api/v2/local-settings/llm', undefined);
  if (response.status !== 200) return null;
  const settings = (response.data ?? {}) as Record<string, unknown>;
  const result = preflightApiKey(settings, process.env);
  if (result.ok) return null;
  const fixes = preflightFixes(result.envNames);
  if (request.streamJson || request.json) {
    stdout.write(
      `${JSON.stringify({
        type: 'error',
        code: 'missing_api_key',
        message: cliText('preflight.missingKey'),
        provider: settings.provider,
        vendorId: settings.vendorId ?? '',
        env: result.envNames,
        fix: fixes,
      })}\n`,
    );
    return EXIT_CONFIG;
  }
  stderr.write(`${cliText('preflight.missingKey')}\n\n`);
  for (const line of fixes) stderr.write(`  ${line}\n`);
  const provider = String(settings.vendorId ?? settings.provider ?? '');
  stderr.write(`\n${cliText('preflight.currentProvider', { provider })}\n`);
  return EXIT_CONFIG;
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
    stdout.write(`${present(options, tuiHelp())}\n`);
    return EXIT_OK;
  }
  // Only the TUI needs the renderer's Node floor; everything else stays
  // importable on the older runtime the rest of the CLI supports.
  if (!supportsTui(process.versions.node)) {
    stderr.write(
      `${cliText('tui.nodeTooOld', {
        required: REQUIRED_NODE_TUI,
        current: process.versions.node.replace(/^v/, ''),
      })}\n`,
    );
    stderr.write(`  ${cliText('tui.nodeTooOldUpgrade')}\n`);
    stderr.write(`  ${cliText('tui.nodeTooOldWorkaround')}\n`);
    return EXIT_CONFIG;
  }
  const approval = resolveApprovalRequest(
    typeof parsed.values.approve === 'string' ? parsed.values.approve : undefined,
    'tui',
  );
  if (!approval) {
    stderr.write(`unknown --approve value\n${present(options, tuiHelp())}\n`);
    return EXIT_USAGE;
  }
  const tty = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!tty) {
    stderr.write(`tui needs a terminal. Use run for piped input.\n${present(options, tuiHelp())}\n`);
    return EXIT_USAGE;
  }
  const spec = projectSpec(parsed);
  if (spec.kind === 'error') {
    if (spec.reason === 'protected' && spec.protectedKind) {
      stderr.write(`${present(options, protectedTuiMessage(spec.protectedKind))}\n`);
      stderr.write('q 退出\n');
      await waitForQuit(options.stdin ?? process.stdin);
    } else {
      stderr.write(`${present(options, spec.message)}\n`);
    }
    return spec.code;
  }
  if ((options.stdout ?? process.stdout) === process.stdout) silenceLogConsole('all');
  // Loaded here so a run/chat/config invocation never pulls the renderer in.
  const { runTui } = await import('./tui/run.js');
  return withClient(parsed, options, async (client) => {
    const bound = await bindAndTrust(client, parsed, spec, stderr);
    if (typeof bound === 'number') return bound;
    const env = options.env ?? process.env;
    return runTui({
      client,
      product: getBrand().displayName,
      dataDir: dataDirFrom(parsed, env),
      ...(bound ? { projectId: bound.id, projectLabel: bound.label } : { projectLabel: projectStatusLabel(null) }),
      approvalPolicy: approval,
      runLogin: () =>
        loginCommand({
          request: (method, pathname, body) => client.request(method, pathname, body),
          stdin: options.stdin ?? process.stdin,
          stdout,
          stderr,
          stdinIsTTY: true,
          env,
          dataDir: dataDirFrom(parsed, env),
        }),
    });
  }, stderr);
}

async function doctorCommand(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(`${present(options, doctorHelp())}\n`);
    return EXIT_OK;
  }
  const env = options.env ?? process.env;
  const dataDir = dataDirFrom(parsed, env);
  const verbose = parsed.values.verbose === true || env.STEERABLE_DEBUG === '1';
  const logPath = logFilePath(dataDir);
  applyHostRuntimeEnv(dataDir, env);
  let settings: DoctorContext['settings'] = null;
  let settingsError: string | undefined;
  let busyChats: string[] | null = null;
  try {
    busyChats = listBusyChatIds(dataDir);
  } catch {
    busyChats = null;
  }
  // Read settings before the checks so the API-key row can report its source
  // even when the sidecar never starts.
  let client: AgentClient | undefined;
  const openClient = async (): Promise<AgentClient> => {
    if (!client) client = await createClientFor(parsed, options, env);
    return client;
  };
  try {
    const opened = await openClient();
    const response = await opened.request('GET', '/api/v2/local-settings/llm', undefined);
    if (response.status === 200) settings = response.data as DoctorContext['settings'];
    else settingsError = `读不到设置（${response.status}）`;
  } catch (error) {
    settingsError = error instanceof Error ? error.message : String(error);
  }
  const checks = await runDoctorChecks({
    nodeVersion: process.versions.node,
    dataDir,
    logPath,
    settings,
    ...(settingsError ? { settingsError } : {}),
    busyChats,
    deep: parsed.values.deep === true,
    env,
    bootSidecar: async () => {
      // The settings read above already booted the host; report the elapsed
      // time of that boot rather than starting a second one.
      return settings
        ? { ok: true as const, detail: '已就绪' }
        : { ok: false as const, detail: settingsError ?? 'sidecar 未启动' };
    },
  });
  await client?.close();
  if (parsed.values.json === true) {
    stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    stdout.write(`${renderDoctor(checks, { logPath, verbose }).join('\n')}\n`);
  }
  return doctorExitCode(checks);
}

async function webCommandFrom(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(`${present(options, webHelp())}\n`);
    return EXIT_OK;
  }
  const raw = parsed.values.port;
  const port = typeof raw === 'string' ? Number(raw) : 4787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    stderr.write(`invalid --port\n${present(options, webHelp())}\n`);
    return EXIT_USAGE;
  }
  if ((options.stdout ?? process.stdout) === process.stdout) silenceLogConsole('routine');
  return webCommand({
    stdout,
    stderr,
    port,
    env: options.env ?? process.env,
    ...(parsed.values.once === true ? { once: true } : {}),
  });
}

async function createClientFor(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  env: NodeJS.ProcessEnv,
): Promise<AgentClient> {
  const dataDir = dataDirFrom(parsed, env);
  env.DEEPPATH_USER_DATA_DIR = dataDir;
  const create = options.createClient ?? ((clientOptions: LocalClientOptions) => createLocalClient(clientOptions));
  return create({ dataDir, env, startSidecar: options.createClient ? false : true, hasWindow: () => true });
}

async function credentialCommand(
  parsed: ReturnType<typeof parseArgs>,
  options: CliOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  kind: 'login' | 'logout',
): Promise<number> {
  if (parsed.values.help) {
    stdout.write(`${present(options, kind === 'login' ? loginHelp() : logoutHelp())}\n`);
    return EXIT_OK;
  }
  const env = options.env ?? process.env;
  const dataDir = dataDirFrom(parsed, env);
  env.DEEPPATH_USER_DATA_DIR = dataDir;
  applyHostRuntimeEnv(dataDir, env);
  const client = await createClientFor(parsed, options, env);
  try {
    const request = (method: string, pathname: string, body?: unknown) => client.request(method, pathname, body);
    if (kind === 'logout') return await logoutCommand({ request, stdout, stderr });
    return await loginCommand({
      request,
      stdin: options.stdin ?? process.stdin,
      stdout,
      stderr,
      stdinIsTTY: options.stdinIsTTY ?? Boolean(process.stdin.isTTY),
      env,
      dataDir,
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_TURN_FAILED;
  } finally {
    await client.close();
  }
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
    if (interrupted) return EXIT_INTERRUPTED;
    return code;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_TURN_FAILED;
  } finally {
    if (timer) clearTimeout(timer);
    if (options.installSignals) process.off('SIGINT', onSigint);
    await client?.close();
  }
}

function projectSpec(parsed: ReturnType<typeof parseArgs>): ProjectSpec {
  const fs = defaultProjectFs();
  return resolveProjectRequest({
    cwd: process.cwd(),
    ...(typeof parsed.values.project === 'string' ? { projectArg: parsed.values.project } : {}),
    ...(typeof parsed.values.cwd === 'string' ? { cwdArg: parsed.values.cwd } : {}),
    noProject: parsed.values['no-project'] === true,
    ...fs,
  });
}

async function bindProject(
  client: AgentClient,
  spec: ProjectSpec,
  stderr: NodeJS.WritableStream,
): Promise<{ id: string; label: string } | null | number> {
  if (spec.kind === 'none') return null;
  if (spec.kind === 'error') return spec.code;
  const response = await client.request('POST', '/api/v2/projects/resolve', {
    folderPath: spec.dir,
    origin: 'cli',
  });
  const data = response.data as {
    project?: { id?: string; name?: string; folderPath?: string };
    created?: boolean;
    error?: string;
  };
  if (response.status === 403) {
    stderr.write('该产品未启用项目模式，请使用 --no-project。\n');
    return EXIT_USAGE;
  }
  const project = data.project;
  if (response.status !== 200 || !project?.id || !project.name || !project.folderPath) {
    stderr.write(`${data.error ?? `failed to bind project (${response.status})`}\n`);
    return EXIT_USAGE;
  }
  if (data.created) stderr.write(`已绑定项目 ${project.name}：${project.folderPath}\n`);
  return {
    id: project.id,
    label: projectStatusLabel({ name: project.name, folderPath: project.folderPath }),
  };
}

async function bindAndTrust(
  client: AgentClient,
  parsed: ReturnType<typeof parseArgs>,
  spec: ProjectSpec,
  stderr: NodeJS.WritableStream,
): Promise<{ id: string; label: string } | null | number> {
  if (parsed.values.trust === true && spec.kind === 'none') {
    stderr.write('--trust 需要绑定项目，不能与 --no-project 同用。\n');
    return EXIT_USAGE;
  }
  const bound = await bindProject(client, spec, stderr);
  if (typeof bound === 'number' || !bound || parsed.values.trust !== true) return bound;
  const trusted = await client.request('PUT', `/api/v2/projects/${encodeURIComponent(bound.id)}/trust`, { trusted: true });
  if (trusted.status !== 200) {
    const data = trusted.data as { error?: string };
    stderr.write(`${data.error ?? `failed to trust project (${trusted.status})`}\n`);
    return EXIT_TURN_FAILED;
  }
  return bound;
}

async function waitForQuit(stdin: NodeJS.ReadableStream): Promise<void> {
  for await (const chunk of stdin) {
    if (String(chunk).includes('q')) return;
  }
}

function dataDirFrom(parsed: ReturnType<typeof parseArgs>, env: NodeJS.ProcessEnv): string {
  if (typeof parsed.values['data-dir'] === 'string') return parsed.values['data-dir'];
  if (env.DEEPPATH_USER_DATA_DIR) return env.DEEPPATH_USER_DATA_DIR;
  return getUserDataDir();
}

function present(options: CliOptions, text: string): string {
  return renderCommandName(text, options.commandName);
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

/**
 * Reads the package version at runtime.
 *
 * The CLI ships as `dist/` inside its package, so the manifest sits one level
 * up. A missing manifest (a stray build) reports `unknown` rather than
 * throwing: `--version` must never be the thing that fails.
 *
 * @returns The version, or `unknown`.
 */
function cliVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
