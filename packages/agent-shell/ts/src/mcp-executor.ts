import { execFileSync } from 'child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPReconnectionOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// In ESM there is no `__filename` global; use the module URL to seed a local
// CommonJS require() so we can `require.resolve()` MCP server packages that
// ship as CJS (npx -y <pkg> targets, e.g. apple-notes-mcp).
const localRequire = createRequire(import.meta.url);

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 单次 MCP 请求（initialize 握手 / listTools / callTool）的超时。
 * SDK 默认 60s 太短：`npx -y <pkg>` 首次运行要从 npm registry 下载包，
 * 国内网络或走代理时 60s 内完不成握手，报 "MCP error -32001: Request
 * timed out"（2026-07-31 用户实测遇到）。放宽到 3 分钟覆盖冷启动下载。
 */
const MCP_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
export const MAX_MCP_SERVER_TOOLS = 64;
const CONNECT_RETRY_DELAYS_MS = [0, 250, 1_000] as const;
const DEFAULT_RECONNECTION: StreamableHTTPReconnectionOptions = {
  initialReconnectionDelay: 500,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 2,
  maxRetries: 10,
};

/**
 * 给超时类错误追加可操作的排查提示。独立成纯函数便于单测。
 */
export function withMcpTroubleshootHint(message: string): string {
  if (!/timed?\s*out|超时|-32001/i.test(message)) return message;
  return (
    `${message}。若为首次启动该服务：npx/uvx 需要现场下载包，可能较慢——` +
    `可先在终端手动执行一次相同命令预热缓存，或为 npm 配置国内镜像源 ` +
    `(npm config set registry https://registry.npmmirror.com)，之后重试"测试连接"。`
  );
}

const COMMAND_HINTS: Record<string, string> = {
  npx: '请安装 Node.js (https://nodejs.org)',
  node: '请安装 Node.js (https://nodejs.org)',
  uvx: '请安装 uv (https://docs.astral.sh/uv)',
  uv: '请安装 uv (https://docs.astral.sh/uv)',
  python: '请安装 Python (https://python.org)',
  python3: '请安装 Python (https://python.org)',
};

