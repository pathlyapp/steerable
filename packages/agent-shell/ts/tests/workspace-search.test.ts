import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { searchGlob, searchGrep } from '../src/workspace-search.js';

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'steerable-search-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('workspace search', () => {
  it('grep returns line hits and skips dependency directories', async () => {
    const root = scratch();
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'app.ts'), 'export const token = "needle";\n');
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'needle\n');

    const result = await searchGrep({ root, pattern: 'needle' });
    expect(result.success).toBe(true);
    expect(result.matches).toEqual([
      { path: 'src/app.ts', line: 1, text: 'export const token = "needle";' },
    ]);
  });

  it('glob matches a pattern that has no slash in any directory', async () => {
    const root = scratch();
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'app.ts'), '');
    writeFileSync(path.join(root, 'README.md'), '');

    const result = await searchGlob({ root, pattern: '*.ts' });
    expect(result.files).toEqual(['src/app.ts']);
  });

  it('rejects an invalid regular expression', async () => {
    const result = await searchGrep({ root: scratch(), pattern: '(' });
    expect(result.success).toBe(false);
    expect(result.needsFollowup).toBe(true);
  });

  it('rejects an empty pattern', async () => {
    expect(await searchGrep({ root: scratch(), pattern: '  ' })).toMatchObject({
      success: false,
      needsFollowup: true,
    });
    expect(await searchGlob({ root: scratch(), pattern: '' })).toMatchObject({
      success: false,
      needsFollowup: true,
    });
  });

  it('grep applies the glob and skips binary files and symlinks', async () => {
    const root = scratch();
    const outside = scratch();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'app.ts'), 'keep\n');
    writeFileSync(path.join(root, 'src', 'note.md'), 'keep\n');
    writeFileSync(path.join(root, 'src', 'blob.bin'), 'keep\0hidden\n');
    writeFileSync(path.join(outside, 'secret.txt'), 'keep\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'linked.txt'));

    const result = await searchGrep({ root, pattern: 'keep', glob: '*.ts' });
    expect(result.matches).toEqual([{ path: 'src/app.ts', line: 1, text: 'keep' }]);
  });

  it('stops after the match cap and marks the result truncated', async () => {
    const root = scratch();
    const lines = Array.from({ length: 81 }, () => 'hit').join('\n');
    writeFileSync(path.join(root, 'many.txt'), `${lines}\n`);
    const result = await searchGrep({ root, pattern: 'hit' });
    expect(result.matches).toHaveLength(80);
    expect(result.truncated).toBe(true);
  });
});
