import type { AgentClient } from '@steerable/agent-client';
import { maskApiKey, resolveApiKey, sanitizeLlmProvider } from '@steerable/agent-shell/storage/llm-settings';

export interface CommandIO {
  positionals: string[];
  help: boolean;
  json: boolean;
  format?: string;
  /** `children --session`: which session's children to read. */
  session?: string;
  /** `children answer --child`: the child's lineage id (e.g. `0.2`). */
  child?: string;
  /** `children list --active`: only children that can still run. */
  active?: boolean;
  /** `children answer --wait`: block until the child reaches a terminal state. */
  wait?: boolean;
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

export async function childrenCommand(
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
  if (sub === 'list') return open((client) => listChildren(client, io, stdout, stderr));
  if (sub === 'answer') {
    if (!io.child) {
      stderr.write(`missing --child\n${help}\n`);
      return 2;
    }
    return open((client) => answerChild(client, io, stdout, stderr));
  }
  stderr.write(`${sub ? `unknown children command: ${sub}\n` : ''}${help}\n`);
  return 2;
}

/** One child as `GET /api/v2/children` reports it. */
interface ChildAgentRow {
  recordId: string;
  childId: string;
  depth: number;
  profile: string | null;
  engine: string;
  status: string;
  resumable: boolean;
  live: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  usageKnown: boolean;
  createdAt: string;
  answerPreview?: string;
}

async function fetchChildren(
  client: AgentClient,
  io: CommandIO,
  stderr: NodeJS.WritableStream,
): Promise<ChildAgentRow[] | null> {
  const params = new URLSearchParams();
  if (io.session) params.set('session', io.session);
  if (io.active) params.set('active', '1');
  // The list view shows a one-line answer so a user can tell two children
  // apart without opening each process log.
  params.set('previewChars', '80');
  const query = params.toString();
  const listed = await client.request(
    'GET',
    `/api/v2/children${query ? `?${query}` : ''}`,
    undefined,
  );
  if (listed.status !== 200) {
    fail(stderr, 'children list', listed.status);
    return null;
  }
  const rows = (listed.data as { children?: ChildAgentRow[] }).children ?? [];
  return rows;
}

/**
 * `children list`: what this session spawned, and what state each is in.
 *
 * Reads the durable index rather than the live pool, so it keeps answering
 * after a restart — an unfinished child shows as `interrupted` and stays
 * resumable instead of vanishing with the turn that created it.
 */
async function listChildren(
  client: AgentClient,
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const rows = await fetchChildren(client, io, stderr);
  if (!rows) return 1;
  if (io.json) {
    stdout.write(`${JSON.stringify(rows)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    stdout.write(`${io.session ?? 'this session'} has no sub-agents\n`);
    return 0;
  }
  const header = ['ID', 'PROFILE', 'DEPTH', 'STATUS', 'TOKENS'];
  const body = rows.map((row) => [
    row.childId,
    row.profile ?? '-',
    String(row.depth),
    row.resumable ? `${row.status} (resumable)` : row.status,
    row.usageKnown ? String((row.promptTokens ?? 0) + (row.completionTokens ?? 0)) : '-',
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index]!.length)),
  );
  const format = (line: string[]) =>
    line.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();
  stdout.write(`${format(header)}\n`);
  for (const line of body) stdout.write(`${format(line)}\n`);
  return 0;
}

/**
 * `children answer`: one child's final text.
 *
 * With `--wait`, polls until the child leaves a running state; without it, a
 * child that has not finished yet exits 6, matching every other "target busy"
 * path in this CLI rather than blocking a script by surprise.
 */
async function answerChild(
  client: AgentClient,
  io: CommandIO,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const rows = await fetchChildren(client, io, stderr);
    if (!rows) return 1;
    const row = rows.find((candidate) => candidate.childId === io.child);
    if (!row) {
      stderr.write(`no child ${io.child} in this session\n`);
      return 2;
    }
    const running = row.live || row.status === 'running';
    if (!running) {
      if (io.json) {
        stdout.write(`${JSON.stringify(row)}\n`);
      } else {
        stdout.write(`${row.childId} · ${row.profile ?? '-'} · ${row.status}\n\n`);
        stdout.write(`${row.answerPreview ?? '(no answer recorded)'}\n`);
      }
      return 0;
    }
    if (!io.wait) {
      stderr.write(
        `${io.child} is still running. Use --wait to block, or children list for progress.\n`,
      );
      return 6;
    }
    if (Date.now() > deadline) {
      stderr.write(`${io.child} did not finish within 10 minutes\n`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

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
      if (key === 'apiKey') {
        stdout.write(`${apiKeyLine(current)}\n`);
        return 0;
      }
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

/**
 * One line for `config get apiKey`: the masked key and where it came from.
 *
 * Reading a key from the environment never writes it to storage, so this line
 * is how a user confirms a shell export took effect.
 *
 * @param settings Current settings as returned by the backend.
 * @returns Text such as `apiKey=sk-…a1b2 (env:DEEPSEEK_API_KEY)`.
 */
function apiKeyLine(settings: Record<string, unknown>): string {
  const resolved = resolveApiKey(
    {
      provider: sanitizeLlmProvider(settings.provider),
      ...(typeof settings.vendorId === 'string' ? { vendorId: settings.vendorId } : {}),
      ...(typeof settings.baseUrl === 'string' ? { baseUrl: settings.baseUrl } : {}),
      ...(typeof settings.apiKey === 'string' ? { apiKey: settings.apiKey } : {}),
    },
    process.env,
  );
  if (resolved.key) {
    const source = resolved.source.kind === 'env' ? `env:${resolved.source.name}` : 'config';
    return `apiKey=${maskApiKey(resolved.key)} (${source})`;
  }
  if (resolved.source.kind === 'not_required') return 'apiKey= (not_required) 本地提供方不需要 key';
  const hint = resolved.envNames[0] ? `设置 ${resolved.envNames[0]} 或运行 steerable-cli login` : '运行 steerable-cli login';
  return `apiKey= (missing) ${hint}`;
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
