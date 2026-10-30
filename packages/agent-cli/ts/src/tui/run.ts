import { ProcessTerminal, TuiAltScreen, type Terminal } from '@earendil-works/pi-tui';
import type { CliRenderer } from '@opentui/core';
import type { AgentClient } from '@steerable/agent-client';

import { installAgentKeybindings } from './keys.js';
import { transcriptPage } from './scroll.js';
import { AgentTui } from './session.js';
import type { ApprovalSpec } from '../approve.js';

export interface RunTuiOptions {
  client: AgentClient;
  product: string;
  dataDir?: string;
  projectId?: string;
  projectLabel?: string;
  approvalPolicy?: ApprovalSpec;
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

async function runOpenTui(options: RunTuiOptions): Promise<number> {
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
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.projectLabel ? { projectLabel: options.projectLabel } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      onChange() {
        view.apply(session.snapshot());
      },
      onExit() {
        stop();
        resolve(0);
      },
    });
    const view = new OpenTuiView(renderer);
    const onPaste = (event: { bytes: Uint8Array; stopPropagation: () => void }): void => {
      event.stopPropagation();
      session.acceptDecodedPaste(new TextDecoder().decode(event.bytes));
    };
    renderer.keyInput.on('paste', onPaste);
    const stop = (): void => {
      renderer.keyInput.off('paste', onPaste);
      renderer.destroy();
    };
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
        stop();
        reject(error);
      },
    );
  });
}

function runPlainTui(options: RunTuiOptions): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  return new Promise((resolve, reject) => {
    const session = new AgentTui(options.client, {
      product: options.product,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.projectLabel ? { projectLabel: options.projectLabel } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
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
