/**
 * 破坏性操作的二次确认弹窗。点遮罩或按 Esc 取消；确认进行中不关闭。
 */
import { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/i18n';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  testId?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = t('Delete'),
  pending = false,
  onCancel,
  onConfirm,
  testId = 'confirm-dialog',
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || pending) return;
      onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, pending, onCancel]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid={testId}
    >
      <div className="w-[380px] max-w-[92vw] rounded-2xl border border-agent-border bg-agent-canvas p-5 shadow-2xl">
        <h2 id={titleId} className="text-base font-semibold text-agent-foreground">
          {title}
        </h2>
        <p
          id={descriptionId}
          className="mt-2 text-sm leading-relaxed text-agent-muted-foreground"
        >
          {description}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            autoFocus
            className="h-9 rounded-full px-4 text-sm text-agent-muted-foreground transition-colors hover:bg-agent-muted hover:text-agent-foreground disabled:opacity-40"
            data-testid={`${testId}-cancel`}
          >
            {t('Cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="h-9 rounded-full bg-agent-destructive px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            data-testid={`${testId}-confirm`}
          >
            {pending ? t('Deleting…') : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
