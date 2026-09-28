import { useEffect, useState } from 'react';
import { LuCodeXml } from 'react-icons/lu';
import { t } from '@/i18n';
import {
  getHostBridge,
  type PythonRunnerSnapshot,
} from '@/lib/host-bridge';

type Source = PythonRunnerSnapshot['source'];

function formatBytes(value?: number): string {
  if (value == null) return '';
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function PythonRunnerSettingsPanel() {
  const [snapshot, setSnapshot] = useState<PythonRunnerSnapshot | null>(null);
  const [source, setSource] = useState<Source>('default');
  const [url, setUrl] = useState('');
  const [localPath, setLocalPath] = useState('');

  useEffect(() => {
    const runner = getHostBridge()?.pythonRunner;
    if (!runner) return;
    let alive = true;
    void runner.snapshot().then((next) => {
      if (!alive) return;
      setSnapshot(next);
      setSource(next.source);
      setUrl(next.configuredUrl ?? '');
    }).catch(() => {});
    const off = runner.onState((next) => {
      if (alive) setSnapshot(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!snapshot?.supported) return null;
  const runner = getHostBridge()?.pythonRunner;
  const busy =
    snapshot.phase === 'downloading'
    || snapshot.phase === 'verifying'
    || snapshot.phase === 'extracting';

  const update = (task: Promise<PythonRunnerSnapshot>) => {
    void task.then(setSnapshot).catch((error: unknown) => {
      setSnapshot({
        ...snapshot,
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const chooseLocal = () => {
    if (!runner) return;
    void runner.pickLocal().then((path) => {
      if (path) setLocalPath(path);
    });
  };

  const run = () => {
    if (!runner || busy) return;
    if (source === 'local') {
      update(runner.useLocal(localPath));
      return;
    }
    update(runner.download(source === 'url' ? url : undefined));
  };

  const actionLabel =
    source === 'local'
      ? t('Use this Python')
      : source === 'url'
        ? t('Download from this URL')
        : t('Download default runner');
  const phaseLabel =
    snapshot.phase === 'verifying'
      ? t('Verifying')
      : snapshot.phase === 'extracting'
        ? t('Extracting')
        : t('Downloading');

  return (
    <section className="space-y-2" data-testid="settings-section-python-runner">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
        <LuCodeXml className="h-3.5 w-3.5 text-agent-muted-foreground" />
        {t('Python code runner')}
      </h2>
      <div className="space-y-3 rounded-agent-md border border-agent-border bg-agent-card p-3 text-xs">
        <p className="leading-relaxed text-agent-muted-foreground">
          {t(
            'run_code uses a separate Python interpreter. Downloading and configuring it does not block chat. Changes take effect after you restart the app.',
          )}
        </p>

        <div className="flex flex-wrap gap-3">
          {([
            ['default', 'Default URL'],
            ['url', 'Custom URL'],
            ['local', 'Local Python'],
          ] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5 text-agent-foreground">
              <input
                type="radio"
                name="python-runner-source"
                value={value}
                checked={source === value}
                disabled={busy}
                onChange={() => setSource(value)}
              />
              {t(label)}
            </label>
          ))}
        </div>

        {source === 'default' ? (
          <p className="break-all text-agent-muted-foreground" data-testid="python-runner-default-url">
            {snapshot.defaultUrl}
          </p>
        ) : null}

        {source === 'url' ? (
          <div className="space-y-1.5">
            <input
              type="url"
              value={url}
              disabled={busy}
              placeholder="https://example.com/python-runner.tar.gz"
              className="h-8 w-full rounded-agent-sm border border-agent-border bg-agent-canvas px-2 text-agent-foreground outline-none focus:border-agent-foreground/40"
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="text-agent-destructive">
              {t('Custom URLs are not checked for file integrity. Use only trusted sources.')}
            </p>
          </div>
        ) : null}

        {source === 'local' ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={localPath}
              disabled={busy}
              placeholder={t('Absolute path to the Python executable')}
              className="h-8 min-w-0 flex-1 rounded-agent-sm border border-agent-border bg-agent-canvas px-2 text-agent-foreground outline-none focus:border-agent-foreground/40"
              onChange={(event) => setLocalPath(event.target.value)}
            />
            <button
              type="button"
              disabled={busy}
              className="h-8 shrink-0 rounded-agent-sm border border-agent-border px-3 text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-50"
              onClick={chooseLocal}
            >
              {t('Choose…')}
            </button>
          </div>
        ) : null}

        {busy ? (
          <div className="space-y-2" data-testid="python-runner-progress">
            <div className="h-1.5 overflow-hidden rounded-full bg-agent-foreground/10">
              <div
                className="h-full rounded-full bg-agent-foreground transition-[width]"
                style={{ width: `${snapshot.percent ?? 0}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-agent-muted-foreground">
              <span>
                {phaseLabel}
                {snapshot.percent != null ? ` ${snapshot.percent}%` : ''}
                {snapshot.downloadedBytes != null
                  ? ` · ${formatBytes(snapshot.downloadedBytes)}${snapshot.totalBytes ? ` / ${formatBytes(snapshot.totalBytes)}` : ''}`
                  : ''}
              </span>
              <button
                type="button"
                className="text-agent-foreground hover:underline"
                onClick={() => runner && update(runner.cancel())}
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="python-runner-action"
              disabled={
                (source === 'url' && !url.trim())
                || (source === 'local' && !localPath.trim())
              }
              className="h-8 rounded-agent-sm border border-agent-border px-3 text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-50"
              onClick={run}
            >
              {actionLabel}
            </button>
            {snapshot.restartRequired ? (
              <button
                type="button"
                data-testid="python-runner-restart"
                className="h-8 rounded-agent-sm bg-agent-foreground px-3 font-medium text-agent-canvas hover:opacity-90"
                onClick={() => void runner?.restart()}
              >
                {t('Restart app')}
              </button>
            ) : null}
          </div>
        )}

        {snapshot.message ? (
          <p
            className={snapshot.phase === 'error' ? 'text-agent-destructive' : 'text-agent-muted-foreground'}
            role={snapshot.phase === 'error' ? 'alert' : undefined}
          >
            {snapshot.message}
          </p>
        ) : null}
        {snapshot.restartRequired ? (
          <p className="font-medium text-agent-foreground">{t('Saved. Takes effect after you restart the app.')}</p>
        ) : null}
        {snapshot.activeRunner ? (
          <p className="break-all text-agent-muted-foreground">
            {t('Current session: {runner}', { runner: snapshot.activeRunner })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
