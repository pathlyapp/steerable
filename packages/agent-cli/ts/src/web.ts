/**
 * `steerable-cli web`: the neutral shell in a browser.
 *
 * `pnpm agent-shell:web` only exists inside a framework checkout. A globally
 * installed CLI needs the same entry point, otherwise the first-run page and
 * the browser shell are reachable only from the repository.
 *
 * The command serves the built web bundle over a loopback port and prints the
 * URL. It keeps running until interrupted.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_CONFIG, EXIT_OK, EXIT_TURN_FAILED } from './exit-codes.js';

export interface WebCommandOptions {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  port: number;
  env: NodeJS.ProcessEnv;
  /** Serve one request then stop; used by the quickstart check. */
  once?: boolean;
  /** Candidate directories; tests pin this instead of the machine layout. */
  candidates?: readonly string[];
}

/** A web bundle that can be served, or the reason there is none. */
export type WebBundle = { kind: 'ok'; dir: string } | { kind: 'missing'; tried: string[] };

/**
 * Locates the built web app.
 *
 * An explicit `DEEPPATH_WEB_DIST` wins. Otherwise the bundle next to the CLI's
 * own package is used, then the framework checkout's build output. A global
 * npm install ships the bundle inside the CLI package, so the first two cases
 * cover every published install.
 *
 * @param env Environment to read the override from.
 * @returns The directory, or the paths that were checked.
 */
export function locateWebBundle(env: NodeJS.ProcessEnv = process.env): WebBundle {
  return locateWebBundleIn(defaultCandidates(env));
}

/**
 * Candidate directories, most specific first.
 *
 * @param env Environment to read the override from.
 * @returns Paths to try, in order.
 */
export function defaultCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    env.DEEPPATH_WEB_DIST?.trim() ?? '',
    // Packed CLI: the bundle sits beside `dist/` inside the package.
    path.join(here, '..', 'web'),
    // Framework checkout: the shell's own build output.
    path.join(here, '..', '..', '..', 'agent-shell', 'web', 'app', 'dist'),
  ].filter((entry) => Boolean(entry));
}

/**
 * Resolves a bundle from an explicit candidate list.
 *
 * @param candidates Directories to try, in order.
 * @returns The first with an `index.html`, or the paths that were checked.
 */
export function locateWebBundleIn(candidates: readonly string[]): WebBundle {
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return { kind: 'ok', dir };
  }
  return { kind: 'missing', tried: [...candidates] };
}

/**
 * Starts the browser shell and blocks until interrupted.
 *
 * @returns Process exit code.
 */
export async function webCommand(options: WebCommandOptions): Promise<number> {
  const bundle = options.candidates
    ? locateWebBundleIn(options.candidates)
    : locateWebBundle(options.env);
  if (bundle.kind === 'missing') {
    options.stderr.write('没有找到 web 构建产物。\n');
    options.stderr.write('  从源码运行：pnpm agent-shell:web\n');
    options.stderr.write('  或指定目录：export DEEPPATH_WEB_DIST=/path/to/dist\n');
    options.stderr.write(`  已检查：${bundle.tried.join('、')}\n`);
    return EXIT_CONFIG;
  }
  options.env.DEEPPATH_WEB_DIST = bundle.dir;
  let handle: { host: string; port: number; shutdown(): Promise<void> };
  try {
    // Loaded here so `run` and `doctor` never pull the HTTP server in.
    const { startBsHost } = await import('@steerable/agent-shell/server/start');
    handle = await startBsHost({ port: options.port });
  } catch (error) {
    options.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_TURN_FAILED;
  }
  const url = `http://${handle.host === '0.0.0.0' ? '127.0.0.1' : handle.host}:${handle.port}`;
  options.stdout.write(`Steerable Shell → ${url}\n`);
  if (options.once) {
    await handle.shutdown();
    return EXIT_OK;
  }
  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void handle.shutdown().finally(() => resolve(EXIT_OK));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
