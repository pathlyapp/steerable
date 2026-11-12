import { useState, type ReactNode } from 'react';
import {
  LuCheck,
  LuChevronDown,
  LuFolder,
  LuFolderPen,
  LuFolderPlus,
  LuFolderX,
  LuLoaderCircle,
  LuPlus,
} from 'react-icons/lu';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';
import {
  createProject,
  updateChatProject,
  updateProject,
  type LocalProject,
} from '@/lib/local-api';
import { t } from '@/i18n';

/**
 * 项目徽章 / 选择器（Codex 式 cwd 指示），渲染在输入框上方的 meta 行里，
 * 与专家选择器并排（项目在前）。
 *
 * 两个导出组件共用同一套按钮 + 上开菜单视觉：
 *   - ChatProjectBadge   — 会话内：显示当前项目（无项目时显示"选择项目"），
 *                          可关联/移动到其他项目、修改项目目录、移出项目。
 *   - ProjectPickerButton — 落地页（还没有 chat）：受控选择器，选中的
 *                          projectId 在首次发消息建会话时一并传入。
 *
 * 菜单用透明全屏 backdrop 关外击（一次性菜单，比 click-outside 管线简单）。
 */

/* ---------------- 共享内部件 ---------------- */

function BadgeButton({
  label,
  active,
  open,
  busy,
  onClick,
  title,
}: {
  label: string;
  /** true = 已关联/已选中项目（实心图标）；false = 未选择（虚线感 + Plus 图标）。 */
  active: boolean;
  open: boolean;
  busy: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      className={`flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] transition-colors disabled:opacity-60 ${
        active
          ? 'text-agent-muted-foreground/80 hover:bg-agent-foreground/5 hover:text-agent-foreground'
          : 'border border-dashed border-agent-border text-agent-muted-foreground/70 hover:border-agent-muted-foreground/50 hover:text-agent-foreground'
      }`}
    >
      {busy ? (
        <LuLoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
      ) : active ? (
        <LuFolder className="h-3 w-3 shrink-0" />
      ) : (
        <LuFolderPlus className="h-3 w-3 shrink-0" />
      )}
      <span className="max-w-[220px] truncate font-medium">{label}</span>
      <LuChevronDown
        className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      />
    </button>
  );
}

function MenuShell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div
        role="menu"
        className="absolute bottom-full left-0 z-50 mb-1 w-64 overflow-hidden rounded-agent-md border border-agent-border bg-agent-canvas p-1 shadow-lg"
      >
        {children}
      </div>
    </>
  );
}

