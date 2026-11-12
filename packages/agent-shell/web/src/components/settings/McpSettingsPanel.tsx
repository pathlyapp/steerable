import { useCallback, useEffect, useState } from 'react';
import {
  LuLoaderCircle,
  LuPencil,
  LuPlug,
  LuPlus,
  LuRefreshCw,
  LuToggleLeft,
  LuToggleRight,
  LuTrash2,
} from 'react-icons/lu';
import { t } from '@/i18n';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';

/**
 * McpSettingsPanel — MCP 服务管理面板（JSON 导入 / 手动增改 / 启停 / 测试 /
 * 删除）。
 *
 * 渲染在 `/settings?section=plugins` 的 MCP 分类（AgentLayout 右侧内容区）。
 *
 * 数据与状态完全自管理：挂载时拉一次列表，操作后刷新。后端走
 * local-backend REST（`/api/v2/mcp/servers*`），注册表持久化在用户数据目录的
 * `agent-mcp-servers.json`。
 */

/** GET /api/v2/mcp/servers 返回的服务条目（含工具缓存状态）。 */
export interface McpServerInfo {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  envKeys?: string[];
  cwd?: string;
  url?: string;
  headerNames?: string[];
  headersFromEnv?: Record<string, string>;
  bearerTokenEnvVar?: string;
  enabled: boolean;
  serverKey: string;
  toolCount: number;
  toolsPreview: string[];
  lastError: string | null;
  lastFetchedAt: string | null;
}

