#!/usr/bin/env node
/**
 * Runs the README's command-line quickstart against a fake gateway.
 *
 * The README is the install path a new user follows, and it has drifted before.
 * This check extracts the block between `<!-- quickstart:cli -->` markers and
 * runs the commands in order, so a command that cannot work fails CI instead of
 * a user's first ten minutes. Provider calls go to `fake-openai-server.ts`, so
 * no credential and no network are involved.
 *
 * Steps that need a human (`login`) are replaced by the environment-variable
 * route the README also documents; that route is what CI and scripts use.
 *
 * Usage:
 *   node scripts/quickstart_smoke.mjs            # from the repo root
 *   node scripts/quickstart_smoke.mjs --keep     # leave the temp dir for debugging
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const CLI = path.join(ROOT, 'packages', 'agent-cli', 'ts', 'dist', 'bin.js');
const START = '<!-- quickstart:cli -->';
const END = '<!-- /quickstart:cli -->';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readQuickstart() {
  const text = fs.readFileSync(README, 'utf8');
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    fail(`README.md has no ${START} … ${END} block`);
  }
  const block = text.slice(start + START.length, end);
  // Only the first bash block is the CLI path; later ones document the
  // environment route and are applied, not re-executed.
  const first = /```bash\n([\s\S]*?)```/.exec(block);
  if (!first) fail('the quickstart block has no bash example');
  const commands = [];
  for (const raw of (first[1] ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    commands.push(line);
  }
  if (commands.length === 0) fail('the quickstart block has no commands');
  return commands;
}

/**
 * Builds a shell-free invocation of the CLI from a README line.
 *
 * The line is `steerable-cli <args>`; splitting on whitespace outside quotes
 * turns it into argv, so no shell has to interpret the quoting. This is the
 * only form that behaves the same on macOS, Linux and Windows.
 *
 * @param rest Everything after `steerable-cli`.
 * @returns Arguments for {@link run}'s direct mode.
 */
function directCli(rest) {
  return { direct: { command: process.execPath, args: [CLI, ...splitArgs(rest)] } };
}

/**
 * Splits a command line into arguments, honouring double quotes.
 *
 * @param text Argument text without the executable name.
 * @returns The arguments.
 */
function splitArgs(text) {
  const args = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) args.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

