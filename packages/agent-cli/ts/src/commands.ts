import type { AgentClient } from '@steerable/agent-client';

export interface CommandIO {
  positionals: string[];
  help: boolean;
  json: boolean;
  format?: string;
}

type OpenClient = (body: (client: AgentClient) => Promise<number>) => Promise<number>;

const CONFIG_KEYS = [
  'provider',
  'vendorId',
  'model',
  'baseUrl',
  'apiKey',
  'temperature',
  'systemPrompt',
  'maxTotalTokens',
  'execTimeoutSeconds',
] as const;

const NUMBER_KEYS = new Set<string>(['temperature', 'maxTotalTokens', 'execTimeoutSeconds']);

export async function chatCommand(
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  open: OpenClient,
  help: string,
): Promise<number> {
  const sub = io.positionals[1];
  if (io.help && !sub) {
    stdout.write(`${help}\n`);
    return 0;
  }
  if (sub === 'list') return open((client) => listChats(client, io, stdout, stderr));
  if (sub === 'show' || sub === 'rm' || sub === 'export') {
    const id = io.positionals[2];
    if (!id) {
      stderr.write(`missing chat id\n${help}\n`);
      return 2;
    }
    if (sub === 'show') return open((client) => showChat(client, id, io, stdout, stderr));
    if (sub === 'rm') return open((client) => removeChat(client, id, stdout, stderr));
    const format = io.format ?? 'md';
    if (format !== 'md' && format !== 'json') {
      stderr.write(`unknown --format value\n${help}\n`);
      return 2;
    }
    return open((client) => exportChat(client, id, io, stdout, stderr, help));
  }
  stderr.write(`${sub ? `unknown chat command: ${sub}\n` : ''}${help}\n`);
  return 2;
}

export async function skillsCommand(
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  open: OpenClient,
  help: string,
): Promise<number> {
  if (io.help || io.positionals[1] === undefined) {
    stdout.write(`${help}\n`);
    return io.help ? 0 : 2;
  }
  if (io.positionals[1] !== 'list') {
    stderr.write(`unknown skills command: ${io.positionals[1]}\n${help}\n`);
    return 2;
  }
  return open(async (client) => {
    const listed = await client.request('GET', '/api/v2/chat-agents/skills', undefined);
    if (listed.status !== 200) return fail(stderr, 'skills list', listed.status);
    const skills = (listed.data as { skills?: SkillRow[] }).skills ?? [];
    if (io.json) {
      stdout.write(`${JSON.stringify(skills)}\n`);
      return 0;
    }
    if (skills.length === 0) {
      stdout.write('no skills\n');
      return 0;
    }
    for (const skill of skills) {
      stdout.write(`${skill.name}\t${skill.origin ?? ''}\t${skill.description ?? ''}\n`);
    }
    return 0;
  });
}

