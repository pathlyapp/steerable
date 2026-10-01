import { ProcessTerminal, TuiAltScreen, type Terminal } from '@earendil-works/pi-tui';
import type { CliRenderer } from '@opentui/core';
import type { AgentClient } from '@steerable/agent-client';

import { installAgentKeybindings } from './keys.js';
import { transcriptPage } from './scroll.js';
import { AgentTui } from './session.js';

export interface RunTuiOptions {
  client: AgentClient;
  product: string;
  dataDir?: string;
  terminal?: Terminal;
  fallbackTerminal?: Terminal;
  openRenderer?: CliRenderer;
}

export async function runTui(options: RunTuiOptions): Promise<number> {
  installAgentKeybindings();
  if (options.terminal) return runPlainTui(options);
  try {
    return await runOpenTui(options);
  } catch (error) {
    if (!openTuiUnavailable(error)) throw error;
    return runPlainTui({
      ...options,
      ...(options.fallbackTerminal ? { terminal: options.fallbackTerminal } : {}),
    });
  }
}

async function runOpenTui(options: {
  client: AgentClient;
  product: string;
  dataDir?: string;
  openRenderer?: CliRenderer;
}): Promise<number> {
  const createCliRenderer = options.openRenderer
    ? null
    : (await import('@opentui/core')).createCliRenderer;
  const { OpenTuiView } = await import('./view.js');
  const renderer = options.openRenderer ?? await createCliRenderer!({
    exitOnCtrlC: false,
    useMouse: false,
    consoleMode: 'disabled',
    openConsoleOnError: false,
    screenMode: 'alternate-screen',
    backgroundColor: '#16161e',
    targetFps: 30,
  });
  return new Promise((resolve, reject) => {
    const session = new AgentTui(options.client, {
      product: options.product,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      onChange() {
        view.apply(session.snapshot());
      },
      onExit() {
        renderer.destroy();
        resolve(0);
      },
    });
    const view = new OpenTuiView(renderer);
    renderer.prependInputHandler((sequence) => {
      if (yieldsToRenderer(sequence)) return false;
      const page = transcriptPage(sequence);
      if (page !== 0) {
        view.scrollPage(page);
        return true;
      }
      session.handleInput(sequence);
      return true;
    });
    void session.open().then(
      () => view.apply(session.snapshot()),
      (error: unknown) => {
        renderer.destroy();
        reject(error);
      },
    );
  });
}

function runPlainTui(options: {
  client: AgentClient;
  product: string;
  dataDir?: string;
  terminal?: Terminal;
}): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  return new Promise((resolve, reject) => {
    const session = new AgentTui(options.client, {
      product: options.product,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      onChange() {
        tui.requestRender();
      },
      onExit() {
        tui.stop();
        resolve(0);
      },
    });
    tui.addChild(session);
    tui.setFocus(session);
    void session.open().then(
      () => tui.requestRender(),
      (error: unknown) => {
        tui.stop();
        reject(error);
      },
    );
    tui.start();
  });
}

/** Terminal reports (capability replies, focus) must reach the renderer so Shift+Enter stays distinct from Enter. */
export function yieldsToRenderer(sequence: string): boolean {
  if (sequence === '\x1b[I' || sequence === '\x1b[O') return true;
  if (sequence.startsWith('\x1b]') || sequence.startsWith('\x1bP') || sequence.startsWith('\x1b_')) return true;
  if (sequence.startsWith('\x1b[?')) return true;
  return /^\x1b\[\d+(;\d+)?R$/.test(sequence);
}

function openTuiUnavailable(error: unknown): boolean {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const message = `${error instanceof Error ? error.message : String(error)} ${cause}`;
  return message.includes('OpenTUI native FFI')
    || message.includes('--experimental-ffi')
    || message.includes('node:ffi');
}
