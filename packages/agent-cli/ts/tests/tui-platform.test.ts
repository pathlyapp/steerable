import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTestRenderer } from '@opentui/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { formatKey } from '../src/tui/keys.js';
import { renderScreen, visibleText, type TuiScreen } from '../src/tui/screen.js';
import { OpenTuiView } from '../src/tui/view.js';
import { registerTuiArtifact } from './tui-artifacts.js';

describe('TUI platform matrix', () => {
  beforeAll(async () => {
    const artifactRoot = process.env.TUI_ARTIFACT_DIR;
    if (!artifactRoot) return;
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(
      path.join(artifactRoot, `platform-${process.platform}.json`),
      `${JSON.stringify({
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        node: process.version,
        term: process.env.TERM ?? null,
        lang: process.env.LANG ?? null,
        runner: process.env.RUNNER_NAME ?? null,
        renderer: ['pi-tui-memory', 'OpenTUI-test-renderer'],
      }, null, 2)}\n`,
    );
  });

  it('TUI-120 TUI-121 TUI-122 uses native platform key labels', () => {
    expect(['darwin', 'linux', 'win32']).toContain(process.platform);
    const expected = process.platform === 'darwin' ? 'Option+V' : 'Alt+V';
    expect(formatKey('alt+v')).toBe(expected);
    expect(formatKey('ctrl+c')).toBe(process.platform === 'darwin' ? 'Control+C' : 'Ctrl+C');
  });

  it('TUI-123 keeps essential content equivalent across renderers', async () => {
    const value = screen();
    const plain = visibleText(renderScreen(value, 80));
    const setup = await createTestRenderer({ width: 80, height: 24 });
    registerTuiArtifact('TUI-123', setup.captureCharFrame);
    const view = new OpenTuiView(setup.renderer);
    view.apply(value);
    await setup.flush();
    const native = setup.captureCharFrame();
    setup.renderer.destroy();

    for (const text of ['Demo', 'Notes', 'demo-model', 'user hello', 'answer', 'local_exec_shell']) {
      expect(plain).toContain(text);
      expect(native).toContain(text);
    }
  });
});

function screen(): TuiScreen {
  return {
    product: 'Demo',
    title: 'Notes',
    modelName: 'demo-model',
    lines: [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: '**answer**' },
      { kind: 'tool', name: 'local_exec_shell', args: 'echo ok', status: '✓' },
    ],
    approval: null,
    ask: null,
    chats: null,
    readOnly: false,
    help: false,
    draft: '',
    cursor: 0,
    status: '',
  };
}
