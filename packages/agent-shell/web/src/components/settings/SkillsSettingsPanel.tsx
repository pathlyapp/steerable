import { useCallback, useEffect, useState } from 'react';
import {
  LuBlocks,
  LuFolderOpen,
  LuLoaderCircle,
  LuTrash2,
} from 'react-icons/lu';
import { t } from '@/i18n';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';
import { getPackHiddenSlashSkills } from '@/packs/registry';

/**
 * SkillsSettingsPanel — 本地技能管理面板（导入目录 / 列表 / 卸载）。
 *
 * 渲染在 `/settings?section=plugins` 的 Skills 分类（AgentLayout 右侧内容区）。
 *
 * 数据与状态完全自管理：挂载时拉一次列表，操作后刷新。后端走
 * local-backend REST（`GET/POST /api/v2/chat-agents/skills*`），无专用 IPC。
 */

const BUILTIN_SKILLS = [
  '00-identity',
  '10-goal',
  '11-loop',
  '12-create-skill',
  '70-plan-mode',
  '80-tool-usage',
  '81-anti-deferred',
  '82-data-grounding',
  '85-local-exec',
  '86-proactive-coding',
  'identity',
  'goal',
  'loop',
  'create-skill',
  'plan-mode',
  'tool-usage',
  'anti-deferred',
  'anti-deferred-execution',
  'data-grounding',
  'local-exec',
  'proactive-coding',
  // 场景包的内置技能不在此硬编码——
  // 由包渲染层的 hiddenSlashSkills 声明，经 isBuiltinSkillName 并入。
];

/** 内置技能判定：shell 内置表 + 包渲染层声明的隐藏技能（包技能随构建拷贝进技能根，属内置）。 */
function isBuiltinSkillName(name: string): boolean {
  return BUILTIN_SKILLS.includes(name) || getPackHiddenSlashSkills().has(name);
}

