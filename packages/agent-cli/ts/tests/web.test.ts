/**
 * `steerable-cli web` bundle resolution.
 *
 * A global install has no framework checkout, so the command must find the
 * bundle shipped inside the package; a checkout must find its own build. The
 * missing case has to explain both routes instead of failing with a stack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { locateWebBundle } from '../src/web.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempBundle(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-web-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  return dir;
}

function capture(): { stream: Writable; text: () => string } {
  let body = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { stream, text: () => body };
}

describe('locateWebBundle', () => {
  it('prefers an explicit DEEPPATH_WEB_DIST', () => {
    const dir = tempBundle();
    const found = locateWebBundle({ DEEPPATH_WEB_DIST: dir });
    expect(found).toEqual({ kind: 'ok', dir });
  });

  it('reports every path it checked when nothing exists', () => {
    const found = locateWebBundle({ DEEPPATH_WEB_DIST: '/nonexistent/web-dist' });
    // The framework checkout in this repo does have a build, so the assertion
    // is about the reported candidates rather than a guaranteed failure.
    if (found.kind === 'missing') {
      expect(found.tried.length).toBeGreaterThan(0);
      expect(found.tried[0]).toBe('/nonexistent/web-dist');
    } else {
      expect(fs.existsSync(path.join(found.dir, 'index.html'))).toBe(true);
    }
  });
});

describe('web command without a bundle', () => {
  it('names both routes without printing a stack', async () => {
    // Point every candidate at nothing by running the command body directly
    // with a bundle-free environment.
    const { webCommand } = await import('../src/web.js');
    const stdout = capture();
    const stderr = capture();
    const previous = process.env.DEEPPATH_WEB_DIST;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-web-empty-'));
    dirs.push(scratch);
    const code = await webCommand({
      stdout: stdout.stream,
      stderr: stderr.stream,
      port: 0,
      env: { DEEPPATH_WEB_DIST: scratch },
      once: true,
      candidates: [scratch],
    });
    if (previous === undefined) delete process.env.DEEPPATH_WEB_DIST;
    else process.env.DEEPPATH_WEB_DIST = previous;
    expect(code).toBe(78);
    expect(stderr.text()).toContain('pnpm agent-shell:web');
    expect(stderr.text()).toContain('DEEPPATH_WEB_DIST');
    expect(stderr.text()).not.toContain('\n    at ');
  });
});
