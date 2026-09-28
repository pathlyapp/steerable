import { useState } from 'react';
import { LuDownload, LuUpload } from 'react-icons/lu';
import { hostToolChrome, settingsChrome } from '@/lib/host-tools';
import { BRAND_NAME } from '@/brand';
import { t } from '@/i18n';
import {
  applyClientSections,
  fetchChatDocument,
  fetchConfigDocument,
  finishConfigDocument,
  importChatDocument,
  importConfigDocument,
  listPortableChats,
  parsePortableText,
  pickJsonFile,
  portableErrorMessage,
  previewPortableDocument,
  safeDownloadName,
  saveJsonFile,
  type PortablePreview,
} from '@/lib/portable';

const EXPORT_SECTIONS: Array<{ id: string; label: string; visible: () => boolean }> = [
  { id: 'appearance', label: 'Interface', visible: () => settingsChrome('appearance') },
  { id: 'execPolicy', label: 'Command permissions', visible: () => hostToolChrome('local-fs') },
  { id: 'llm', label: 'Local model', visible: () => settingsChrome('llm') },
  { id: 'webSearch', label: 'Web search', visible: () => settingsChrome('web-search') },
  { id: 'insights', label: 'Help improve the product', visible: () => settingsChrome('insights') },
  { id: 'telemetry', label: 'Telemetry', visible: () => settingsChrome('telemetry') },
  { id: 'mcp', label: 'MCP servers', visible: () => settingsChrome('mcp') },
  { id: 'agents', label: 'Agents', visible: () => settingsChrome('agents') },
  { id: 'skills', label: 'Skill references', visible: () => settingsChrome('skills') },
];

function projectClause(chat: { projectName?: string; projectCount?: number }): string | null {
  const count = chat.projectCount ?? 0;
  if (count <= 0) return null;
  if (count === 1 && chat.projectName) {
    return t(
      'Project "{name}" (files in its directory are not included; a project with the same name reuses the one on this computer)',
      { name: chat.projectName },
    );
  }
  return t(
    '{count} projects (files in their directories are not included; projects with the same name reuse the ones on this computer)',
    { count },
  );
}

function describeChat(preview: PortablePreview): string {
  const chat = preview.chat;
  if (!chat) return t('Will be imported as a new chat. Existing chats are not overwritten.');
  const bits = [t('{count} messages', { count: chat.messageCount })];
  if (chat.attachmentCount > 0) bits.push(t('{count} attachments', { count: chat.attachmentCount }));
  if (chat.omittedAttachmentCount > 0) {
    bits.push(t('{count} attachments left out because they are too large', { count: chat.omittedAttachmentCount }));
  }
  if (chat.truncated) bits.push(t('Messages reached the export limit'));
  const project = projectClause(chat);
  if (project) bits.push(project);
  const details = bits.join(t(', '));
  if ((chat.count ?? 1) > 1) {
    return t('Will add {count} chats with {details} in total. Existing chats are not overwritten.', {
      count: chat.count ?? 1,
      details,
    });
  }
  return t('Will add chat "{title}": {details}. Existing chats are not overwritten.', {
    title: chat.title,
    details,
  });
}

function describeImport(preview: PortablePreview): string {
  if (preview.includeSecrets) return t('This config includes API keys. Importing writes them to this computer.');
  return t(
    'Checked settings will be overwritten. Sections not in the file stay unchanged. Keys are not in the package by default, so you need to fill them in after importing.',
  );
}

/**
 * 设置页「备份与迁移」：导出/导入配置和对话。
 * API Key 默认不进配置包。对话一律作为新会话导入。
 */
