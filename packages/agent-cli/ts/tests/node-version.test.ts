import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_NODE,
  ensureSupportedNode,
  nodeDoctorLine,
  satisfies,
} from '../src/node-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('node version', () => {
  it('compares major.minor.patch and rejects Node 22', () => {
    expect(satisfies('22.12.0', REQUIRED_NODE)).toBe(false);
    expect(satisfies('v26.3.9', REQUIRED_NODE)).toBe(false);
    expect(satisfies('26.4.0', REQUIRED_NODE)).toBe(true);
    expect(satisfies('26.4.1', REQUIRED_NODE)).toBe(true);
    expect(satisfies('26.10.0', REQUIRED_NODE)).toBe(true);
    expect(satisfies('not-a-version', REQUIRED_NODE)).toBe(false);
  });

  it('prints the required and current versions and exits before other modules', () => {
    let written = '';
    expect(ensureSupportedNode('22.12.0', { write: (chunk) => { written += chunk; } }, 'agent')).toBe(1);
    expect(written).toBe(
      'agent 需要 Node.js 26.4.0 或更高版本，当前为 22.12.0。\n升级方法：https://nodejs.org/\n',
    );
    expect(ensureSupportedNode('26.4.0', { write: () => { throw new Error('no output'); } }, 'agent')).toBe(0);
    expect(nodeDoctorLine('26.4.1')).toBe('Node.js: 26.4.1（需要 ≥ 26.4.0） ✓\n');
    expect(nodeDoctorLine('22.12.0')).toContain('✗');
  });

  it('matches OpenTUI engines, package.json, the bin, and the docs', () => {
    const lock = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain("node: '>=26.4.0'");
    const pkg = JSON.parse(readFileSync(path.join(root, 'packages/agent-cli/ts/package.json'), 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${REQUIRED_NODE}`);
    expect(REQUIRED_NODE).toBe('26.4.0');
    const bin = readFileSync(path.join(root, 'packages/agent-cli/ts/src/bin.ts'), 'utf8');
    expect(bin).toContain("from './node-version.js'");
    expect(bin).toContain("import('./cli.js')");
    expect(bin).not.toContain("from './cli.js'");
    for (const file of ['README.md', 'docs/index.md', 'docs/getting-started.md']) {
      expect(readFileSync(path.join(root, file), 'utf8')).toContain('26.4.0');
    }
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('node-%E2%89%A526.4.0');
  });
});
