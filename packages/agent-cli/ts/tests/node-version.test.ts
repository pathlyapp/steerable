import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_NODE,
  REQUIRED_NODE_TUI,
  ensureSupportedNode,
  nodeDoctorLine,
  satisfies,
  supportsTui,
} from '../src/node-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('node version', () => {
  it('compares major.minor.patch on the command-line floor', () => {
    expect(satisfies('22.12.0', REQUIRED_NODE)).toBe(false);
    expect(satisfies('22.18.9', REQUIRED_NODE)).toBe(false);
    expect(satisfies('22.19.0', REQUIRED_NODE)).toBe(true);
    expect(satisfies('v24.1.0', REQUIRED_NODE)).toBe(true);
    expect(satisfies('26.10.0', REQUIRED_NODE)).toBe(true);
    expect(satisfies('not-a-version', REQUIRED_NODE)).toBe(false);
  });

  it('keeps the terminal interface on its own higher floor', () => {
    expect(supportsTui('22.19.0')).toBe(false);
    expect(supportsTui('26.3.9')).toBe(false);
    expect(supportsTui('26.4.0')).toBe(true);
  });

  it('prints the required and current versions and exits before other modules', () => {
    let written = '';
    expect(ensureSupportedNode('22.12.0', { write: (chunk) => { written += chunk; } }, 'agent')).toBe(1);
    expect(written).toBe(
      'agent 需要 Node.js 22.19.0 或更高版本，当前为 22.12.0。\n升级方法：https://nodejs.org/\n',
    );
    expect(ensureSupportedNode('22.19.0', { write: () => { throw new Error('no output'); } }, 'agent')).toBe(0);
    expect(nodeDoctorLine('26.4.1')).toBe('Node.js: 26.4.1（需要 ≥ 22.19.0） ✓\n');
    expect(nodeDoctorLine('22.12.0')).toContain('✗');
    // A runtime that satisfies the CLI but not the TUI says so in the same row.
    expect(nodeDoctorLine('22.19.0')).toContain('tui 需要 ≥ 26.4.0');
  });

  it('keeps the CLI floor below the renderer floor the TUI declares', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'packages/agent-cli/ts/package.json'), 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${REQUIRED_NODE}`);
    expect(REQUIRED_NODE).toBe('22.19.0');
    expect(REQUIRED_NODE_TUI).toBe('26.4.0');
    // The renderer's own floor is what forces the split; read it from the
    // installed package rather than restating it.
    const opentui = JSON.parse(
      readFileSync(path.join(root, 'packages/agent-cli/ts/node_modules/@opentui/core/package.json'), 'utf8'),
    ) as { engines?: { node?: string } };
    expect(opentui.engines?.node).toBe(`>=${REQUIRED_NODE_TUI}`);
  });

  it('leaves the CLI module graph free of the renderer', () => {
    const bin = readFileSync(path.join(root, 'packages/agent-cli/ts/src/bin.ts'), 'utf8');
    expect(bin).toContain("from './node-version.js'");
    expect(bin).toContain("import('./cli.js')");
    expect(bin).not.toContain("from './cli.js'");
    const cli = readFileSync(path.join(root, 'packages/agent-cli/ts/src/cli.ts'), 'utf8');
    expect(cli).not.toMatch(/^import .*tui\/run\.js/m);
    expect(cli).toContain("await import('./tui/run.js')");
  });
});
