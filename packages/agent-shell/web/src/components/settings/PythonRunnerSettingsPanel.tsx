import { useEffect, useState } from 'react';
import { LuCodeXml } from 'react-icons/lu';
import {
  getElectronBridge,
  type PythonRunnerSnapshot,
} from '@/lib/electron-bridge';

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
    const runner = getElectronBridge()?.pythonRunner;
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
  const runner = getElectronBridge()?.pythonRunner;
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
      ? '使用此 Python'
      : source === 'url'
        ? '从此地址下载'
        : '下载默认运行器';
  const phaseLabel =
    snapshot.phase === 'verifying'
      ? '正在校验'
      : snapshot.phase === 'extracting'
        ? '正在解压'
        : '正在下载';

  return (
    <section className="space-y-2" data-testid="settings-section-python-runner">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
        <LuCodeXml className="h-3.5 w-3.5 text-agent-muted-foreground" />
        Python 代码运行器
      </h2>
      <div className="space-y-3 rounded-agent-md border border-agent-border bg-agent-card p-3 text-xs">
        <p className="leading-relaxed text-agent-muted-foreground">
          run_code 使用独立的 Python 解释器。下载和配置不会阻塞聊天，变更在重启应用后生效。
        </p>

        <div className="flex flex-wrap gap-3">
          {([
            ['default', '默认地址'],
            ['url', '自定义地址'],
            ['local', '本地 Python'],
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
              {label}
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
              自定义地址不会校验文件完整性，请仅使用可信来源。
            </p>
          </div>
        ) : null}

        {source === 'local' ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={localPath}
              disabled={busy}
              placeholder="Python 可执行文件的绝对路径"
              className="h-8 min-w-0 flex-1 rounded-agent-sm border border-agent-border bg-agent-canvas px-2 text-agent-foreground outline-none focus:border-agent-foreground/40"
              onChange={(event) => setLocalPath(event.target.value)}
            />
            <button
              type="button"
              disabled={busy}
              className="h-8 shrink-0 rounded-agent-sm border border-agent-border px-3 text-agent-foreground hover:bg-agent-foreground/5 disabled:opacity-50"
              onClick={chooseLocal}
            >
              选择…
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
                取消
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
                重启应用
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
          <p className="font-medium text-agent-foreground">已保存，重启应用后生效。</p>
        ) : null}
        {snapshot.activeRunner ? (
          <p className="break-all text-agent-muted-foreground">
            当前会话：{snapshot.activeRunner}
          </p>
        ) : null}
      </div>
    </section>
  );
}
