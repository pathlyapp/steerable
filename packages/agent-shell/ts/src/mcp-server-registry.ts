/**
 * MCP 外部服务注册表。
 *
 * 用户在「设置 → MCP 服务」里导入/登记的外部 MCP server（stdio 型），
 * 持久化在 userData/agent-mcp-servers.json。已启用服务的工具会经
 * ToolRouter 以 `mcp__<serverKey>__<toolName>` 一等工具身份暴露给模型。
 *
 * 存储通过 {@link McpServerKvStore} 接口注入：宿主用 json-store 实现，
 * 单测用内存实现。
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_MCP_SERVER_TOOLS,
  mcpExecutor,
  type McpExecutorLike,
  type McpServerConfig,
} from './mcp-executor.js';

interface McpServerCommon {
  id: string;
  /** 用户可见名称，也用于生成工具前缀（如 "filesystem"）。 */
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StdioMcpServerEntry extends McpServerCommon {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface StreamableHttpMcpServerEntry extends McpServerCommon {
  transport: 'streamable-http';
  url: string;
  headers: Record<string, string>;
  headersFromEnv: Record<string, string>;
  bearerTokenEnvVar?: string;
  reconnect?: {
    initialReconnectionDelay?: number;
    maxReconnectionDelay?: number;
    reconnectionDelayGrowFactor?: number;
    maxRetries?: number;
  };
}

export type McpServerEntry = StdioMcpServerEntry | StreamableHttpMcpServerEntry;

interface CreateMcpServerCommon {
  name: string;
  enabled?: boolean;
}

export interface CreateStdioMcpServerInput extends CreateMcpServerCommon {
  /** Omitted remains compatible with existing callers and stored product configs. */
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface CreateStreamableHttpMcpServerInput extends CreateMcpServerCommon {
  transport: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
  headersFromEnv?: Record<string, string>;
  bearerTokenEnvVar?: string;
  reconnect?: StreamableHttpMcpServerEntry['reconnect'];
  command?: never;
}

export type CreateMcpServerInput =
  | CreateStdioMcpServerInput
  | CreateStreamableHttpMcpServerInput;

export interface UpdateMcpServerInput {
  name?: string;
  transport?: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  headersFromEnv?: Record<string, string>;
  bearerTokenEnvVar?: string;
  reconnect?: StreamableHttpMcpServerEntry['reconnect'];
  enabled?: boolean;
}

/** 最小 KV 存储接口，避免本模块直接依赖具体存储实现。 */
export interface McpServerKvStore {
  get(key: 'mcpServers'): McpServerEntry[] | undefined;
  set(key: 'mcpServers', value: McpServerEntry[]): void;
}

export interface CachedToolList {
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>;
  fetchedAt: string;
  error: string | null;
}

export interface ImportResult {
  added: McpServerEntry[];
  /** 因重名或缺少 command 被跳过的服务名。 */
  skipped: string[];
}

/**
 * 一个可调用 MCP 工具的扁平视图（跨服务），供 "/" 选择器与消息触发解析用。
 * `token` 即模型侧的一等工具名 `mcp__<serverKey>__<toolName>`（命名规则与
 * tool-router.ts 的动态工具保持一致）。
 */
export interface McpToolEntry {
  token: string;
  toolName: string;
  serverKey: string;
  serverName: string;
  description: string;
  serverId: string;
}

const STORE_KEY = 'mcpServers';

/** 工具名只允许 [a-z0-9-]；中文名会被剥光，退化为 srv-<id前6位>。 */
export function sanitizeServerKey(name: string, id: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || `srv-${id.slice(0, 6)}`;
}

type TransportFields =
  | Omit<StdioMcpServerEntry, keyof McpServerCommon>
  | Omit<StreamableHttpMcpServerEntry, keyof McpServerCommon>;

function normalizeStoredEntry(entry: McpServerEntry): McpServerEntry {
  if ('transport' in entry) return entry;
  const legacy = entry as unknown as Omit<StdioMcpServerEntry, 'transport'>;
  return { ...legacy, transport: 'stdio' };
}

function normalizeTransportInput(input: CreateMcpServerInput): TransportFields {
  if (input.transport === 'streamable-http') {
    const raw = input as unknown as Record<string, unknown>;
    if (typeof raw.command === 'string' && raw.command.trim()) {
      throw new Error('Streamable HTTP 配置不能包含 command');
    }
    const url = parseMcpHttpUrl(input.url);
    const headers = { ...(input.headers ?? {}) };
    if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
      throw new Error('Authorization 不允许明文保存；请使用 bearerTokenEnvVar 或 headersFromEnv');
    }
    const bearerTokenEnvVar = input.bearerTokenEnvVar?.trim() || undefined;
    return {
      transport: 'streamable-http',
      url,
      headers,
      headersFromEnv: { ...(input.headersFromEnv ?? {}) },
      bearerTokenEnvVar,
      reconnect: input.reconnect ? { ...input.reconnect } : undefined,
    };
  }
  if ('url' in input && typeof input.url === 'string' && input.url.trim()) {
    throw new Error('stdio 配置不能包含 url');
  }
  const command = input.command.trim();
  if (!command) throw new Error('启动命令不能为空');
  return {
    transport: 'stdio',
    command,
    args: (input.args ?? []).map(String),
    env: { ...(input.env ?? {}) },
    cwd: input.cwd?.trim() || undefined,
  };
}

function parseMcpHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('MCP HTTP URL 无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP HTTP URL 必须使用 http 或 https');
  }
  if (url.username || url.password) {
    throw new Error('MCP HTTP URL 不能包含凭据');
  }
  return url.toString();
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      String(item),
    ]),
  );
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class McpServerRegistry {
  /** serverId → 最近一次 listTools 的结果（内存缓存，重启后由后台刷新重建）。 */
  private readonly toolCache = new Map<string, CachedToolList>();

  constructor(
    private readonly store: McpServerKvStore,
    private readonly executor: McpExecutorLike = mcpExecutor,
  ) {}

  list(): McpServerEntry[] {
    const stored = this.store.get(STORE_KEY) ?? [];
    const migrated = stored.map(normalizeStoredEntry);
    if (migrated.some((entry, index) => entry !== stored[index])) {
      this.store.set(STORE_KEY, migrated);
    }
    return migrated;
  }

  get(idOrName: string): McpServerEntry | null {
    const needle = idOrName.trim().toLowerCase();
    return (
      this.list().find(
        (s) => s.id === idOrName || s.name.toLowerCase() === needle,
      ) ?? null
    );
  }

  /** 产品预置 MCP：缺省不引入；已有同名服务不覆盖。 */
  seedProductServers(specs: CreateMcpServerInput[] | undefined): void {
    for (const spec of specs ?? []) {
      if (this.get(spec.name)) continue;
      this.create(spec);
    }
  }

  create(input: CreateMcpServerInput): McpServerEntry {
    const name = input.name.trim();
    if (!name) throw new Error('服务名称不能为空');
    if (this.get(name)) throw new Error(`已存在同名服务「${name}」`);

    const now = new Date().toISOString();
    const entry: McpServerEntry = {
      id: randomUUID(),
      name,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      ...normalizeTransportInput(input),
    };
    this.store.set(STORE_KEY, [...this.list(), entry]);
    return entry;
  }

  update(id: string, updates: UpdateMcpServerInput): McpServerEntry {
    const servers = this.list();
    const idx = servers.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('服务不存在');
    const current = servers[idx];
    const nextName = updates.name !== undefined ? updates.name.trim() : current.name;
    if (!nextName) throw new Error('服务名称不能为空');
    const nameClash = servers.some(
      (s) => s.id !== id && s.name.toLowerCase() === nextName.toLowerCase(),
    );
    if (nameClash) throw new Error(`已存在同名服务「${nextName}」`);

    const transport = updates.transport ?? current.transport;
    const transportInput: CreateMcpServerInput = transport === 'stdio'
      ? {
          name: nextName,
          transport: 'stdio',
          command:
            updates.command ?? (current.transport === 'stdio' ? current.command : ''),
          args: updates.args ?? (current.transport === 'stdio' ? current.args : []),
          env: updates.env ?? (current.transport === 'stdio' ? current.env : {}),
          cwd: updates.cwd ?? (current.transport === 'stdio' ? current.cwd : undefined),
        }
      : {
          name: nextName,
          transport: 'streamable-http',
          url: updates.url ?? (current.transport === 'streamable-http' ? current.url : ''),
          headers:
            updates.headers ??
            (current.transport === 'streamable-http' ? current.headers : {}),
          headersFromEnv:
            updates.headersFromEnv ??
            (current.transport === 'streamable-http' ? current.headersFromEnv : {}),
          bearerTokenEnvVar:
            updates.bearerTokenEnvVar ??
            (current.transport === 'streamable-http'
              ? current.bearerTokenEnvVar
              : undefined),
          reconnect:
            updates.reconnect ??
            (current.transport === 'streamable-http' ? current.reconnect : undefined),
        };
    const next: McpServerEntry = {
      id: current.id,
      name: nextName,
      enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      ...normalizeTransportInput(transportInput),
    };
    servers[idx] = next;
    this.store.set(STORE_KEY, servers);
    // 配置变了，旧工具缓存不可信
    this.toolCache.delete(id);
    return next;
  }

  delete(id: string): boolean {
    const servers = this.list();
    const next = servers.filter((s) => s.id !== id);
    if (next.length === servers.length) return false;
    this.store.set(STORE_KEY, next);
    this.toolCache.delete(id);
    return true;
  }

  /**
   * 解析 Claude Desktop 风格的配置并批量导入：
   *
   * ```json
   * { "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/"] } } }
   * ```
   *
   * 也兼容裸对象（不带 mcpServers 包裹）。重名或缺 command 的条目跳过。
   */
  importClaudeConfig(raw: string | Record<string, unknown>): ImportResult {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      parsed = JSON.parse(raw); // JSON 语法错误直接抛给调用方
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('配置必须是 JSON 对象');
    }
    const container =
      'mcpServers' in parsed
        ? (parsed as Record<string, unknown>).mcpServers
        : parsed;
    if (typeof container !== 'object' || container === null || Array.isArray(container)) {
      throw new Error('mcpServers 必须是对象（服务名 → 配置）');
    }

    const result: ImportResult = { added: [], skipped: [] };
    for (const [name, cfgRaw] of Object.entries(container as Record<string, unknown>)) {
      const cfg = (cfgRaw ?? {}) as Record<string, unknown>;
      const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
      const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
      if ((!command && !url) || (command && url) || this.get(name)) {
        result.skipped.push(name);
        continue;
      }
      if (url) {
        const headers = stringRecord(cfg.headers);
        const headersFromEnv = stringRecord(
          cfg.envHttpHeaders ?? cfg.env_http_headers ?? cfg.headersFromEnv,
        );
        const bearerTokenEnvVar =
          stringValue(cfg.bearerTokenEnvVar ?? cfg.bearer_token_env_var) || undefined;
        const entry = this.create({
          name: name.trim(),
          transport: 'streamable-http',
          url,
          headers,
          headersFromEnv,
          bearerTokenEnvVar,
          enabled: true,
        });
        result.added.push(entry);
        continue;
      }
      const env: Record<string, string> = {};
      if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
        for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
          env[k] = String(v);
        }
      }
      const entry = this.create({
        name: name.trim(),
        command,
        args: Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [],
        env,
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
        enabled: true,
      });
      result.added.push(entry);
    }
    return result;
  }

  /** 工具名前缀（同一名称多实例撞名时追加 id 后缀保证唯一）。 */
  serverKey(entry: McpServerEntry): string {
    const base = sanitizeServerKey(entry.name, entry.id);
    const clash = this.list().some(
      (s) => s.id !== entry.id && sanitizeServerKey(s.name, s.id) === base,
    );
    return clash ? `${base}-${entry.id.slice(0, 4)}` : base;
  }

  toExecutorConfig(entry: McpServerEntry): McpServerConfig {
    return entry.transport === 'stdio'
      ? {
          transport: 'stdio',
          command: entry.command,
          args: entry.args,
          env: entry.env,
          cwd: entry.cwd,
        }
      : {
          transport: 'streamable-http',
          url: entry.url,
          headers: entry.headers,
          headersFromEnv: entry.headersFromEnv,
          bearerTokenEnvVar: entry.bearerTokenEnvVar,
          reconnect: entry.reconnect,
        };
  }

  toPublicEntry(entry: McpServerEntry): Record<string, unknown> {
    const common = {
      id: entry.id,
      name: entry.name,
      transport: entry.transport,
      enabled: entry.enabled,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    return entry.transport === 'stdio'
      ? {
          ...common,
          command: entry.command,
          args: [...entry.args],
          cwd: entry.cwd,
          envKeys: Object.keys(entry.env).sort(),
        }
      : {
          ...common,
          url: entry.url,
          headerNames: Object.keys(entry.headers).sort(),
          headersFromEnv: { ...entry.headersFromEnv },
          bearerTokenEnvVar: entry.bearerTokenEnvVar,
          reconnect: entry.reconnect,
        };
  }

  getCachedTools(serverId: string): CachedToolList | null {
    return this.toolCache.get(serverId) ?? null;
  }

  /**
   * 所有「已启用 + 工具缓存非空」服务的工具扁平清单（"/" 选择器数据源）。
   */
  listEnabledToolEntries(): McpToolEntry[] {
    const out: McpToolEntry[] = [];
    for (const server of this.list()) {
      if (!server.enabled) continue;
      const cached = this.getCachedTools(server.id);
      if (!cached || cached.tools.length === 0) continue;
      const serverKey = this.serverKey(server);
      for (const tool of cached.tools) {
        out.push({
          token: `mcp__${serverKey}__${tool.name}`,
          toolName: tool.name,
          serverKey,
          serverName: server.name,
          description: tool.description ?? '',
          serverId: server.id,
        });
      }
    }
    return out;
  }

  /**
   * 按完整 token（大小写不敏感）反查工具；命中时返回注册表里的规范 token
   * （用户手敲可能大小写不符，tool_call 必须用规范名）。未启用 / 无缓存 /
   * 不存在均返回 null。
   */
  findToolByToken(token: string): McpToolEntry | null {
    const needle = token.trim().toLowerCase();
    if (!needle.startsWith('mcp__')) return null;
    return (
      this.listEnabledToolEntries().find((e) => e.token.toLowerCase() === needle) ?? null
    );
  }

  /** 连接服务并刷新工具缓存；失败时缓存错误信息（tools 为空）。 */
  async refreshTools(serverId: string): Promise<CachedToolList> {
    const entry = this.list().find((s) => s.id === serverId);
    if (!entry) throw new Error('服务不存在');
    const applyChanged = (tools: CachedToolList['tools']) => {
      if (tools.length > MAX_MCP_SERVER_TOOLS) return;
      this.toolCache.set(serverId, {
        tools: tools.map((tool) => ({ ...tool })),
        fetchedAt: new Date().toISOString(),
        error: null,
      });
    };
    const result = await this.executor.listTools(
      this.toExecutorConfig(entry),
      applyChanged,
      (error) => {
        this.toolCache.set(serverId, {
          tools: [],
          fetchedAt: new Date().toISOString(),
          error,
        });
      },
    );
    const overCap = (result.tools?.length ?? 0) > MAX_MCP_SERVER_TOOLS;
    const cached: CachedToolList = result.success && !overCap
      ? {
          tools: (result.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          fetchedAt: new Date().toISOString(),
          error: null,
        }
      : {
          tools: [],
          fetchedAt: new Date().toISOString(),
          error: overCap
            ? `服务工具数超过每服务 ${MAX_MCP_SERVER_TOOLS} 个的上限`
            : result.error ?? '未知错误',
        };
    this.toolCache.set(serverId, cached);
    return cached;
  }

  /** 后台刷新所有已启用服务的工具列表（启动时调用，不阻塞、不抛错）。 */
  async refreshAllEnabled(): Promise<void> {
    const jobs = this.list()
      .filter((s) => s.enabled)
      .map((s) =>
        this.refreshTools(s.id).catch((err) => {
          this.toolCache.set(s.id, {
            tools: [],
            fetchedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    await Promise.allSettled(jobs);
  }
}
