import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireChatWriteLock } from '@steerable/agent-shell/storage/process-locks';
import { createLocalClient, listBusyChatIds, type AgentClient } from '../src/client.js';

const dirs: string[] = [];
const clients: AgentClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function openClient(): Promise<{ dir: string; client: AgentClient }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-'));
  dirs.push(dir);
  const client = await createLocalClient({ dataDir: dir, startSidecar: false });
  clients.push(client);
  return { dir, client };
}

describe('createLocalClient', () => {
  it('creates a chat and lists it', async () => {
    const { client } = await openClient();
    const created = await client.request('POST', '/api/v2/chats/new', {});
    expect(created.status).toBe(200);
    const chatId = (created.data as { chatId: string }).chatId;
    const listed = await client.request('GET', '/api/v2/chats', undefined);
    const chats = (listed.data as { chats: Array<{ id: string }> }).chats;
    expect(chats.map((chat) => chat.id)).toContain(chatId);
  });

  it('reports chat_busy when another holder has the chat lock', async () => {
    const { dir, client } = await openClient();
    const created = await client.request('POST', '/api/v2/chats/new', {});
    const chatId = (created.data as { chatId: string }).chatId;
    const lease = acquireChatWriteLock(dir, chatId);
    try {
      const events = [];
      for await (const event of client.stream(
        `/api/v2/chats/${chatId}/send`,
        { message: 'hello' },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      expect(client.lastStatus).toBe(409);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'chat_busy' }));
      expect(listBusyChatIds(dir)).toEqual([chatId]);
    } finally {
      lease.release();
    }
    expect(listBusyChatIds(dir)).toEqual([]);
  });
});