export function PortableSettingsPanel() {
  const visible = EXPORT_SECTIONS.filter((item) => item.visible());
  const [mode, setMode] = useState<'idle' | 'export' | 'export-chats' | 'import' | 'import-chat'>('idle');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(visible.map((item) => item.id)));
  const [chatRows, setChatRows] = useState<Array<{ id: string; title: string }>>([]);
  const [chatIds, setChatIds] = useState<Set<string>>(new Set());
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [preview, setPreview] = useState<PortablePreview | null>(null);
  const [document, setDocument] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleChat = (id: string) => {
    setChatIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startExportChats = async () => {
    setError(null);
    setStatus(null);
    setMode('export-chats');
    setBusy(true);
    try {
      const rows = await listPortableChats();
      setChatRows(rows);
      setChatIds(new Set(rows.map((row) => row.id)));
    } catch (err) {
      setError(portableErrorMessage(err));
      setMode('idle');
    } finally {
      setBusy(false);
    }
  };

  const confirmExportChats = async () => {
    const chosen = chatRows.filter((row) => chatIds.has(row.id));
    if (chosen.length === 0) {
      setError(t('Select at least one chat'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const chats = [];
      for (const row of chosen) chats.push(await fetchChatDocument(row.id));
      const saved = await saveJsonFile(safeDownloadName(BRAND_NAME, t('Chats')), {
        kind: 'steerable-chats',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        chats,
      });
      setStatus(saved ? t('Saved to {path}', { path: saved }) : t('Canceled'));
      if (saved) setMode('idle');
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startExport = () => {
    setError(null);
    setStatus(null);
    setIncludeSecrets(false);
    setSelected(new Set(visible.map((item) => item.id)));
    setMode('export');
  };

  const confirmExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const fetched = await fetchConfigDocument(includeSecrets);
      const finished = finishConfigDocument(fetched, selected);
      if (Object.keys(finished.sections).length === 0) {
        setError(t('Nothing to export'));
        return;
      }
      const saved = await saveJsonFile(safeDownloadName(BRAND_NAME, t('Config')), finished);
      setStatus(saved ? t('Saved to {path}', { path: saved }) : t('Canceled'));
      if (saved) setMode('idle');
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startImport = async (target: 'config' | 'chat') => {
    setError(null);
    setStatus(null);
    const text = await pickJsonFile();
    if (!text) return;
    const parsed = parsePortableText(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const next = await previewPortableDocument(parsed.value);
      const isChat = next.kind === 'steerable-chat' || next.kind === 'steerable-chats';
      if (target === 'chat' && !isChat) {
        setPreview(null);
        setDocument(null);
        setMode('idle');
        setError(t('This is a config package. Use "Import config".'));
        return;
      }
      if (target === 'config' && isChat) {
        setPreview(null);
        setDocument(null);
        setMode('idle');
        setError(t('This is a chat package. Use "Import chats".'));
        return;
      }
      setDocument(parsed.value);
      setPreview(next);
      if (isChat) {
        setMode('import-chat');
        return;
      }
      setSelected(new Set(next.sections.map((section) => section.id)));
      setMode('import');
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!document || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const sections = preview.sections.filter((section) => selected.has(section.id));
      const record = document as { sections?: Record<string, unknown> };
      const serverIds = sections.filter((section) => !section.clientOnly).map((section) => section.id);
      const result = serverIds.length > 0
        ? await importConfigDocument(document, serverIds)
        : { applied: [], skipped: [], notes: [], missingSkills: [], clientSections: [] };
      applyClientSections(record.sections ?? {}, selected);
      const appliedLabels = sections
        .filter((section) => section.clientOnly || result.applied.includes(section.id))
        .map((section) => section.label);
      const parts = [
        appliedLabels.length > 0
          ? t('Imported: {sections}', { sections: appliedLabels.join(t(', ')) })
          : t('Imported'),
      ];
      for (const item of result.skipped) parts.push(item.reason);
      for (const note of result.notes) parts.push(note);
      if (result.missingSkills.length > 0) {
        parts.push(t('These skills are not on this computer: {skills}', { skills: result.missingSkills.join(t(', ')) }));
      }
      setStatus(parts.join(t('. ')));
      setMode('idle');
      setPreview(null);
      setDocument(null);
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmImportChat = async () => {
    if (!document || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importChatDocument(document);
      const count = preview.chat?.count ?? 1;
      setStatus(count > 1 ? t('Imported {count} chats', { count }) : t('Imported chat "{title}"', { title: result.title }));
      setMode('idle');
      setPreview(null);
      setDocument(null);
    } catch (err) {
      setError(portableErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setMode('idle');
    setPreview(null);
    setDocument(null);
  };

  return (
    <div
      className="space-y-2 rounded-agent-md border border-agent-border bg-agent-card p-2.5"
      data-testid="portable-settings-panel"
    >
      <p className="text-xs leading-relaxed text-agent-muted-foreground">
        {t(
          'Export your config or chat history, take it to another computer, and import it there. Chats are exported with their projects, without the files in project directories. Chats are imported as new chats and do not overwrite existing history. API keys are not included by default.',
        )}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={startExport}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-agent-border px-2.5 text-xs text-agent-foreground hover:bg-agent-foreground/5"
          data-testid="portable-export-config"
        >
          <LuDownload className="h-3.5 w-3.5" />
          {t('Export config')}
        </button>
        <button
          type="button"
          onClick={() => void startExportChats()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-agent-border px-2.5 text-xs text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-60"
          data-testid="portable-export-chats"
        >
          <LuDownload className="h-3.5 w-3.5" />
          {t('Export chats')}
        </button>
        <button
          type="button"
          onClick={() => void startImport('config')}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-agent-border px-2.5 text-xs text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-60"
          data-testid="portable-import-config"
        >
          <LuUpload className="h-3.5 w-3.5" />
          {t('Import config')}
        </button>
        <button
          type="button"
          onClick={() => void startImport('chat')}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-agent-border px-2.5 text-xs text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-60"
          data-testid="portable-import-chats"
        >
          <LuUpload className="h-3.5 w-3.5" />
          {t('Import chats')}
        </button>
      </div>

      {mode === 'export' && (
        <fieldset className="space-y-1.5" data-testid="portable-export-form">
          <legend className="text-xs font-medium text-agent-foreground">{t('Sections to export')}</legend>
          {visible.map((item) => (
            <label key={item.id} className="flex items-center gap-1.5 text-xs text-agent-foreground">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggle(item.id)}
                data-testid={`portable-section-${item.id}`}
              />
              {t(item.label)}
            </label>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-agent-foreground">
            <input
              type="checkbox"
              checked={includeSecrets}
              onChange={(event) => setIncludeSecrets(event.target.checked)}
              data-testid="portable-include-secrets"
            />
            {t('Include API keys')}
          </label>
          <p className="text-[11px] leading-relaxed text-agent-muted-foreground">
            {t('When checked, the file is as sensitive as a key. Do not send it to anyone or commit it to a repository.')}
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmExport()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-export-confirm"
            >
              {busy ? t('Exporting') : t('Save file')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              {t('Cancel')}
            </button>
          </div>
        </fieldset>
      )}

      {mode === 'export-chats' && (
        <fieldset className="space-y-1.5" data-testid="portable-export-chats-form">
          <legend className="text-xs font-medium text-agent-foreground">{t('Chats to export')}</legend>
          <p className="text-[11px] leading-relaxed text-agent-muted-foreground">
            {t(
              'The projects these chats belong to are written into the file too, keeping only their names and directory locations. Files in the directories are not packaged.',
            )}
          </p>
          {busy && chatRows.length === 0 ? (
            <p className="text-xs text-agent-muted-foreground">{t('Loading chats…')}</p>
          ) : chatRows.length === 0 ? (
            <p className="text-xs text-agent-muted-foreground">{t('No chats yet.')}</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto">
              <label className="flex items-center gap-1.5 text-xs text-agent-foreground">
                <input
                  type="checkbox"
                  checked={chatIds.size === chatRows.length}
                  onChange={() => {
                    setChatIds(chatIds.size === chatRows.length ? new Set() : new Set(chatRows.map((row) => row.id)));
                  }}
                  data-testid="portable-chats-all"
                />
                {t('All ({count})', { count: chatRows.length })}
              </label>
              {chatRows.map((row) => (
                <label key={row.id} className="flex items-center gap-1.5 text-xs text-agent-foreground">
                  <input
                    type="checkbox"
                    checked={chatIds.has(row.id)}
                    onChange={() => toggleChat(row.id)}
                    data-testid={`portable-chat-${row.id}`}
                  />
                  <span className="min-w-0 truncate">{row.title}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy || chatRows.length === 0}
              onClick={() => void confirmExportChats()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-export-chats-confirm"
            >
              {busy ? t('Exporting') : t('Save file')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              {t('Cancel')}
            </button>
          </div>
        </fieldset>
      )}

      {mode === 'import-chat' && preview && (
        <div className="space-y-1.5" data-testid="portable-import-chat-form">
          <p className="text-xs leading-relaxed text-agent-foreground">{describeChat(preview)}</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmImportChat()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-import-chat-confirm"
            >
              {busy ? t('Importing') : t('Import chats')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              {t('Cancel')}
            </button>
          </div>
        </div>
      )}

      {mode === 'import' && preview && (
        <fieldset className="space-y-1.5" data-testid="portable-import-form">
          <legend className="text-xs font-medium text-agent-foreground">{t('Sections to import')}</legend>
          <p className="text-[11px] leading-relaxed text-agent-muted-foreground">{describeImport(preview)}</p>
          {preview.sections.map((section) => (
            <label key={section.id} className="flex items-center gap-1.5 text-xs text-agent-foreground">
              <input
                type="checkbox"
                checked={selected.has(section.id)}
                onChange={() => toggle(section.id)}
                data-testid={`portable-import-section-${section.id}`}
              />
              <span>{section.label}</span>
              <span className="text-agent-muted-foreground">{section.detail}</span>
            </label>
          ))}
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmImport()}
              className="h-7 rounded-full bg-agent-foreground px-2.5 text-xs text-agent-canvas disabled:opacity-60"
              data-testid="portable-import-confirm"
            >
              {busy ? t('Importing') : t('Import config')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="h-7 rounded-full px-2.5 text-xs text-agent-muted-foreground hover:bg-agent-foreground/5"
            >
              {t('Cancel')}
            </button>
          </div>
        </fieldset>
      )}

      {status && (
        <p className="text-xs text-agent-muted-foreground" data-testid="portable-status">
          {status}
        </p>
      )}
      {error && (
        <p className="text-xs text-agent-destructive" data-testid="portable-error">
          {error}
        </p>
      )}
    </div>
  );
}
