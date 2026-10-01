import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestRenderer } from '@opentui/core/testing';
import type { SSEEvent } from '@steerable/agent-protocol';

import { runTui } from '../src/tui/run.js';
import { TestTerminal } from './test-terminal.js';
import { registerTuiArtifact } from './tui-artifacts.js';
import { TuiHarness } from './tui-harness.js';

describe('deterministic TUI test framework', () => {
  const harnesses: TuiHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it('TUI-001A TUI-003 TUI-085 starts the plain assembly and restores the terminal on exit', async () => {
    const harness = new TuiHarness({
      caseId: 'TUI-001A',
      chats: [{ id: 'chat-1', title: 'Notes' }],
    });
    harnesses.push(harness);
    const terminal = new TestTerminal(100, 32);
    registerTuiArtifact(
      'TUI-001A-003-085-terminal',
      () => terminal.plainOutput(),
      () => terminal.operations.map((operation) => JSON.stringify(operation)),
    );
    const running = runTui({ client: harness.client, product: 'Demo', terminal });

    const initial = await waitForTerminal(terminal, (screen) => (
      screen.includes('Demo') && screen.includes('Notes') && screen.includes('demo-model')
    ));
    expect(initial).toContain('/help');
    expect(initial).toContain('发送');

    terminal.input('\x03');
    await expect(running).resolves.toBe(0);
    expect(terminal.operationNames()).toContain('stop');
    expect(terminal.operationNames()).toContain('showCursor');
  });

  it('TUI-005 falls back only for recognized OpenTUI FFI failures', async () => {
    let rendererError = new Error('OpenTUI native FFI is unavailable');
    vi.doMock('@opentui/core', async (importOriginal) => ({
      ...await importOriginal<typeof import('@opentui/core')>(),
      createCliRenderer: async () => {
        throw rendererError;
      },
    }));
    try {
      const harness = new TuiHarness({
        caseId: 'TUI-005',
        chats: [{ id: 'chat-1', title: 'Notes' }],
        stream: streamEvents([{ type: 'content', content: 'fallback ok' }]),
      });
      harnesses.push(harness);
      const terminal = new TestTerminal(100, 32);
      registerTuiArtifact(
        'TUI-005-terminal',
        () => terminal.plainOutput(),
        () => terminal.operations.map((operation) => JSON.stringify(operation)),
      );
      const running = runTui({
        client: harness.client,
        product: 'Demo',
        fallbackTerminal: terminal,
      });
      await waitForTerminal(terminal, (screen) => screen.includes('Demo'));
      terminal.input('hello');
      terminal.input('\r');
      await waitForTerminal(terminal, (screen) => screen.includes('fallback ok'));
      terminal.input('\x03');
      await expect(running).resolves.toBe(0);

      rendererError = new Error('database unavailable');
      const rejectedTerminal = new TestTerminal(100, 32);
      await expect(runTui({
        client: harness.client,
        product: 'Demo',
        fallbackTerminal: rejectedTerminal,
      })).rejects.toThrow('database unavailable');
      expect(rejectedTerminal.operationNames()).not.toContain('start');
    } finally {
      vi.doUnmock('@opentui/core');
    }
  });

  it('TUI-006 restores the terminal and rejects with the initialization error', async () => {
    const harness = new TuiHarness({
      caseId: 'TUI-006',
      request: () => {
        throw new Error('database unavailable');
      },
    });
    harnesses.push(harness);
    const terminal = new TestTerminal(100, 32);
    registerTuiArtifact(
      'TUI-006-terminal',
      () => terminal.plainOutput(),
      () => terminal.operations.map((operation) => JSON.stringify(operation)),
    );

    await expect(runTui({ client: harness.client, product: 'Demo', terminal }))
      .rejects.toThrow('database unavailable');
    expect(terminal.operationNames()).toContain('stop');
    expect(terminal.operationNames()).toContain('showCursor');
  });

  it('TUI-006 destroys the OpenTUI renderer after initialization fails', async () => {
    const harness = new TuiHarness({
      caseId: 'TUI-006-open',
      request: () => {
        throw new Error('database unavailable');
      },
    });
    harnesses.push(harness);
    const setup = await createTestRenderer({ width: 100, height: 32 });
    const destroyed = vi.spyOn(setup.renderer, 'destroy');

    await expect(runTui({
      client: harness.client,
      product: 'Demo',
      openRenderer: setup.renderer,
    })).rejects.toThrow('database unavailable');
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it('TUI-010 TUI-020 TUI-021 exposes intermediate and final user-visible frames', async () => {
    const harness = new TuiHarness({
      caseId: 'TUI-010',
      chats: [{ id: 'chat-1', title: 'Notes' }],
      stream: streamEvents([
        { type: 'content', content: '答' },
        { type: 'content', content: '案' },
        { type: 'content', content: '完成' },
        { type: 'done' },
      ]),
    });
    harnesses.push(harness);
    await harness.open();

    harness.type('你');
    expect(harness.screen()).toContain('你');
    expect(harness.screen()).not.toContain('user 你');
    harness.type('好');
    expect(harness.screen()).toContain('你好');

    harness.input('\r');
    const final = await harness.waitForText('答案完成');
    expect(final).toContain('user 你好');
    expect(final).not.toContain('running');
    expect(harness.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });
});

function streamEvents(events: SSEEvent[]): () => AsyncIterable<SSEEvent> {
  return async function* () {
    for (const event of events) yield event;
  };
}

async function waitForTerminal(
  terminal: TestTerminal,
  predicate: (screen: string) => boolean,
  timeoutMs = 1_000,
): Promise<string> {
  const started = Date.now();
  let screen = terminal.plainOutput();
  while (!predicate(screen)) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for terminal output\n${screen}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    screen = terminal.plainOutput();
  }
  return screen;
}
