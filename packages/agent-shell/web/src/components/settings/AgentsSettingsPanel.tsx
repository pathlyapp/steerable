import { useCallback, useEffect, useState } from 'react';
import {
  LuLoaderCircle,
  LuPencil,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { t } from '@/i18n';
import { hasHostBridge } from '@/lib/host-bridge';
import {
  archiveChatAgent,
  createChatAgent,
  listChatAgents,
  updateChatAgent,
  type LocalChatAgent,
} from '@/lib/local-api';
import {
  AgentCapabilityFields,
  DEFAULT_CAPABILITY_DRAFT,
  type AgentCapabilityDraft,
} from './AgentCapabilityFields';

/**
 * AgentsSettingsPanel — 智能体目录（列表 / 新建 / 编辑 / 归档）。
 *
 * 渲染在 `/settings?section=plugins` 的智能体分类。自定义智能体出现在输入框
 * 上方的专家选择器里。内置智能体可改文案与能力，不能归档。
 *
 * 除文案外，每个智能体还持有真实生效的能力面（勾选技能 / 技能范围 /
 * 工具权限），编辑控件见 {@link AgentCapabilityFields}。
 */

const AGENT_COLORS = [
  '#0ea5e9',
  '#4f46e5',
  '#a855f7',
  '#16a34a',
  '#ea580c',
  '#e11d48',
  '#0891b2',
  '#7c3aed',
];

const DEFAULT_COLOR = AGENT_COLORS[0];

function nextSortOrder(agents: LocalChatAgent[]): number {
  return agents.reduce((max, agent) => Math.max(max, agent.sortOrder ?? 0), 0) + 1;
}

function nextColor(agents: LocalChatAgent[]): string {
  const used = new Set(agents.map((agent) => agent.color).filter(Boolean));
  return AGENT_COLORS.find((item) => !used.has(item)) ?? DEFAULT_COLOR;
}

function agentInitial(agent: LocalChatAgent): string {
  const name = agent.name.trim();
  return name ? name[0].toUpperCase() : 'A';
}

/** 列表行上的能力摘要——只列出与缺省不同的项，缺省配置不占视觉空间。 */
function capabilitySummary(agent: LocalChatAgent): string[] {
  const labels: string[] = [];
  const skillCount = agent.skillIds?.length ?? 0;
  if (skillCount > 0) labels.push(t('Skills {count}', { count: skillCount }));
  if (agent.allowExternalSkills === false) labels.push(t('Selected skills only'));
  if (agent.loadAllSkills) labels.push(t('All skills'));
  const policy = agent.toolPolicy;
  if (policy && policy.mode !== 'all' && policy.tools.length > 0) {
    labels.push(
      policy.mode === 'allowlist'
        ? t('Only {count} tools', { count: policy.tools.length })
        : t('{count} tools blocked', { count: policy.tools.length }),
    );
  }
  return labels;
}

export function AgentsSettingsPanel({
  onCatalogChange,
}: {
  onCatalogChange?: () => Promise<void> | void;
}) {
  const [agents, setAgents] = useState<LocalChatAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rolePrompt, setRolePrompt] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [capability, setCapability] = useState<AgentCapabilityDraft>(
    DEFAULT_CAPABILITY_DRAFT,
  );
  const [pendingArchive, setPendingArchive] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    if (!hasHostBridge()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listChatAgents(false);
      setAgents(res.agents || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setRolePrompt('');
    setColor(nextColor(agents));
    setCapability(DEFAULT_CAPABILITY_DRAFT);
  };

  const openCreate = () => {
    resetForm();
    setColor(nextColor(agents));
    setFormOpen(true);
  };

  const openEdit = (agent: LocalChatAgent) => {
    setEditingId(agent.id);
    setName(agent.name);
    setDescription(agent.description ?? '');
    setRolePrompt(agent.rolePrompt ?? '');
    setColor(agent.color || DEFAULT_COLOR);
    setCapability({
      skillIds: agent.skillIds ?? [],
      // 旧库行没有这两列时按「不限制」读——与后端缺省一致。
      allowExternalSkills: agent.allowExternalSkills ?? true,
      loadAllSkills: agent.loadAllSkills ?? false,
      toolPolicy: agent.toolPolicy ?? { mode: 'all', tools: [] },
    });
    setFormOpen(true);
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || !hasHostBridge()) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: trimmedName,
        color,
        description: description.trim() || null,
        rolePrompt: rolePrompt.trim() || t('You are **{name}**.', { name: trimmedName }),
        skillIds: capability.skillIds,
        allowExternalSkills: capability.allowExternalSkills,
        loadAllSkills: capability.loadAllSkills,
        toolPolicy: capability.toolPolicy,
      };
      if (editingId) {
        await updateChatAgent(editingId, body);
      } else {
        await createChatAgent({
          ...body,
          sortOrder: nextSortOrder(agents),
        });
      }
      resetForm();
      setFormOpen(false);
      await fetchAgents();
      await onCatalogChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!pendingArchive || archivingId === pendingArchive.id) return;
    const id = pendingArchive.id;
    setArchivingId(id);
    setError(null);
    try {
      await archiveChatAgent(id);
      setPendingArchive(null);
      await fetchAgents();
      await onCatalogChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchivingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-agent-muted-foreground">
        {t(
          'Custom agents appear in the expert picker above the input box. The role prompt opens the conversation as its persona, and the checked skills and tool permissions apply on every turn. Built-in agents can have their text and capabilities edited, but cannot be deleted.',
        )}
      </p>

      {formOpen ? (
        <div className="space-y-2 rounded-agent-md border border-agent-border/60 bg-agent-muted/30 p-2.5">
          <h4 className="text-xs font-semibold text-agent-foreground">
            {editingId ? t('Edit agent') : t('New agent')}
          </h4>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('Name, e.g. Geology advisor')}
            maxLength={40}
            className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
            data-testid="agent-form-name"
          />
          <input
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('One-line summary (optional)')}
            maxLength={200}
            className="h-8 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
            data-testid="agent-form-description"
          />
          <div>
            <p className="mb-1.5 text-[10px] font-medium text-agent-muted-foreground">{t('Color')}</p>
            <div className="flex flex-wrap gap-1.5" data-testid="agent-form-colors">
              {AGENT_COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setColor(item)}
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${
                    color === item
                      ? 'scale-110 border-agent-foreground'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: item }}
                  title={item}
                  aria-label={t('Color {color}', { color: item })}
                />
              ))}
            </div>
          </div>
          <textarea
            value={rolePrompt}
            onChange={(event) => setRolePrompt(event.target.value)}
            placeholder={t('Role prompt. For example: You are a geology advisor. Answer concisely, giving the conclusion first and then the evidence.')}
            rows={6}
            className="w-full rounded-agent-md border border-agent-border bg-agent-canvas px-3 py-2 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
            data-testid="agent-form-role"
          />
          <AgentCapabilityFields value={capability} onChange={setCapability} />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                resetForm();
                setFormOpen(false);
              }}
              className="h-8 rounded-full px-4 text-xs font-medium text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !name.trim()}
              data-testid="agent-form-save"
              className={`h-8 rounded-full px-4 text-xs font-medium transition-all ${
                saving || !name.trim()
                  ? 'cursor-not-allowed bg-agent-muted text-agent-muted-foreground'
                  : 'bg-agent-foreground text-agent-canvas hover:opacity-90'
              }`}
            >
              {saving ? <LuLoaderCircle className="h-3 w-3 animate-spin" /> : t('Save')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1.5 text-xs font-medium text-agent-muted-foreground transition-colors hover:text-agent-foreground"
          data-testid="agent-add"
        >
          <LuPlus className="h-3.5 w-3.5" />
          {t('Add agent')}
        </button>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-agent-muted-foreground">
          {t('Existing agents')}
          {agents.length > 0 && (
            <span className="ml-1.5 font-normal normal-case">· {agents.length}</span>
          )}
        </h4>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-agent-muted-foreground">
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t('Loading agents...')}
          </div>
        ) : agents.length === 0 ? (
          <div className="py-6 text-center text-xs text-agent-muted-foreground">
            {t('No agents yet')}
          </div>
        ) : (
          <div className="divide-y divide-agent-border/40 pr-1">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-start justify-between gap-3 py-2.5"
                data-testid={`agent-row-${agent.id}`}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                      style={{ backgroundColor: agent.color || DEFAULT_COLOR }}
                    >
                      {agentInitial(agent)}
                    </span>
                    <span className="truncate text-xs font-medium text-agent-foreground">
                      {agent.name}
                    </span>
                    {agent.isBuiltin && (
                      <span className="flex-shrink-0 rounded bg-agent-muted px-1 py-0.5 text-[9px] font-medium text-agent-muted-foreground">
                        {t('Built-in')}
                      </span>
                    )}
                  </div>
                  {agent.description && (
                    <p className="line-clamp-2 text-[11px] text-agent-muted-foreground">
                      {agent.description}
                    </p>
                  )}
                  {capabilitySummary(agent).length > 0 && (
                    <div
                      className="flex flex-wrap gap-1"
                      data-testid={`agent-capability-${agent.id}`}
                    >
                      {capabilitySummary(agent).map((label) => (
                        <span
                          key={label}
                          className="rounded bg-agent-muted/70 px-1 py-0.5 text-[9px] text-agent-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => openEdit(agent)}
                    className="rounded-full p-1 text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
                    title={t('Edit')}
                    data-testid={`agent-edit-${agent.id}`}
                  >
                    <LuPencil className="h-3.5 w-3.5" />
                  </button>
                  {!agent.isBuiltin && (
                    <button
                      type="button"
                      onClick={() =>
                        setPendingArchive({ id: agent.id, name: agent.name })
                      }
                      disabled={archivingId === agent.id}
                      className="rounded-full p-1 text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-destructive"
                      title={t('Delete')}
                      data-testid={`agent-archive-${agent.id}`}
                    >
                      {archivingId === agent.id ? (
                        <LuLoaderCircle className="h-3 w-3 animate-spin" />
                      ) : (
                        <LuTrash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div
          className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive"
          data-testid="agents-error"
        >
          {error}
        </div>
      )}
      <ConfirmDialog
        open={pendingArchive !== null}
        title={t('Delete agent')}
        description={
          pendingArchive
            ? t(
                'Delete "{name}"? It will be removed from the expert picker. Existing conversations are not affected.',
                { name: pendingArchive.name },
              )
            : ''
        }
        pending={pendingArchive !== null && archivingId === pendingArchive.id}
        onCancel={() => {
          if (archivingId) return;
          setPendingArchive(null);
        }}
        onConfirm={() => void handleArchive()}
        testId="agent-archive-dialog"
      />
    </div>
  );
}
