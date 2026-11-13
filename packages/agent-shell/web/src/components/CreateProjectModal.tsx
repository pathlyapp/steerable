/**
 * 新建 / 编辑项目弹窗（Codex 式）：项目是带名字的容器，可附加多个源文件夹。
 * 家目录由后端建在 Documents/<应用名>/<项目名>/；源文件夹及其子目录也可读写。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuFolder, LuFolderPlus, LuX } from 'react-icons/lu';
import { BRAND_NAME } from '@/brand';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { getHostBridge } from '@/lib/host-bridge';
import { t } from '@/i18n';

export interface ProjectFormValues {
  name: string;
  sourceFolders: string[];
}

export interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: ProjectFormValues) => Promise<void>;
  mode?: 'create' | 'edit';
  initial?: ProjectFormValues;
  onDelete?: () => Promise<void> | void;
}

export function CreateProjectModal({
  open,
  onClose,
  onCreate,
  mode = 'create',
  initial,
  onDelete,
}: CreateProjectModalProps) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState(initial?.name ?? '');
  const [sourceFolders, setSourceFolders] = useState(initial?.sourceFolders ?? []);
  const [folderDraft, setFolderDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialFoldersKey = (initial?.sourceFolders ?? []).join('\0');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setSourceFolders(initial?.sourceFolders ?? []);
    setFolderDraft('');
    setSubmitting(false);
    setDeleting(false);
    setDeleteConfirmOpen(false);
    setError(null);
  }, [open, initial?.name, initialFoldersKey]);

  useEffect(() => {
    if (!open || deleteConfirmOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, deleteConfirmOpen]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const trimmed = name.trim();
  const homePreview = `~/Documents/${BRAND_NAME}/${trimmed || t('project-name')}`;
  const titleId = isEdit ? 'edit-project-title' : 'create-project-title';

  const addSourceFolder = (folder: string) => {
    const next = folder.trim();
    if (!next) return;
    setSourceFolders((prev) => (prev.includes(next) ? prev : [...prev, next]));
    setFolderDraft('');
    setError(null);
  };

  const handleAddFolder = async () => {
    const typed = folderDraft.trim();
    if (typed) {
      addSourceFolder(typed);
      return;
    }
    const picker = getHostBridge()?.local?.selectDirectory;
    if (!picker) {
      setError(t('Enter a folder path'));
      return;
    }
    try {
      const result = await picker({ title: t('Add source folder') });
      if (!result || result.canceled || result.filePaths.length === 0) return;
      addSourceFolder(result.filePaths[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit = async () => {
    if (!trimmed || submitting || deleting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name: trimmed, sourceFolders });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete || deleting || submitting) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={isEdit ? 'edit-project-dialog' : 'create-project-dialog'}
    >
      <div className="flex w-[440px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-agent-border bg-agent-canvas shadow-2xl">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 id={titleId} className="text-base font-semibold text-agent-foreground">
            {isEdit ? t('Edit project') : t('New project')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
            aria-label={t('Close')}
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-3">
          <label className="flex h-10 items-center gap-2 rounded-full border border-agent-border bg-agent-canvas px-3 focus-within:border-agent-foreground/40">
            <LuFolder className="h-4 w-4 shrink-0 text-agent-muted-foreground" />
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit();
              }}
              placeholder={t('Project name')}
              autoFocus
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-agent-foreground outline-none placeholder:text-agent-muted-foreground"
              data-testid={isEdit ? 'edit-project-name' : 'create-project-name'}
            />
          </label>
          {!isEdit && (
            <p className="px-1 text-[11px] text-agent-muted-foreground">
              {t('Default location: {path}', { path: homePreview })}
            </p>
          )}

          <div>
            <div className="mb-1 text-sm text-agent-foreground">{t('Source folders')}</div>
            <p className="mb-2 text-[11px] text-agent-muted-foreground">
              {t('These folders and their subfolders are readable and writable.')}
            </p>
            <div className="overflow-hidden rounded-2xl border border-agent-border">
              {sourceFolders.map((folder) => (
                <div
                  key={folder}
                  className="flex items-center gap-2 border-b border-agent-border/60 px-3 py-2 text-xs text-agent-foreground"
                >
                  <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono" title={folder}>
                    {folder}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setSourceFolders((prev) => prev.filter((item) => item !== folder))
                    }
                    className="rounded-full p-0.5 text-agent-muted-foreground hover:text-agent-foreground"
                    aria-label={t('Remove {folder}', { folder })}
                  >
                    <LuX className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 px-3 py-2">
                <LuFolderPlus className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                <input
                  type="text"
                  value={folderDraft}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleAddFolder();
                    }
                  }}
                  placeholder={t('Type a path, or click Add to browse')}
                  className="h-7 min-w-0 flex-1 bg-transparent text-xs text-agent-foreground outline-none placeholder:text-agent-muted-foreground"
                  data-testid={isEdit ? 'edit-project-folder-path' : 'create-project-folder-path'}
                />
                <button
                  type="button"
                  onClick={() => void handleAddFolder()}
                  className="shrink-0 rounded-full px-2 py-1 text-xs font-medium text-agent-foreground hover:bg-agent-muted"
                  data-testid={isEdit ? 'edit-project-add-folder' : 'create-project-add-folder'}
                >
                  {t('Add')}
                </button>
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-agent-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 pb-4 pt-1">
          {onDelete && (
            <button
              type="button"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={deleting || submitting}
              title={t('Delete project (its chats stay as chats without a project)')}
              className="mr-auto h-9 rounded-full px-3 text-sm text-agent-destructive transition-colors hover:bg-agent-destructive/10 disabled:opacity-40"
              data-testid="edit-project-delete"
            >
              {t('Delete local project')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`h-9 rounded-full px-4 text-sm text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground ${
              onDelete ? '' : 'ml-auto'
            }`}
          >
            {t('Cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!trimmed || submitting || deleting}
            className="h-9 rounded-full bg-agent-foreground px-4 text-sm font-medium text-agent-canvas transition-opacity disabled:opacity-40"
            data-testid={isEdit ? 'edit-project-submit' : 'create-project-submit'}
          >
            {submitting
              ? isEdit
                ? t('Saving…')
                : t('Creating…')
              : isEdit
                ? t('Save')
                : t('Create project')}
          </button>
        </div>
      </div>
      {onDelete && (
        <ConfirmDialog
          open={deleteConfirmOpen}
          title={t('Delete project')}
          description={t(
            'Delete project "{name}"? Its chats will stay as chats without a project.',
            { name: trimmed || t('Untitled') },
          )}
          confirmLabel={t('Delete project')}
          pending={deleting}
          onCancel={() => {
            if (deleting) return;
            setDeleteConfirmOpen(false);
          }}
          onConfirm={() => void handleDelete()}
          testId="edit-project-delete-dialog"
        />
      )}
    </div>,
    document.body,
  );
}
