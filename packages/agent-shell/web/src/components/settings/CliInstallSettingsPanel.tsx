import { useState } from 'react';
import { LuLoader, LuTerminal } from 'react-icons/lu';
import { t } from '@/i18n';
import { installCommandLineTool } from '@/lib/local-api';

export function CliInstallSettingsPanel(props: {
  binName: string;
  install?: () => Promise<{ path: string; onPath: boolean }>;
}) {
  const install = props.install ?? (() => installCommandLineTool(props.binName));
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setRunning(true);
    setMessage(null);
    setError(null);
    try {
      const result = await install();
      setMessage(result.onPath
        ? t('Installed {path}', { path: result.path })
        : t('Installed {path}. Add its directory to PATH.', { path: result.path }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-2 rounded-agent-md border border-agent-border bg-agent-card p-2.5" data-testid="cli-install-settings">
      <p className="text-xs text-agent-muted-foreground">
        {t('Install the command-line tool on your PATH so you can run it from a terminal.')}
      </p>
      <button
        type="button"
        data-testid="cli-install-button"
        onClick={() => void onClick()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-agent-md bg-agent-primary px-3 py-1.5 text-xs font-medium text-agent-primary-foreground transition hover:bg-agent-primary/90 disabled:opacity-50"
      >
        {running ? (
          <>
            <LuLoader className="h-3.5 w-3.5 animate-spin" />
            {t('Installing…')}
          </>
        ) : (
          <>
            <LuTerminal className="h-3.5 w-3.5" />
            {t('Install command-line tool')}
          </>
        )}
      </button>
      {message && (
        <p data-testid="cli-install-message" className="text-xs text-agent-foreground">
          {message}
        </p>
      )}
      {error && (
        <p data-testid="cli-install-error" className="text-xs text-agent-destructive">
          {t('Install failed: {error}', { error })}
        </p>
      )}
    </div>
  );
}
