/**
 * Credential prompts for `login`, shared by the subcommand and the TUI.
 *
 * The flow is: pick a provider, optionally a base URL, enter the key without
 * echo, verify it with one model-list request, then pick a default model. A
 * wrong key is never saved; an unreachable host can still be saved so an
 * offline gateway stays usable.
 */

import { createInterface } from 'node:readline';

/** One selectable provider. */
export interface ProviderChoice {
  /** Vendor id stored in settings (`deepseek`, `custom`, …). */
  id: string;
  label: string;
  apiBaseUrl: string | null;
  wireKind: string;
  models: string[];
  envVars: readonly string[];
  featured: boolean;
  /** Local providers need no key. */
  needsKey: boolean;
}

/** Read one line of input. */
export type LineReader = (prompt: string) => Promise<string | null>;

/**
 * Opens a line reader over the terminal.
 *
 * @param input Where to read; defaults to stdin.
 * @param output Where to echo prompt markers; defaults to stdout.
 * @returns A reader that resolves to `null` on Ctrl+D.
 */
export function createLineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): LineReader {
  const rl = createInterface({ input, output, terminal: false });
  const pending: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pending.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  return (prompt: string) => {
    output.write(prompt);
    const line = pending.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

/**
 * Chooses one entry from a numbered list.
 *
 * @param reader Line reader.
 * @param rows Options in display order.
 * @param render Maps one option to its display text.
 * @param title Prompt shown above the list.
 * @param output Where the list is written.
 * @param fallbackIndex Index returned on an empty answer.
 * @returns The chosen index, or null when the user cancelled.
 */
export async function chooseIndex(
  reader: LineReader,
  rows: readonly unknown[],
  render: (row: never, index: number) => string,
  title: string,
  output: NodeJS.WritableStream,
  fallbackIndex = 0,
): Promise<number | null> {
  output.write(`${title}\n`);
  rows.forEach((row, index) => {
    output.write(`  ${String(index + 1).padStart(2)}. ${render(row as never, index)}\n`);
  });
  while (true) {
    const answer = await reader('> ');
    if (answer === null) return null;
    const trimmed = answer.trim();
    if (!trimmed) return fallbackIndex;
    if (/^(esc|q|cancel)$/i.test(trimmed)) return null;
    const picked = Number(trimmed);
    if (Number.isInteger(picked) && picked >= 1 && picked <= rows.length) return picked - 1;
    output.write(`  请输入 1 到 ${rows.length} 之间的编号，或直接回车用默认项。\n`);
  }
}

/**
 * Reads a secret without echoing it.
 *
 * Falls back to a plain line read when the terminal cannot enter raw mode
 * (piped input in tests). The fallback takes the session's reader: a fresh one
 * per call would drop lines the stream already buffered.
 *
 * @param prompt Text written before the input.
 * @param input Terminal input.
 * @param output Where the prompt and the newline are written.
 * @param reader Shared line reader used when the terminal cannot hide input.
 * @returns The entered text, or null at end of input.
 */
export function readSecret(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  reader?: LineReader,
): Promise<string | null> {
  const stdin = input as NodeJS.ReadStream;
  const canHide = typeof stdin.setRawMode === 'function' && Boolean(stdin.isTTY);
  if (!canHide) return (reader ?? createLineReader(input, output))(prompt);
  output.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          output.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          output.write('\n');
          resolve(null);
          return;
        }
        if (char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/**
 * Verifies a credential against the provider's model list.
 *
 * @param apiKey The key to test; empty for local providers.
 * @returns Result with the model count, a rejection status, or a transport reason.
 */
export type VerifyResult =
  | { kind: 'ok'; models: string[] }
  | { kind: 'rejected'; status: number }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'no-models'; reason: string };
