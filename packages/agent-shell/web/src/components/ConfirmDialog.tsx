/**
 * 破坏性操作的二次确认弹窗。点遮罩或按 Esc 取消；确认进行中不关闭。
 */
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/i18n';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  error?: string | null;
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
  error,
  confirmLabel = t('Delete'),
  pending = false,
  onCancel,
  onConfirm,
  testId = 'confirm-dialog',
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) {
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open, pending, onCancel]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
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
        {error && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-agent-destructive">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
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