async function run(command, env, options = {}) {
  console.log(`$ ${command}`);
  // `direct` skips the shell entirely: `cmd.exe` re-parses its argv and turns a
  // quoted absolute path into a path relative to cwd, which is how
  // `D:\a\steerable\steerable\"C:\Users\..."` appeared. Anything this script
  // runs itself (the seed and the CLI) goes direct; the README lines are shell
  // text by nature and use the platform shell.
  const direct = options.direct;
  const [shell, shellArgs] = direct
    ? [direct.command, direct.args]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', command]]
      : ['/bin/sh', ['-c', command]];
  const child = spawn(shell, shellArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (options.expectCode !== undefined ? code !== options.expectCode : code !== 0) {
    console.error(stdout);
    console.error(stderr);
    fail(`quickstart command failed (${code}): ${command}`);
  }
  return { stdout, stderr };
}

/**
 * Writes the settings a completed `login` would have written.
 *
 * Uses the CLI's own client against a throwaway data directory, so the check
 * exercises the same storage path the real flow uses.
 *
 * @param baseUrl Fake gateway URL.
 * @param env Environment for the temp HOME.
 */
async function seedSettings(baseUrl, env) {
  // `import()` needs a URL on Windows: a bare `C:\...` path is rejected with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const clientModule = pathToFileURL(path.join(ROOT, 'packages/agent-client/ts/dist/index.js')).href;
  const seed = `
    const { createLocalClient } = await import(${JSON.stringify(clientModule)});
    const client = await createLocalClient({ dataDir: process.env.DEEPPATH_USER_DATA_DIR, startSidecar: false });
    const saved = await client.request('POST', '/api/v2/local-settings/llm', {
      provider: 'openai-compat',
      vendorId: 'deepseek',
      model: 'fake-model',
      baseUrl: ${JSON.stringify(baseUrl)},
      apiKey: 'quickstart-not-a-real-key',
    });
    await client.close();
    if (saved.status !== 200) { console.error('seed failed', saved.status); process.exit(1); }
    // The host leaves timers behind; exit explicitly so the parent's spawn
    // does not wait on them.
    process.exit(0);
  `;
  const scriptPath = path.join(os.tmpdir(), `steerable-seed-${process.pid}.mjs`);
  fs.writeFileSync(scriptPath, seed);
  try {
    await run(`node ${scriptPath}`, env, { direct: { command: process.execPath, args: [scriptPath] } });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

async function main() {
  const keep = process.argv.includes('--keep');
  if (!fs.existsSync(CLI)) fail(`build the CLI first: expected ${CLI}`);
  const commands = readQuickstart();
  const gateway = await import('./fake-openai-server.mjs').then((module) => module.startFakeGateway());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steerable-quickstart-'));
  const dataDir = path.join(home, '.agent-shell');
  const env = {
    ...process.env,
    HOME: home,
    DEEPPATH_USER_DATA_DIR: dataDir,
    STEERABLE_DEBUG: '',
  };
  // Point the provider at the fake gateway. `login` cannot run without a TTY,
  // so the settings are written the way a completed login would write them:
  // through the same endpoint, with the fake gateway as the base URL and a key
  // supplied by environment.
  env.DEEPSEEK_API_KEY = 'quickstart-not-a-real-key';
  await seedSettings(gateway.baseUrl, env);
  let failed = false;
  try {
    for (const command of commands) {
      if (command.startsWith('npm install')) {
        // Installing the published CLI is the release's job; this check runs
        // the workspace build, which is the same code.
        console.log(`$ ${command}   # skipped: the workspace build stands in for the published package`);
        continue;
      }
      if (command.includes('steerable-cli login')) {
        console.log(`$ ${command}   # skipped: needs a TTY; setting the key via environment below`);
        continue;
      }
      if (/^steerable-cli\s*(#.*)?$/.test(command)) {
        // Bare `steerable-cli` opens the TUI, which needs a terminal. It is in
        // the README as a way to start a session, not a scriptable step.
        console.log(`$ ${command}   # skipped: opens the terminal interface`);
        continue;
      }
      if (command.startsWith('export ')) {
        // The README documents the environment route; apply it to later steps.
        const [, assignment] = /^export\s+(\w+)=(.+)$/.exec(command) ?? [];
        if (assignment) env[assignment[1]] = assignment[2].replace(/^['"]|['"]$/g, '');
        continue;
      }
      // `run` reads stdin when no task is given; a quickstart turn always has
      // one. The child's stdin is already `ignore` in `run()`, so no shell
      // redirection is needed — and `< /dev/null` would be a POSIX-only syntax
      // on a job that also runs on Windows.
      const { stdout, stderr } = await run(command, env, directCli(command.replace(/^steerable-cli\s*/, '')));
      if (command.includes('run "summarize this repo"') && !stdout.includes('hello from the fake gateway')) {
        console.error(stdout, stderr);
        fail('the run command did not reach the fake gateway');
      }
    }
    // A turn without a key must be blocked before any request reaches the
    // provider; that is the behaviour the quickstart promises. A fresh data
    // directory is required: the settings written above already hold a key.
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerable-quickstart-nokey-'));
    const blocked = await run(
      `steerable-cli run "no key" --no-project --data-dir ${freshDir}`,
      { ...env, DEEPPATH_USER_DATA_DIR: freshDir, DEEPSEEK_API_KEY: '' },
      { expectCode: 78, ...directCli(`run "no key" --no-project --data-dir ${freshDir}`) },
    );
    fs.rmSync(freshDir, { recursive: true, force: true });
    if (!blocked.stderr.includes('还没有配置模型的 API key')) {
      fail('a missing key did not produce the preflight text');
    }
    console.log('quickstart ok');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await gateway.close();
    if (!keep && !failed) fs.rmSync(home, { recursive: true, force: true });
    else console.log(`kept ${home}`);
  }
}

await main();
