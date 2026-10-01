import { afterEach, describe, expect, it } from 'vitest';

import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';

import type { TuiScreen } from '../src/tui/screen.js';
import { OpenTuiView } from '../src/tui/view.js';
import { registerTuiArtifact } from './tui-artifacts.js';

describe('OpenTUI cell renderer', () => {
  const renderers: TestRendererSetup[] = [];

  afterEach(() => {
    for (const setup of renderers.splice(0)) setup.renderer.destroy();
  });

  it('TUI-013 TUI-015 TUI-022 TUI-026 TUI-028 renders Unicode, Markdown, and a capped composer', async () => {
    const setup = await createTestRenderer({ width: 100, height: 32 });
    renderers.push(setup);
    registerTuiArtifact('TUI-013-015-022-026-028', setup.captureCharFrame);
    const view = new OpenTuiView(setup.renderer);
    view.apply(screen({
      lines: [
        { kind: 'assistant', text: '# 标题\n**粗体** `code`\n```ts\nconst 组合 = \"👍\";\n```' },
        { kind: 'assistant', text: '未闭合代码\n```\nstill visible' },
      ],
    }));

    await setup.flush();
    for (let index = 0; index < 10; index += 1) view.scrollPage(-1);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('Demo');
    expect(frame).toContain('标题');
    expect(frame).toContain('粗体');
    expect(frame).toContain('const 组合');
    expect(frame).toContain('still visible');
    expect(frame).toContain('/help');
    expect(frame).not.toContain('**粗体**');
    expect(frameRows(frame)).toHaveLength(32);
    const heading = setup.captureSpans().lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes('标题'));
    expect(heading?.attributes).not.toBe(0);

    const draft = Array.from({ length: 9 }, (_, index) => `第${index + 1}行 é 👨‍👩‍👧‍👦`).join('\n');
    view.apply(screen({ draft, cursor: draft.length }));
    for (const [width, height] of [[40, 12], [120, 40], [80, 24]] as const) {
      setup.resize(width, height);
      await setup.renderOnce();
      const resized = setup.captureCharFrame();
      expect(frameRows(resized)).toHaveLength(height);
      expect(resized).toContain('Demo');
      expect(resized).toContain('中断');
      if (width >= 80) expect(resized).toContain('/help');
    }
  });

  it('TUI-040 TUI-081 TUI-082 TUI-083 TUI-084 exposes approval semantics and color roles in cells', async () => {
    const setup = await createTestRenderer({ width: 100, height: 32 });
    renderers.push(setup);
    registerTuiArtifact('TUI-040-081-082-083-084', setup.captureCharFrame);
    const view = new OpenTuiView(setup.renderer);
    view.apply(screen({
      lines: [
        { kind: 'user', text: '中文 👍 é' },
        { kind: 'tool', name: 'local_exec_shell', args: 'echo ok', status: '运行中', open: false },
      ],
      approval: { toolName: 'local_exec_shell', summary: 'echo ok' },
      status: 'running',
    }));

    await setup.flush();
    view.scrollEdge('top');
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('审批 local_exec_shell echo ok');
    expect(frame).toContain('本次允许');
    expect(frame).toContain('本会话');
    expect(frame).toContain('总是');
    expect(frame).toContain('拒绝');
    expect(frame).toContain('中止');
    expect(frame).toContain('中文 👍 é');

    const colors = new Set(
      setup.captureSpans().lines
        .flatMap((line) => line.spans)
        .filter((span) => span.text.trim().length > 0)
        .map((span) => `${span.fg.r},${span.fg.g},${span.fg.b},${span.fg.a}`),
    );
    expect(colors.size).toBeGreaterThanOrEqual(4);
  });

  it('TUI-024 follows streaming output until the user pages upward', async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    renderers.push(setup);
    registerTuiArtifact('TUI-024', setup.captureCharFrame);
    const view = new OpenTuiView(setup.renderer);
    const content = Array.from({ length: 60 }, (_, index) => `answer row ${index + 1}`).join('\n');
    view.apply(screen({
      lines: [{ kind: 'assistant', text: content, streaming: true }],
      status: 'running',
    }));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('answer row 60');

    view.scrollPage(-1);
    await setup.renderOnce();
    const reading = setup.captureCharFrame();
    expect(reading).not.toContain('answer row 60');
    const anchor = reading.match(/answer row \d+/)?.[0];
    expect(anchor).toBeTruthy();

    view.apply(screen({
      lines: [{ kind: 'assistant', text: `${content}\nanswer row 61`, streaming: true }],
      status: 'running',
    }));
    await setup.renderOnce();
    const appended = setup.captureCharFrame();
    expect(appended).toContain(anchor);
    expect(appended).not.toContain('answer row 61');

    view.scrollEdge('bottom');
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('answer row 61');
  });

  it('TUI-050 keeps the selected chat on screen', async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    renderers.push(setup);
    registerTuiArtifact('TUI-050', setup.captureCharFrame);
    const view = new OpenTuiView(setup.renderer);
    const transcript = Array.from({ length: 40 }, (_, index) => ({
      kind: 'assistant' as const,
      text: `transcript ${index}`,
    }));
    view.apply(screen({ lines: transcript }));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('transcript 39');

    const chats = Array.from({ length: 30 }, (_, index) => ({
      id: `id-${String(index).padStart(2, '0')}`,
      title: `S${String(index).padStart(2, '0')}`,
      busy: false,
      selected: index === 0,
    }));
    view.apply(screen({ chats, lines: transcript }));
    await setup.flush();
    const opened = setup.captureCharFrame();
    expect(opened).toContain('S00');
    expect(opened).not.toContain('S29');

    view.apply(screen({
      chats: chats.map((chat, index) => ({ ...chat, selected: index === 20 })),
      lines: transcript,
    }));
    await setup.flush();
    const moved = setup.captureCharFrame();
    expect(moved).toContain('S20');
    expect(moved).not.toContain('S00');
    expect(moved).not.toContain('S29');

    view.apply(screen({ chats: null, lines: transcript }));
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('transcript 39');
  });
});

function screen(overrides: Partial<TuiScreen> = {}): TuiScreen {
  return {
    product: 'Demo',
    title: 'Notes',
    modelName: 'demo-model',
    lines: [],
    approval: null,
    ask: null,
    chats: null,
    readOnly: false,
    help: false,
    draft: '',
    cursor: 0,
    status: '',
    ...overrides,
  };
}

function frameRows(frame: string): string[] {
  return frame.endsWith('\n') ? frame.slice(0, -1).split('\n') : frame.split('\n');
}
