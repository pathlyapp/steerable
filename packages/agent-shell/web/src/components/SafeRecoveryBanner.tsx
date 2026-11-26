import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LuShieldAlert } from 'react-icons/lu';
import { t } from '@/i18n';
import { resetToDefaultApplication, stripSafeQueryParam } from '@/lib/safe-mode';

export interface SafeRecoveryBannerProps {
  onResetComplete?: () => void;
}

export function SafeRecoveryBanner({ onResetComplete }: SafeRecoveryBannerProps) {
  const navigate = useNavigate();
  const [resetting, setResetting] = useState(false);

  const handleReset = async () => {
    setResetting(true);
    try {
      await resetToDefaultApplication();
      onResetComplete?.();
      if (typeof window !== 'undefined') {
        const cleaned = stripSafeQueryParam(window.location.href);
        window.history.replaceState(null, '', cleaned);
      }
      navigate('/agent');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      role="region"
      aria-label={t('Safe recovery mode')}
      data-testid="safe-recovery-banner"
      className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-agent-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <LuShieldAlert className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <span className="truncate font-medium">
          {t('Safe recovery mode · custom application shell bypassed')}
        </span>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          data-testid="safe-recovery-settings"
          className="rounded-md px-2 py-1 text-xs font-medium text-agent-muted-foreground transition-colors hover:bg-agent-foreground/10 hover:text-agent-foreground"
        >
          {t('Settings')}
        </button>
        <button
          type="button"
          disabled={resetting}
          onClick={() => void handleReset()}
          data-testid="safe-recovery-reset"
          className="rounded-md bg-agent-foreground px-2.5 py-1 text-xs font-medium text-agent-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {t('Reset to default application')}
        </button>
      </div>
    </div>
  );
}
