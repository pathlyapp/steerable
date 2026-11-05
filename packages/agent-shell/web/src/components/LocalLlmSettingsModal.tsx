import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LuX } from 'react-icons/lu';
import type { LlmSettings } from '@/lib/local-api';
import {
  LlmSettingsPanel,
  type LlmSettingsPanelHandle,
} from '@/components/settings/LlmSettingsPanel';
import { t } from '@/i18n';

interface LocalLlmSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (settings: LlmSettings) => void;
}

/**
 * 输入区齿轮的快捷入口：弹窗只承载本地模型表单。
 * 侧栏「设置」走 `/settings` 页（模型 + 洞察 / 遥测 / 用量 / 搜索 / 安全）。
 */
export function LocalLlmSettingsModal({ open, onClose, onSaved }: LocalLlmSettingsModalProps) {
  const panelRef = useRef<LlmSettingsPanelHandle | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // An authentication failure opens this modal specifically to fix the key,
  // so put the cursor there instead of at the top of a form the reader then
  // has to scan.
  //
  // It goes through the panel's handle rather than a document query: the panel
  // owns the field, mounts it asynchronously once settings load, and knows when
  // it is actually focusable. Polling the DOM found an element that had already
  // been replaced by a re-render, so the focus call landed on a detached node.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | undefined;
    const focusKey = () => {
      if (cancelled) return;
      // 用户已经开始在别处输入时不要抢焦点。
      const active = document.activeElement;
      const userTyping =
        active instanceof HTMLElement &&
        active !== document.body &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable);
      if (userTyping) return;
      if (panelRef.current?.focusApiKey()) return;
      timer = window.setTimeout(focusKey, 50);
    };
    focusKey();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        // 只认点在遮罩上的按下。面板内拖选/下拉选项后在阴影上弹起，
        // 合成 click 会落到遮罩，不能当关闭。
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      data-testid="llm-settings-dialog"
    >
      <div
        className="flex h-[560px] max-h-[90vh] w-[540px] max-w-[92vw] flex-col overflow-hidden rounded-agent-lg border border-agent-border bg-agent-canvas shadow-2xl animate-fade-in"
      >
        <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-agent-border px-3">
          <h2 className="text-xs font-semibold text-agent-foreground">{t('Local model settings')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
            aria-label={t('Close')}
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <LlmSettingsPanel ref={panelRef} onSaved={onSaved} />
        </div>
        <div className="flex h-9 flex-shrink-0 items-center justify-end border-t border-agent-border px-3 bg-agent-muted/10">
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded-full px-3 text-xs font-medium text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground"
          >
            {t('Close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