export function McpSettingsPanel() {
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpImportJson, setMcpImportJson] = useState('');
  const [mcpImporting, setMcpImporting] = useState(false);
  const [mcpImportStatus, setMcpImportStatus] = useState<string | null>(null);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpEditingId, setMcpEditingId] = useState<string | null>(null);
  const [mcpFormTransport, setMcpFormTransport] = useState<'stdio' | 'streamable-http'>('stdio');
  const [mcpFormName, setMcpFormName] = useState('');
  const [mcpFormCommand, setMcpFormCommand] = useState('');
  const [mcpFormArgs, setMcpFormArgs] = useState('');
  const [mcpFormEnv, setMcpFormEnv] = useState('');
  const [mcpFormCwd, setMcpFormCwd] = useState('');
  const [mcpFormUrl, setMcpFormUrl] = useState('');
  const [mcpFormHeaders, setMcpFormHeaders] = useState('');
  const [mcpFormHeadersFromEnv, setMcpFormHeadersFromEnv] = useState('');
  const [mcpFormBearerEnv, setMcpFormBearerEnv] = useState('');
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpTestingId, setMcpTestingId] = useState<string | null>(null);
  const [mcpDeletingId, setMcpDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchMcpServers = useCallback(async () => {
    if (!hasHostBridge()) return;
    setMcpLoading(true);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<{ servers: McpServerInfo[] }>({
        method: 'GET',
        path: '/api/v2/mcp/servers',
      });
      setMcpServers(res.servers || []);
    } catch (err) {
      console.error('Failed to load MCP server list:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMcpServers();
  }, [fetchMcpServers]);

  const resetMcpForm = () => {
    setMcpEditingId(null);
    setMcpFormTransport('stdio');
    setMcpFormName('');
    setMcpFormCommand('');
    setMcpFormArgs('');
    setMcpFormEnv('');
    setMcpFormCwd('');
    setMcpFormUrl('');
    setMcpFormHeaders('');
    setMcpFormHeadersFromEnv('');
    setMcpFormBearerEnv('');
  };

  const parseEnvLines = (raw: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  };

  const handleSaveMcpServer = async () => {
    if (!hasHostBridge()) return;
    setMcpSaving(true);
    setError(null);
    try {
      const body = mcpFormTransport === 'stdio'
        ? {
            name: mcpFormName.trim(),
            transport: 'stdio',
            command: mcpFormCommand.trim(),
            args: mcpFormArgs.split('\n').map((s) => s.trim()).filter(Boolean),
            ...(!mcpEditingId || mcpFormEnv.trim()
              ? { env: parseEnvLines(mcpFormEnv) }
              : {}),
            cwd: mcpFormCwd.trim() || undefined,
          }
        : {
            name: mcpFormName.trim(),
            transport: 'streamable-http',
            url: mcpFormUrl.trim(),
            ...(!mcpEditingId || mcpFormHeaders.trim()
              ? { headers: parseEnvLines(mcpFormHeaders) }
              : {}),
            headersFromEnv: parseEnvLines(mcpFormHeadersFromEnv),
            bearerTokenEnvVar: mcpFormBearerEnv.trim() || undefined,
          };
      if (mcpEditingId) {
        await getHostBridge()!.localBackend.request({
          method: 'PUT',
          path: `/api/v2/mcp/servers/${encodeURIComponent(mcpEditingId)}`,
          body,
        });
      } else {
        await getHostBridge()!.localBackend.request({
          method: 'POST',
          path: '/api/v2/mcp/servers',
          body,
        });
      }
      resetMcpForm();
      setMcpFormOpen(false);
      await fetchMcpServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpSaving(false);
    }
  };

  const handleEditMcpServer = (server: McpServerInfo) => {
    setMcpEditingId(server.id);
    setMcpFormTransport(server.transport ?? 'stdio');
    setMcpFormName(server.name);
    setMcpFormCommand(server.command ?? '');
    setMcpFormArgs((server.args || []).join('\n'));
    // Stored values never return through the settings API. Blank preserves
    // the existing env map; entering lines replaces it deliberately.
    setMcpFormEnv('');
    setMcpFormCwd(server.cwd || '');
    setMcpFormUrl(server.url || '');
    setMcpFormHeaders('');
    setMcpFormHeadersFromEnv(
      Object.entries(server.headersFromEnv ?? {})
        .map(([header, variable]) => `${header}=${variable}`)
        .join('\n'),
    );
    setMcpFormBearerEnv(server.bearerTokenEnvVar || '');
    setMcpFormOpen(true);
  };

  const handleToggleMcpServer = async (server: McpServerInfo) => {
    setError(null);
    try {
      await getHostBridge()!.localBackend.request({
        method: 'PUT',
        path: `/api/v2/mcp/servers/${encodeURIComponent(server.id)}`,
        body: { enabled: !server.enabled },
      });
      await fetchMcpServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteMcpServer = async (server: McpServerInfo) => {
    setMcpDeletingId(server.id);
    setError(null);
    try {
      await getHostBridge()!.localBackend.request({
        method: 'DELETE',
        path: `/api/v2/mcp/servers/${encodeURIComponent(server.id)}`,
      });
      await fetchMcpServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpDeletingId(null);
    }
  };

  const handleTestMcpServer = async (server: McpServerInfo) => {
    setMcpTestingId(server.id);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<{
        success: boolean;
        toolCount: number;
        tools: { name: string }[];
        error: string | null;
      }>({
        method: 'POST',
        path: `/api/v2/mcp/servers/${encodeURIComponent(server.id)}/test`,
      });
      if (!res.success && res.error) {
        setError(t('"{name}" failed to connect: {error}', { name: server.name, error: res.error }));
      }
      await fetchMcpServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpTestingId(null);
    }
  };

  const handleImportMcpJson = async () => {
    const json = mcpImportJson.trim();
    if (!json) return;
    setMcpImporting(true);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<{
        added: { name: string }[];
        skipped: string[];
      }>({
        method: 'POST',
        path: '/api/v2/mcp/servers/import',
        body: { json },
      });
      const parts: string[] = [];
      if (res.added.length > 0) {
        parts.push(
          t('Imported {count}: {names}', {
            count: res.added.length,
            names: res.added.map((s) => s.name).join(t(', ')),
          }),
        );
      }
      if (res.skipped.length > 0) {
        parts.push(
          t('Skipped {count} (duplicate name or missing command): {names}', {
            count: res.skipped.length,
            names: res.skipped.join(t(', ')),
          }),
        );
      }
      setMcpImportStatus(parts.join(t('; ')) || t('No servers to import'));
      if (res.added.length > 0) setMcpImportJson('');
      await fetchMcpServers();
    } catch (err) {
      setMcpImportStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpImporting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* JSON 导入 */}
      <div className="bg-agent-muted/30 border border-agent-border/60 rounded-agent-md p-2.5 space-y-2">
        <h4 className="text-xs font-semibold text-agent-foreground flex items-center gap-1.5">
          <LuPlug className="h-3.5 w-3.5 text-agent-muted-foreground" />
          {t('Paste JSON to import (Claude Desktop format)')}
        </h4>
        <textarea
          value={mcpImportJson}
          onChange={(e) => setMcpImportJson(e.target.value)}
          placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/"]\n    }\n  }\n}'}
          rows={5}
          disabled={mcpImporting}
          className="w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 py-2 font-mono text-[11px] text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] text-agent-muted-foreground">
            {t('Same mcpServers format as Claude Desktop / Cursor. You can paste the whole block.')}
          </p>
          <button
            type="button"
            onClick={handleImportMcpJson}
            disabled={mcpImporting || !mcpImportJson.trim()}
            className={`h-8 shrink-0 px-4 rounded-full text-xs font-medium transition-all ${
              mcpImporting || !mcpImportJson.trim()
                ? 'bg-agent-muted text-agent-muted-foreground cursor-not-allowed'
                : 'bg-agent-foreground text-agent-canvas hover:opacity-90'
            }`}
          >
            {mcpImporting ? <LuLoaderCircle className="h-3 w-3 animate-spin" /> : t('Import')}
          </button>
        </div>
        {mcpImportStatus && (
          <p className="text-[10px] text-agent-muted-foreground bg-agent-muted/10 px-2 py-1 rounded border border-agent-border/20">
            {mcpImportStatus}
          </p>
        )}
      </div>

      {/* 手动添加 / 编辑表单 */}
      {mcpFormOpen ? (
        <div className="bg-agent-muted/30 border border-agent-border/60 rounded-agent-md p-2.5 space-y-2.5">
          <h4 className="text-xs font-semibold text-agent-foreground">
            {mcpEditingId ? t('Edit MCP server') : t('Add MCP server manually')}
          </h4>
          <select
            value={mcpFormTransport}
            onChange={(event) =>
              setMcpFormTransport(event.target.value as 'stdio' | 'streamable-http')
            }
            className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
          >
            <option value="stdio">{t('Local process (stdio)')}</option>
            <option value="streamable-http">{t('Remote server (Streamable HTTP)')}</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={mcpFormName}
              onChange={(e) => setMcpFormName(e.target.value)}
              placeholder={t('Name, e.g. filesystem')}
              className="h-8 rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
            />
            {mcpFormTransport === 'stdio' ? (
              <input
                type="text"
                value={mcpFormCommand}
                onChange={(e) => setMcpFormCommand(e.target.value)}
                placeholder={t('Launch command, e.g. npx / uvx / node')}
                className="h-8 rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
            ) : (
              <input
                type="url"
                value={mcpFormUrl}
                onChange={(e) => setMcpFormUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className="h-8 rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
            )}
          </div>
          {mcpFormTransport === 'stdio' ? (
            <>
              <textarea
                value={mcpFormArgs}
                onChange={(e) => setMcpFormArgs(e.target.value)}
                placeholder={t('Arguments (one per line)')}
                rows={3}
                className="w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 py-2 font-mono text-[11px] text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
              <textarea
                value={mcpFormEnv}
                onChange={(e) => setMcpFormEnv(e.target.value)}
                placeholder={
                  mcpEditingId
                    ? t('Environment variables; leave blank to keep current values')
                    : t('Environment variables (one KEY=VALUE per line)')
                }
                rows={2}
                className="w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 py-2 font-mono text-[11px] text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
              <input
                type="text"
                value={mcpFormCwd}
                onChange={(e) => setMcpFormCwd(e.target.value)}
                placeholder={t('Working directory (optional)')}
                className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
            </>
          ) : (
            <>
              <textarea
                value={mcpFormHeaders}
                onChange={(e) => setMcpFormHeaders(e.target.value)}
                placeholder={
                  mcpEditingId
                    ? t('Plain headers; leave blank to keep current values')
                    : t('Plain headers (one Header=Value per line)')
                }
                rows={2}
                className="w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 py-2 font-mono text-[11px] text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
              <textarea
                value={mcpFormHeadersFromEnv}
                onChange={(e) => setMcpFormHeadersFromEnv(e.target.value)}
                placeholder={t('Headers from environment variables (one Header=ENV_NAME per line)')}
                rows={2}
                className="w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 py-2 font-mono text-[11px] text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
              <input
                type="text"
                value={mcpFormBearerEnv}
                onChange={(e) => setMcpFormBearerEnv(e.target.value)}
                placeholder={t('Bearer token environment variable name (optional)')}
                className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              />
            </>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { resetMcpForm(); setMcpFormOpen(false); }}
              className="h-8 rounded-full px-4 text-xs font-medium text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              onClick={handleSaveMcpServer}
              disabled={
                mcpSaving ||
                !mcpFormName.trim() ||
                (mcpFormTransport === 'stdio'
                  ? !mcpFormCommand.trim()
                  : !mcpFormUrl.trim())
              }
              className={`h-8 px-4 rounded-full text-xs font-medium transition-all ${
                mcpSaving ||
                !mcpFormName.trim() ||
                (mcpFormTransport === 'stdio'
                  ? !mcpFormCommand.trim()
                  : !mcpFormUrl.trim())
                  ? 'bg-agent-muted text-agent-muted-foreground cursor-not-allowed'
                  : 'bg-agent-foreground text-agent-canvas hover:opacity-90'
              }`}
            >
              {mcpSaving ? <LuLoaderCircle className="h-3 w-3 animate-spin" /> : t('Save')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { resetMcpForm(); setMcpFormOpen(true); }}
          className="flex items-center gap-1.5 text-xs font-medium text-agent-muted-foreground hover:text-agent-foreground transition-colors"
          data-testid="mcp-add-manual"
        >
          <LuPlus className="h-3.5 w-3.5" />
          {t('Add server manually')}
        </button>
      )}

      {/* 服务列表 */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-agent-muted-foreground uppercase tracking-wide">
          {t('Registered servers')}
        </h4>
        {mcpLoading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-agent-muted-foreground">
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t('Loading MCP servers...')}
          </div>
        ) : mcpServers.length === 0 ? (
          <div className="text-center py-6 text-xs text-agent-muted-foreground">
            {t('No MCP servers yet. Paste JSON or add one manually.')}
          </div>
        ) : (
          <div className="divide-y divide-agent-border/40 pr-1">
            {mcpServers.map((server) => (
              <div key={server.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <LuPlug className="h-3.5 w-3.5 text-agent-muted-foreground flex-shrink-0" />
                    <span className="text-xs font-medium text-agent-foreground truncate">
                      {server.name}
                    </span>
                    <span
                      className={`px-1 py-0.2 rounded text-[9px] font-medium flex-shrink-0 scale-95 origin-left ${
                        server.enabled
                          ? 'bg-green-500/10 text-green-600'
                          : 'bg-agent-muted text-agent-muted-foreground'
                      }`}
                    >
                      {server.enabled ? t('Enabled') : t('Disabled')}
                    </span>
                    {server.enabled && server.toolCount > 0 && (
                      <span className="px-1 py-0.2 rounded bg-agent-muted text-[9px] text-agent-muted-foreground font-medium flex-shrink-0 scale-95 origin-left">
                        {t('{count} tools', { count: server.toolCount })}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-agent-muted-foreground font-mono truncate">
                    {server.transport === 'streamable-http'
                      ? server.url
                      : `${server.command ?? ''} ${(server.args ?? []).join(' ')}`}
                  </p>
                  {server.lastError && (
                    <p className="text-[10px] text-agent-destructive line-clamp-2">
                      {t('Connection failed: {error}', { error: server.lastError })}
                    </p>
                  )}
                  {!server.lastError && server.toolsPreview.length > 0 && (
                    <p className="text-[10px] text-agent-muted-foreground/80 line-clamp-1">
                      {t('Tools: {names}', { names: server.toolsPreview.join(t(', ')) })}
                      {server.toolCount > server.toolsPreview.length ? ' …' : ''}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => handleTestMcpServer(server)}
                    disabled={mcpTestingId === server.id}
                    className="text-agent-muted-foreground hover:text-agent-foreground p-1 rounded-full hover:bg-agent-muted transition-colors"
                    title={t('Test connection and refresh tool list')}
                  >
                    {mcpTestingId === server.id ? (
                      <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <LuRefreshCw className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEditMcpServer(server)}
                    className="text-agent-muted-foreground hover:text-agent-foreground p-1 rounded-full hover:bg-agent-muted transition-colors"
                    title={t('Edit')}
                  >
                    <LuPencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleMcpServer(server)}
                    className="text-agent-muted-foreground hover:text-agent-foreground p-1 rounded-full hover:bg-agent-muted transition-colors"
                    title={server.enabled ? t('Disable') : t('Enable')}
                  >
                    {server.enabled ? (
                      <LuToggleRight className="h-3.5 w-3.5" />
                    ) : (
                      <LuToggleLeft className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteMcpServer(server)}
                    disabled={mcpDeletingId === server.id}
                    className="text-agent-muted-foreground hover:text-agent-destructive p-1 rounded-full hover:bg-agent-muted transition-colors"
                    title={t('Delete')}
                  >
                    {mcpDeletingId === server.id ? (
                      <LuLoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <LuTrash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-[10px] text-agent-muted-foreground">
        {t(
          'Supports stdio and Streamable HTTP. Enter secrets as environment variable names, not in plain headers. Tools from enabled servers reach the assistant through tool_search.',
        )}
      </p>

      {error && (
        <div className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