function commandExists(cmd: string): boolean {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(which, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tryResolveBundled(config: StdioMcpServerConfig): StdioMcpServerConfig | null {
  if (config.command !== 'npx') return null;
  const args = config.args ?? [];
  const yIdx = args.indexOf('-y');
  if (yIdx === -1 || yIdx + 1 >= args.length) return null;
  const pkgName = args[yIdx + 1];
  const extraArgs = args.slice(yIdx + 2);

  try {
    const entryPath = localRequire.resolve(pkgName);
    return {
      transport: 'stdio',
      command: process.execPath,
      args: [entryPath, ...extraArgs],
      env: { ...config.env },
      cwd: config.cwd,
    };
  } catch {
    return null;
  }
}

export interface StdioMcpServerConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface StreamableHttpMcpServerConfig {
  transport: 'streamable-http';
  url: string;
  /** Non-sensitive literal headers. Authorization must come from an env reference. */
  headers?: Record<string, string>;
  /** Header name -> environment variable name. */
  headersFromEnv?: Record<string, string>;
  bearerTokenEnvVar?: string;
  reconnect?: Partial<StreamableHTTPReconnectionOptions>;
}

export type McpServerConfig = StdioMcpServerConfig | StreamableHttpMcpServerConfig;
export type LegacyMcpServerConfig = Omit<StdioMcpServerConfig, 'transport'>;

interface ToolSchema {
  name: string;
  inputSchema?: { properties?: Record<string, { type?: string }> };
}

interface PoolEntry {
  client: Client;
  transport: Transport;
  httpTransport?: StreamableHTTPClientTransport;
  lastUsed: number;
  key: string;
  toolSchemas: Map<string, ToolSchema>;
  /**
   * Count of calls currently in flight on this connection. `evictIdle()`
   * skips any entry with `inflight > 0` — without this, `lastUsed` was
   * stamped when a call *started*, so a single tool call running longer
   * than `IDLE_TIMEOUT_MS` (e.g. a slow MCP server or a long-running task)
   * looked "idle" to the 60s sweep and got `closeEntry()`'d out from under
   * the in-flight request, killing it with a connection-closed error.
   */
  inflight: number;
  listeners: Set<(tools: ListedTool[]) => void>;
  unavailableListeners: Set<(error: string) => void>;
  syncChain: Promise<void>;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export function resolveHttpHeaders(
  config: StreamableHttpMcpServerConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const headers = { ...(config.headers ?? {}) };
  for (const [header, variable] of Object.entries(config.headersFromEnv ?? {})) {
    const value = env[variable];
    if (!value) throw new Error(`MCP header environment variable "${variable}" is not set`);
    headers[header] = value;
  }
  if (config.bearerTokenEnvVar) {
    const token = env[config.bearerTokenEnvVar];
    if (!token) {
      throw new Error(
        `MCP bearer token environment variable "${config.bearerTokenEnvVar}" is not set`,
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function mcpConfigKey(
  rawConfig: McpServerConfig | LegacyMcpServerConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  const config = normalizeExecutorConfig(rawConfig);
  const material = config.transport === 'stdio'
    ? {
        transport: config.transport,
        command: config.command,
        args: config.args ?? [],
        env: config.env ?? {},
        cwd: config.cwd ?? '',
      }
    : {
        transport: config.transport,
        url: config.url,
        headers: resolveHttpHeaders(config, env),
        reconnect: config.reconnect ?? {},
      };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function normalizeExecutorConfig(
  config: McpServerConfig | LegacyMcpServerConfig,
): McpServerConfig {
  return 'transport' in config ? config : { ...config, transport: 'stdio' };
}

/**
 * Pure eviction predicate, split out so it's unit-testable without spinning
 * up a real MCP child process (`McpExecutor` isn't otherwise exported —
 * everything else about it talks to a real stdio transport).
 */
export function shouldEvictMcpConnection(
  entry: { lastUsed: number; inflight: number },
  now: number,
  idleTimeoutMs: number,
): boolean {
  if (entry.inflight > 0) return false;
  return now - entry.lastUsed > idleTimeoutMs;
}

function startupError(config: McpServerConfig, message: string): string {
  const prefix =
    config.transport === 'stdio' ? 'MCP server startup failed' : 'MCP HTTP connection failed';
  return config.transport === 'stdio'
    ? withMcpTroubleshootHint(`${prefix}: ${message}`)
    : `${prefix}: ${message}`;
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid MCP HTTP URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP HTTP URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('MCP HTTP URL must not contain credentials');
  }
  return url;
}

function sameOriginFetch(origin: URL): FetchLike {
  return async (input, init) => {
    let current = new URL(String(input), origin);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetch(current, { ...init, redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      const next = new URL(location, current);
      if (next.origin !== origin.origin) {
        throw new Error(`MCP HTTP redirect crossed origin: ${origin.origin} -> ${next.origin}`);
      }
      current = next;
    }
    throw new Error('MCP HTTP redirect limit exceeded');
  };
}

async function connectWithRetry(
  create: () => { client: Client; transport: Transport },
): Promise<{ client: Client; transport: Transport }> {
  let lastError: unknown;
  for (const delayMs of CONNECT_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const generation = create();
    try {
      await generation.client.connect(generation.transport, {
        timeout: MCP_REQUEST_TIMEOUT_MS,
      });
      return generation;
    } catch (error) {
      lastError = error;
      try {
        await generation.transport.close();
      } catch {
        // Failed negotiation can leave an already-closed transport.
      }
      if (!isRetryableConnectError(error)) break;
    }
  }
  throw lastError;
}

function isRetryableConnectError(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return error.code !== undefined && [408, 429, 500, 502, 503, 504].includes(error.code);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthorized|forbidden|invalid|protocol|parse|deserialize/i.test(message)) {
    return false;
  }
  return /408|429|500|502|503|504|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|closed/i.test(message);
}

function coerceArgs(args: Record<string, unknown>, schema: ToolSchema | undefined): Record<string, unknown> {
  if (!schema?.inputSchema?.properties) return args;
  const props = schema.inputSchema.properties;
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const expected = props[key]?.type;
    if (expected === 'string' && typeof value !== 'string') {
      out[key] = String(value);
    } else if (expected === 'integer' && typeof value === 'string') {
      const n = parseInt(value, 10);
      if (!isNaN(n)) out[key] = n;
    } else if (expected === 'number' && typeof value === 'string') {
      const n = parseFloat(value);
      if (!isNaN(n)) out[key] = n;
    }
  }
  return out;
}

export interface McpExecutorLike {
  executeTool(
    config: McpServerConfig | LegacyMcpServerConfig,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<{ success: boolean; text?: string; error?: string }>;
  listTools(
    config: McpServerConfig | LegacyMcpServerConfig,
    onChanged?: (tools: ListedTool[]) => void,
    onUnavailable?: (error: string) => void,
  ): Promise<{ success: boolean; tools?: ListedTool[]; error?: string }>;
}

export class McpExecutor implements McpExecutorLike {
  private pool = new Map<string, PoolEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictIdle(), 60_000);
  }

  async executeTool(
    rawConfig: McpServerConfig | LegacyMcpServerConfig,
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<{ success: boolean; text?: string; error?: string }> {
    const config = normalizeExecutorConfig(rawConfig);
    let entry: PoolEntry;
    try {
      entry = await this.getOrCreate(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: startupError(config, msg),
      };
    }

    entry.inflight += 1;
    try {
      const coerced = coerceArgs(toolArgs, entry.toolSchemas.get(toolName));
      const result = await entry.client.callTool({ name: toolName, arguments: coerced }, undefined, {
        timeout: MCP_REQUEST_TIMEOUT_MS,
      });
      const textParts: string[] = [];
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (typeof item === 'object' && item !== null && 'text' in item) {
            textParts.push(String((item as { text: unknown }).text));
          }
        }
      }
      const text = textParts.join('\n') || JSON.stringify(result.content);
      if (result.isError) return { success: false, error: text };
      return { success: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const key = mcpConfigKey(config);
      await this.closeEntry(key);
      return { success: false, error: withMcpTroubleshootHint(`Tool execution failed: ${msg}`) };
    } finally {
      entry.inflight -= 1;
      entry.lastUsed = Date.now();
    }
  }

  async listTools(
    rawConfig: McpServerConfig | LegacyMcpServerConfig,
    onChanged?: (tools: ListedTool[]) => void,
    onUnavailable?: (error: string) => void,
  ): Promise<{ success: boolean; tools?: ListedTool[]; error?: string }> {
    const config = normalizeExecutorConfig(rawConfig);
    let entry: PoolEntry;
    try {
      entry = await this.getOrCreate(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: startupError(config, msg) };
    }

    entry.inflight += 1;
    if (onChanged) entry.listeners.add(onChanged);
    if (onUnavailable) entry.unavailableListeners.add(onUnavailable);
    try {
      const tools = await this.refreshEntryTools(entry);
      return {
        success: true,
        tools,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const key = mcpConfigKey(config);
      await this.closeEntry(key);
      return { success: false, error: withMcpTroubleshootHint(`List tools failed: ${msg}`) };
    } finally {
      entry.inflight -= 1;
      entry.lastUsed = Date.now();
    }
  }

  private async getOrCreate(config: McpServerConfig): Promise<PoolEntry> {
    const key = mcpConfigKey(config);
    const existing = this.pool.get(key);
    if (existing) return existing;

    const { client, transport } = await connectWithRetry(() => ({
      transport: this.createTransport(config),
      client: new Client(
        { name: 'agent-shell', version: '1.0.0' },
        { capabilities: {} },
      ),
    }));
    const entry: PoolEntry = {
      client,
      transport,
      httpTransport:
        transport instanceof StreamableHTTPClientTransport ? transport : undefined,
      lastUsed: Date.now(),
      key,
      toolSchemas: new Map(),
      inflight: 0,
      listeners: new Set(),
      unavailableListeners: new Set(),
      syncChain: Promise.resolve(),
    };
    await this.refreshEntryTools(entry);
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        const tools = await this.refreshEntryTools(entry);
        for (const listener of entry.listeners) listener(tools);
      } catch {
        // Preserve the previous generation; a later notification/manual refresh can recover.
      }
    });
    this.pool.set(key, entry);
    client.onclose = () => {
      if (this.pool.get(key) !== entry) return;
      this.pool.delete(key);
      for (const listener of entry.unavailableListeners) {
        listener('MCP connection closed after reconnect attempts were exhausted');
      }
    };
    return entry;
  }

  private createTransport(config: McpServerConfig): Transport {
    if (config.transport === 'stdio') {
      const resolved = tryResolveBundled(config) ?? config;
      if (!commandExists(resolved.command)) {
        const hint =
          COMMAND_HINTS[config.command] || `请确保 ${config.command} 已安装并在 PATH 中`;
        throw new Error(`命令 "${config.command}" 不可用。${hint}`);
      }
      return new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
        env: { ...process.env, ...(resolved.env ?? {}) } as Record<string, string>,
        cwd: resolved.cwd ?? undefined,
        stderr: 'pipe',
      });
    }
    const url = parseHttpUrl(config.url);
    const headers = resolveHttpHeaders(config);
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: sameOriginFetch(url),
      reconnectionOptions: {
        ...DEFAULT_RECONNECTION,
        ...(config.reconnect ?? {}),
      },
    });
  }

  private async refreshEntryTools(entry: PoolEntry): Promise<ListedTool[]> {
    let result: ListedTool[] | undefined;
    const run = entry.syncChain.then(async () => {
      result = await this.fetchEntryTools(entry);
    });
    entry.syncChain = run.catch(() => {});
    await run;
    return result ?? [];
  }

  private async fetchEntryTools(entry: PoolEntry): Promise<ListedTool[]> {
    const tools: ListedTool[] = [];
    let cursor: string | undefined;
    do {
      const listing = await entry.client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: MCP_REQUEST_TIMEOUT_MS },
      );
      for (const tool of listing.tools) {
        tools.push({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        });
        if (tools.length > MAX_MCP_SERVER_TOOLS) {
          throw new Error(
            `MCP server advertises more than the per-server cap of ${MAX_MCP_SERVER_TOOLS} tools`,
          );
        }
      }
      cursor = listing.nextCursor;
    } while (cursor);
    const nextSchemas = new Map<string, ToolSchema>();
    for (const tool of tools) {
      nextSchemas.set(tool.name, {
        name: tool.name,
        inputSchema: tool.inputSchema as ToolSchema['inputSchema'],
      });
    }
    entry.toolSchemas = nextSchemas;
    return tools;
  }

  private async closeEntry(key: string): Promise<void> {
    const entry = this.pool.get(key);
    if (!entry) return;
    this.pool.delete(key);
    try {
      if (entry.httpTransport?.sessionId) {
        await entry.httpTransport.terminateSession();
      }
    } catch {
      // Session DELETE is advisory; transport closure still must happen.
    }
    try {
      await entry.client.close();
    } catch {
      // An already-closed transport needs no further cleanup.
    }
  }

  /** 关闭连接池中的所有连接（应用退出 / 测试收尾时调用）。 */
  async shutdownAll(): Promise<void> {
    const keys = [...this.pool.keys()];
    await Promise.all(keys.map((key) => this.closeEntry(key)));
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [key, entry] of this.pool) {
      if (shouldEvictMcpConnection(entry, now, IDLE_TIMEOUT_MS)) {
        this.closeEntry(key).catch(() => {});
      }
    }
  }
}

export const mcpExecutor = new McpExecutor();
