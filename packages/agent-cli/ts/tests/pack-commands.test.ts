import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { AgentClient } from '@steerable/agent-client';

import { createCli } from '../src/cli.js';

function memoryStream(): { stream: Writable; text: () => string } {
  let body = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { stream, text: () => body };
}

describe('pack commands', () => {
  it('lists and runs a command passed by the product', async () => {
    const stdout = memoryStream();
    const stderr = memoryStream();
    const help = await createCli({
      argv: ['--help'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      commands: [{ name: 'cards', summary: 'list cards', run: () => 0 }],
    });
    expect(help).toBe(0);
    expect(stdout.text()).toContain('<product> cards    list cards');

    const ran: string[] = [];
    const out = memoryStream();
    const code = await createCli({
      argv: ['cards', 'well-1'],
      stdout: out.stream,
      stderr: memoryStream().stream,
      stdinIsTTY: true,
      commands: [{
        name: 'cards',
        summary: 'list cards',
        run: async (args, io) => {
          ran.push(args.join(' '));
          const response = await io.request('POST', '/host/sample/list-cards', { search: args[0] });
          io.write(`${response.status}\n`);
          return 0;
        },
      }],
      createClient: async () => ({
        request: async () => ({ status: 200, data: [] }),
        stream: async function* () {},
        events: async function* () {},
        decideApproval: async () => undefined,
        answerAsk: async () => undefined,
        close: async () => undefined,
      }) satisfies AgentClient,
    });
    expect(code).toBe(0);
    expect(ran).toEqual(['well-1']);
    expect(out.text()).toBe('200\n');
  });

  it('prints a pack command summary without starting the host', async () => {
    let started = false;
    const stdout = memoryStream();
    const code = await createCli({
      argv: ['ppt', '--help'],
      stdout: stdout.stream,
      stderr: memoryStream().stream,
      commands: [{
        name: 'ppt',
        summary: 'list slide previews',
        run: () => {
          started = true;
          return 0;
        },
      }],
      createClient: async () => {
        started = true;
        throw new Error('host should stay down');
      },
    });
    expect(code).toBe(0);
    expect(started).toBe(false);
    expect(stdout.text()).toContain('list slide previews');
  });

  it('rejects a pack command that takes a built-in name', async () => {
    const stderr = memoryStream();
    const code = await createCli({
      argv: ['doctor'],
      stdout: memoryStream().stream,
      stderr: stderr.stream,
      commands: [{ name: 'run', summary: 'nope', run: () => 0 }],
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain('reserved');
  });
});