export async function mcpCommand(
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  open: OpenClient,
  help: string,
): Promise<number> {
  const sub = io.positionals[1];
  if (io.help && !sub) {
    stdout.write(`${help}\n`);
    return 0;
  }
  if (sub === 'list') {
    return open(async (client) => {
      const listed = await client.request('GET', '/api/v2/mcp/servers', undefined);
      if (listed.status !== 200) return fail(stderr, 'mcp list', listed.status);
      const servers = (listed.data as { servers?: McpRow[] }).servers ?? [];
      if (io.json) {
        stdout.write(`${JSON.stringify(servers)}\n`);
        return 0;
      }
      if (servers.length === 0) {
        stdout.write('no mcp servers\n');
        return 0;
      }
      for (const server of servers) {
        const command = [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
        stdout.write(`${server.name}\t${command}\n`);
      }
      return 0;
    });
  }
  if (sub === 'add') {
    const name = io.positionals[2];
    const command = io.positionals[3];
    const args = io.positionals.slice(4);
    if (!name || !command) {
      stderr.write(`missing mcp command\n${help}\n`);
      return 2;
    }
    return open(async (client) => {
      const created = await client.request('POST', '/api/v2/mcp/servers', {
        name,
        transport: 'stdio',
        command,
        args,
      });
      if (created.status !== 200) return fail(stderr, 'mcp add', created.status);
      stdout.write(`added ${name}\n`);
      return 0;
    });
  }
  if (sub === 'rm') {
    const name = io.positionals[2];
    if (!name) {
      stderr.write(`missing mcp name\n${help}\n`);
      return 2;
    }
    return open(async (client) => {
      const listed = await client.request('GET', '/api/v2/mcp/servers', undefined);
      if (listed.status !== 200) return fail(stderr, 'mcp list', listed.status);
      const servers = (listed.data as { servers?: McpRow[] }).servers ?? [];
      const match = servers.find((server) => server.name === name);
      if (!match?.id) {
        stderr.write(`mcp server not found: ${name}\n`);
        return 1;
      }
      const removed = await client.request(
        'DELETE',
        `/api/v2/mcp/servers/${encodeURIComponent(match.id)}`,
        undefined,
      );
      if (removed.status !== 200) return fail(stderr, 'mcp rm', removed.status);
      stdout.write(`removed ${name}\n`);
      return 0;
    });
  }
  stderr.write(`${sub ? `unknown mcp command: ${sub}\n` : ''}${help}\n`);
  return 2;
}

export async function configCommand(
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  open: OpenClient,
  help: string,
): Promise<number> {
  const sub = io.positionals[1];
  if (io.help && !sub) {
    stdout.write(`${help}\n`);
    return 0;
  }
  const key = io.positionals[2];
  if ((sub !== 'get' && sub !== 'set') || !key || !isConfigKey(key)) {
    stderr.write(`${help}\n`);
    return 2;
  }
  if (sub === 'get') {
    return open(async (client) => {
      const current = await readConfig(client, stderr);
      if (!current) return 1;
      const value = current[key];
      stdout.write(`${key}=${value === undefined ? '' : String(value)}\n`);
      return 0;
    });
  }
  const raw = io.positionals[3];
  if (raw === undefined) {
    stderr.write(`missing config value\n${help}\n`);
    return 2;
  }
  const value = coerceConfigValue(key, raw);
  if (value === undefined) {
    stderr.write(`invalid config value\n${help}\n`);
    return 2;
  }
  return open(async (client) => {
    const current = await readConfig(client, stderr);
    if (!current) return 1;
    const saved = await client.request('POST', '/api/v2/local-settings/llm', { ...current, [key]: value });
    if (saved.status !== 200) return fail(stderr, 'config set', saved.status);
    stdout.write(`${key}=${String(value)}\n`);
    return 0;
  });
}

async function listChats(
  client: AgentClient,
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const listed = await client.request('GET', '/api/v2/chats', undefined);
  if (listed.status !== 200) return fail(stderr, 'chat list', listed.status);
  const chats = (listed.data as { chats?: Array<{ id: string; title?: string }> }).chats ?? [];
  if (io.json) {
    stdout.write(`${JSON.stringify(chats)}\n`);
    return 0;
  }
  if (chats.length === 0) {
    stdout.write('no chats\n');
    return 0;
  }
  for (const chat of chats) stdout.write(`${chat.id}\t${chat.title ?? ''}\n`);
  return 0;
}

async function showChat(
  client: AgentClient,
  id: string,
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const loaded = await loadChat(client, id, stderr);
  if (!loaded) return 1;
  if (io.json) {
    stdout.write(`${JSON.stringify(loaded)}\n`);
    return 0;
  }
  stdout.write(`${loaded.chat.id}\t${loaded.chat.title ?? ''}\n`);
  for (const message of loaded.messages) {
    stdout.write(`${message.role}\t${oneLine(message.content)}\n`);
  }
  return 0;
}

async function removeChat(
  client: AgentClient,
  id: string,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const removed = await client.request('DELETE', `/api/v2/chats/${encodeURIComponent(id)}`, undefined);
  if (removed.status === 409) {
    stderr.write(`${messageOf(removed.data, '该会话正在另一个进程中运行')}\n`);
    return 6;
  }
  if (removed.status === 404) {
    stderr.write('chat not found\n');
    return 1;
  }
  if (removed.status !== 200) return fail(stderr, 'chat rm', removed.status);
  stdout.write(`deleted ${id}\n`);
  return 0;
}

async function exportChat(
  client: AgentClient,
  id: string,
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  help: string,
): Promise<number> {
  const format = io.format ?? 'md';
  if (format !== 'md' && format !== 'json') {
    stderr.write(`unknown --format value\n${help}\n`);
    return 2;
  }
  const loaded = await loadChat(client, id, stderr);
  if (!loaded) return 1;
  if (format === 'json') {
    stdout.write(`${JSON.stringify(loaded, null, 2)}\n`);
    return 0;
  }
  const title = loaded.chat.title || loaded.chat.id;
  const parts = [`# ${title}`, ''];
  for (const message of loaded.messages) {
    parts.push(`## ${message.role}`, '', message.content, '');
  }
  stdout.write(`${parts.join('\n').replace(/\n$/, '')}\n`);
  return 0;
}

async function loadChat(
  client: AgentClient,
  id: string,
  stderr: NodeJS.WritableStream,
): Promise<{ chat: ChatRow; messages: MessageRow[] } | null> {
  const encoded = encodeURIComponent(id);
  const chat = await client.request('GET', `/api/v2/chats/${encoded}`, undefined);
  if (chat.status === 404) {
    stderr.write('chat not found\n');
    return null;
  }
  if (chat.status !== 200) {
    fail(stderr, 'chat', chat.status);
    return null;
  }
  const messages = await client.request('GET', `/api/v2/chats/${encoded}/messages`, undefined);
  if (messages.status !== 200) {
    fail(stderr, 'chat messages', messages.status);
    return null;
  }
  return {
    chat: chat.data as ChatRow,
    messages: (messages.data as { messages?: MessageRow[] }).messages ?? [],
  };
}

async function readConfig(
  client: AgentClient,
  stderr: NodeJS.WritableStream,
): Promise<Record<string, unknown> | null> {
  const current = await client.request('GET', '/api/v2/local-settings/llm', undefined);
  if (current.status !== 200 || !current.data || typeof current.data !== 'object') {
    fail(stderr, 'config get', current.status);
    return null;
  }
  return current.data as Record<string, unknown>;
}

function isConfigKey(key: string): key is (typeof CONFIG_KEYS)[number] {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function coerceConfigValue(key: string, raw: string): string | number | undefined {
  if (!NUMBER_KEYS.has(key)) return raw;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  if (key === 'execTimeoutSeconds' && value <= 0) return undefined;
  return value;
}

function fail(stderr: NodeJS.WritableStream, label: string, status: number): number {
  stderr.write(`${label} failed (${status})\n`);
  return 1;
}

function messageOf(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'message' in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

function oneLine(content: string): string {
  return content.replace(/[\r\n\t]+/g, ' ');
}

interface ChatRow {
  id: string;
  title?: string;
}

interface MessageRow {
  role: string;
  content: string;
}

interface SkillRow {
  name: string;
  origin?: string;
  description?: string;
}

interface McpRow {
  id?: string;
  name: string;
  command?: string;
  args?: string[];
}