function MenuSectionLabel({
  children,
  onAdd,
}: {
  children: ReactNode;
  onAdd?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-1 px-2 py-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-agent-muted-foreground">
        {children}
      </div>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground transition-colors hover:bg-agent-foreground/10 hover:text-agent-foreground"
          title={t('New project')}
          aria-label={t('New project')}
        >
          <LuPlus className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function CreateProjectMenuItem({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5"
    >
      <LuFolderPlus className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
      {t('New project')}
    </button>
  );
}

function ProjectMenuRow({
  project,
  selected,
  onClick,
}: {
  project: LocalProject;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5"
      title={project.folderPath}
    >
      <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {selected && (
        <LuCheck className="h-3 w-3 shrink-0 text-agent-muted-foreground" />
      )}
    </button>
  );
}

/* ---------------- 会话内徽章（chat-bound） ---------------- */

export function ChatProjectBadge({
  chatId,
  project,
  projects,
  onProjectsChanged,
  onChatProjectChanged,
}: {
  chatId: string;
  /** 当前会话绑定的项目；null = 无项目会话（徽章变为"选择项目"）。 */
  project: LocalProject | null;
  /** 全部项目（用于关联列表）。 */
  projects: LocalProject[];
  /** 项目本身被修改（改目录）后回调，让父组件刷新项目列表。 */
  onProjectsChanged: () => void | Promise<void>;
  /** 会话归属变化后回调（通常是 refreshChats）。 */
  onChatProjectChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openCreate = () => {
    setOpen(false);
    setCreateOpen(true);
  };

  const otherProjects = project
    ? projects.filter((p) => p.id !== project.id)
    : projects;

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const moveTo = (projectId: string | null) =>
    run(async () => {
      await updateChatProject(chatId, projectId);
      await onChatProjectChanged();
    });

  const changeFolder = () =>
    run(async () => {
      if (!hasHostBridge() || !project) return;
      const result = await getHostBridge()!.local?.selectDirectory({
        title: t('Choose a new folder for "{name}"', { name: project.name }),
      });
      if (!result || result.canceled || result.filePaths.length === 0) return;
      await updateProject(project.id, { folderPath: result.filePaths[0] });
      await onProjectsChanged();
    });

  return (
    <div className="relative">
      <BadgeButton
        label={project ? project.name : t('Choose a project')}
        active={Boolean(project)}
        open={open}
        busy={busy}
        onClick={() => {
          setError(null);
          setOpen((v) => !v);
        }}
        title={
          project
            ? `${project.folderPath}\n${t('Click to manage the project or change its folder')}`
            : t(
                'Link this chat to a project (file writes are limited to the project home folder, its source folders, and their subfolders)',
              )
        }
      />

      {open && (
        <MenuShell onClose={() => setOpen(false)}>
          {project ? (
            <>
              <MenuSectionLabel>{t('Current project')}</MenuSectionLabel>
              <div
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-agent-foreground"
                title={project.folderPath}
              >
                <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {project.name}
                </span>
                <LuCheck className="h-3 w-3 shrink-0 text-agent-muted-foreground" />
              </div>
              <div
                className="truncate px-2 pb-1 text-[10px] font-mono text-agent-muted-foreground/70"
                title={project.folderPath}
              >
                {project.folderPath}
              </div>
            </>
          ) : (
            <MenuSectionLabel onAdd={openCreate}>{t('Link to a project')}</MenuSectionLabel>
          )}

          {otherProjects.length > 0 && (
            <>
              {project && (
                <div className="mx-1 my-1 border-t border-agent-border/60" />
              )}
              {project && <MenuSectionLabel>{t('Move to')}</MenuSectionLabel>}
              <div className="max-h-40 overflow-y-auto">
                {otherProjects.map((p) => (
                  <ProjectMenuRow
                    key={p.id}
                    project={p}
                    onClick={() => void moveTo(p.id)}
                  />
                ))}
              </div>
            </>
          )}
          {!project && projects.length === 0 && (
            <>
              <div className="px-2 py-1.5 text-[11px] text-agent-muted-foreground/70">
                {t('No projects yet')}
              </div>
              <CreateProjectMenuItem onClick={openCreate} />
            </>
          )}

          {project && (
            <>
              <div className="mx-1 my-1 border-t border-agent-border/60" />
              <button
                type="button"
                role="menuitem"
                onClick={() => void changeFolder()}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5"
              >
                <LuFolderPen className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                {t('Change project folder...')}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void moveTo(null)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5"
              >
                <LuFolderX className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                {t('Remove from project (becomes a chat without a project)')}
              </button>
            </>
          )}

          {error && (
            <div className="mx-1 mt-1 rounded bg-agent-destructive/10 px-2 py-1 text-[11px] text-agent-destructive">
              {error}
            </div>
          )}
        </MenuShell>
      )}

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (input) => {
          const res = await createProject({
            name: input.name,
            ...(input.sourceFolders.length > 0 ? { sourceFolders: input.sourceFolders } : {}),
          });
          await onProjectsChanged();
          if (res.project?.id) {
            await updateChatProject(chatId, res.project.id);
            await onChatProjectChanged();
          }
        }}
      />
    </div>
  );
}

/* ---------------- 落地页选择器（受控，无 chat） ---------------- */

export function ProjectPickerButton({
  projects,
  value,
  onChange,
  onProjectsChanged,
}: {
  projects: LocalProject[];
  /** 当前选中的 projectId；null = 无项目。 */
  value: string | null;
  onChange: (projectId: string | null) => void;
  /** 新建项目后刷新列表。 */
  onProjectsChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const selected = value ? (projects.find((p) => p.id === value) ?? null) : null;

  const openCreate = () => {
    setOpen(false);
    setCreateOpen(true);
  };

  return (
    <div className="relative">
      <BadgeButton
        label={selected ? selected.name : t('Choose a project')}
        active={Boolean(selected)}
        open={open}
        busy={false}
        onClick={() => setOpen((v) => !v)}
        title={
          selected
            ? `${selected.folderPath}\n${t('New chats will be linked to this project')}`
            : t(
                'Choose a project for the new chat. Without one, a workspace for this chat is created under Documents/<app name>/conversations/',
              )
        }
      />

      {open && (
        <MenuShell onClose={() => setOpen(false)}>
          <MenuSectionLabel onAdd={openCreate}>{t('Project for new chat')}</MenuSectionLabel>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5"
          >
            <LuFolderX className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t('No project')}</span>
            {!selected && (
              <LuCheck className="h-3 w-3 shrink-0 text-agent-muted-foreground" />
            )}
          </button>
          <div className="max-h-40 overflow-y-auto">
            {projects.map((p) => (
              <ProjectMenuRow
                key={p.id}
                project={p}
                selected={p.id === value}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          {projects.length === 0 && (
            <>
              <div className="px-2 py-1.5 text-[11px] text-agent-muted-foreground/70">
                {t('No projects yet')}
              </div>
              <CreateProjectMenuItem onClick={openCreate} />
            </>
          )}
        </MenuShell>
      )}

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (input) => {
          const res = await createProject({
            name: input.name,
            ...(input.sourceFolders.length > 0 ? { sourceFolders: input.sourceFolders } : {}),
          });
          await onProjectsChanged();
          if (res.project?.id) onChange(res.project.id);
        }}
      />
    </div>
  );
}

export default ChatProjectBadge;
