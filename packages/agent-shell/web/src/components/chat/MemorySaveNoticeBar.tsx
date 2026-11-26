import { useState } from 'react';
import { t } from '@/i18n';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';

export interface MemorySaveNoticeBarProps {
  refinementId: string;
  scope?: 'user' | 'workspace' | 'tenant';
  chatId?: string;
  workspaceId?: string;
  onEdit?: () => void;
  onWithdrawn?: (refinementId: string) => void;
}

export function MemorySaveNoticeBar({
  refinementId,
  scope = 'workspace',
  chatId,
  workspaceId,
  onEdit,
  onWithdrawn,
}: MemorySaveNoticeBarProps) {
  const [withdrawn, setWithdrawn] = useState(false);

  const handleWithdraw = async () => {
    const path = `/api/v2/memory/refinements/${encodeURIComponent(refinementId)}/withdraw`;
    const body = {
      ...(chatId ? { chatId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
    if (hasHostBridge()) {
      await getHostBridge()?.localBackend.request({ method: 'POST', path, body });
    } else {
      await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    setWithdrawn(true);
    onWithdrawn?.(refinementId);
  };

  if (withdrawn) {
    return (
      <div
        data-testid="memory-notice-withdrawn"
        className="mt-1.5 flex items-center gap-2 text-[11px] text-agent-muted-foreground"
      >
        <span>{t('Withdrawn from memory and blocked from re-learning.')}</span>
      </div>
    );
  }

  const label =
    scope === 'user'
      ? t('Remembered personal preference')
      : t('Remembered project preference');

  return (
    <div
      data-testid="memory-save-notice-bar"
      className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-agent-muted-foreground"
    >
      <span>{label}</span>
      <span>·</span>
      {onEdit ? (
        <button
          type="button"
          data-testid="memory-notice-edit"
          onClick={onEdit}
          className="underline hover:text-agent-foreground"
        >
          {t('Edit')}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="memory-notice-withdraw"
        onClick={() => void handleWithdraw()}
        className="underline hover:text-rose-600"
      >
        {t('Withdraw')}
      </button>
    </div>
  );
}

export default MemorySaveNoticeBar;