export function SkillsSettingsPanel() {
  const [skills, setSkills] = useState<any[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchSkills = useCallback(async () => {
    if (!hasHostBridge()) return;
    setSkillsLoading(true);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<{ skills: any[] }>({
        method: 'GET',
        path: '/api/v2/chat-agents/skills',
      });
      setSkills(res.skills || []);
    } catch (err) {
      console.error('Failed to load skill list:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  const handleBrowseFolder = async () => {
    if (!hasHostBridge()) return;
    try {
      const bridge = getHostBridge();
      if (bridge?.local?.selectDirectory) {
        setImportStatus(t('Opening folder picker...'));
        const result = await bridge.local.selectDirectory();
        if (result && !result.canceled && result.filePaths.length > 0) {
          const selectedPath = result.filePaths[0];
          setImportPath(selectedPath);
          setImportStatus(t('Selected path: {path}', { path: selectedPath }));
        } else {
          setImportStatus(t('Folder selection canceled'));
        }
      } else {
        setError(t('This version of the app does not support the folder picker'));
      }
    } catch (err) {
      console.error('Failed to select folder:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportSkill = async () => {
    const trimmed = importPath.trim();
    if (!trimmed) return;
    setImporting(true);
    setError(null);
    setImportStatus(t('Importing local skill...'));
    try {
      const res = await getHostBridge()!.localBackend.request<{ success: boolean; name: string }>({
        method: 'POST',
        path: '/api/v2/chat-agents/skills/import',
        body: { path: trimmed },
      });
      if (res.success) {
        setImportPath('');
        setImportStatus(t('Import succeeded. Added skill "{name}"', { name: res.name }));
        await fetchSkills();
      } else {
        setError(t('Failed to import skill'));
        setImportStatus(t('Import failed: could not copy the skill to the runtime directory'));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setError(errMsg);
      setImportStatus(t('Import error: {error}', { error: errMsg }));
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteSkill = async (name: string) => {
    if (isBuiltinSkillName(name)) return;
    setDeletingName(name);
    setError(null);
    try {
      const res = await getHostBridge()!.localBackend.request<{ success: boolean }>({
        method: 'DELETE',
        path: `/api/v2/chat-agents/skills/delete/${encodeURIComponent(name)}`,
      });
      if (res.success) {
        await fetchSkills();
      } else {
        setError(t('Failed to delete skill'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingName(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Import Skill Bar */}
      <div className="bg-agent-muted/30 border border-agent-border/60 rounded-agent-md p-2.5 space-y-2">
        <h4 className="text-xs font-semibold text-agent-foreground flex items-center gap-1.5">
          <LuBlocks className="h-3.5 w-3.5 text-agent-muted-foreground" />
          {t('Import local skill directory')}
        </h4>
        <p className="text-[11px] text-agent-muted-foreground">
          {t('Skills saved in the current project (or working directory) under')}{' '}
          <code>skills/{t('skill-name')}/</code>{' '}
          {t('appear in the list below automatically. No import needed.')}{' '}
          {t('You can also import other local directories here (any folder with')}{' '}
          <code>SKILL.md</code> {t('inside, for example')} <code>my-team/sql-tools</code>
          {t(').')}
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1 flex items-center">
            <input
              type="text"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder={t('Enter a skill path, or click the button on the right to choose a folder')}
              className="w-full pl-3 pr-8 h-8 text-xs bg-agent-canvas text-agent-foreground border border-agent-border rounded-agent-md focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
              disabled={importing}
              data-testid="skills-import-path"
            />
            <button
              type="button"
              onClick={handleBrowseFolder}
              disabled={importing}
              className="absolute right-2.5 text-agent-muted-foreground hover:text-agent-foreground transition-colors"
              title={t('Choose a local folder')}
              data-testid="skills-import-browse"
            >
              <LuFolderOpen className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={handleImportSkill}
            disabled={importing || !importPath.trim()}
            data-testid="skills-import-submit"
            className={`h-8 px-4 rounded-full text-xs font-medium transition-all ${
              importing || !importPath.trim()
                ? 'bg-agent-muted text-agent-muted-foreground cursor-not-allowed'
                : 'bg-agent-foreground text-agent-canvas hover:opacity-90'
            }`}
          >
            {importing ? (
              <LuLoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              t('Import')
            )}
          </button>
        </div>
        {importStatus && (
          <p
            className="text-[10px] text-agent-muted-foreground bg-agent-muted/10 px-2 py-1 rounded border border-agent-border/20 mt-1"
            data-testid="skills-import-status"
          >
            {importStatus}
          </p>
        )}
      </div>

      {/* Skills List */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-agent-muted-foreground uppercase tracking-wide">
          {t('Loaded skills')}
        </h4>
        {skillsLoading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-agent-muted-foreground">
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t('Fetching loaded skills...')}
          </div>
        ) : skills.length === 0 ? (
          <div className="text-center py-6 text-xs text-agent-muted-foreground">
            {t('No loaded skills yet')}
          </div>
        ) : (
          <div className="divide-y divide-agent-border/40 pr-1">
            {skills.map((skill) => {
              const origin = skill.origin as string | undefined;
              const isBuiltin =
                origin === 'builtin' ||
                (origin !== 'user' && origin !== 'workspace' && (skill.isBuiltin ?? isBuiltinSkillName(skill.name)));
              const isWorkspace = origin === 'workspace';
              const canUninstall = !isBuiltin && !isWorkspace && !isBuiltinSkillName(skill.name);
              return (
                <div
                  key={skill.name}
                  className="py-2.5 flex items-start justify-between gap-3 group"
                  data-testid={`skill-row-${skill.name}`}
                  data-skill-name={skill.name}
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <LuBlocks className="h-3.5 w-3.5 text-agent-muted-foreground flex-shrink-0" />
                      <span className="text-xs font-medium text-agent-foreground truncate">
                        {skill.displayName || skill.name}
                      </span>
                      {skill.displayName && (
                        <span className="text-[10px] text-agent-muted-foreground/70 truncate">
                          {skill.name}
                        </span>
                      )}
                      {isBuiltin && (
                        <span className="px-1 py-0.2 rounded bg-agent-muted text-[9px] text-agent-muted-foreground font-medium flex-shrink-0 scale-95 origin-left">
                          {t('Built-in')}
                        </span>
                      )}
                      {isWorkspace && (
                        <span
                          className="px-1 py-0.2 rounded bg-agent-muted text-[9px] text-agent-muted-foreground font-medium flex-shrink-0 scale-95 origin-left"
                          title={t('From the skills/ folder of the project or working directory. Anything saved there appears in this list.')}
                        >
                          {t('Workspace')}
                        </span>
                      )}
                      {skill.layer === 'eager' ? (
                        <span
                          className="px-1 py-0.2 rounded bg-agent-muted text-[9px] text-agent-muted-foreground font-medium flex-shrink-0 scale-95 origin-left"
                          title={t('Always-on layer: the body is always injected into the system prompt')}
                        >
                          {t('Always on')}
                        </span>
                      ) : (
                        <span
                          className="px-1 py-0.2 rounded bg-agent-muted text-[9px] text-agent-muted-foreground font-medium flex-shrink-0 scale-95 origin-left"
                          title={t('On-demand layer: only listed in the catalog. The model loads it through the skill tool when needed.')}
                        >
                          {t('On demand')}
                        </span>
                      )}
                      {skill.modelInvocable === false && (
                        <span
                          className="px-1 py-0.2 rounded bg-agent-muted text-[9px] text-agent-muted-foreground font-medium flex-shrink-0 scale-95 origin-left"
                          title={t('disable-model-invocation: the model cannot call it. Trigger it manually with /name.')}
                        >
                          {t('Manual only')}
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="text-[11px] text-agent-muted-foreground leading-relaxed line-clamp-2">
                        {skill.description}
                      </p>
                    )}
                  </div>
                  {canUninstall && (
                    <button
                      type="button"
                      onClick={() => handleDeleteSkill(skill.name)}
                      disabled={deletingName === skill.name}
                      className="text-agent-muted-foreground hover:text-agent-destructive p-1 rounded-full hover:bg-agent-muted transition-colors"
                      title={t('Uninstall this skill')}
                      data-testid={`skill-uninstall-${skill.name}`}
                    >
                      {deletingName === skill.name ? (
                        <LuLoaderCircle className="h-3 w-3 animate-spin" />
                      ) : (
                        <LuTrash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div
          className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive"
          data-testid="skills-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}
