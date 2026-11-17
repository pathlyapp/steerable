import { Outlet } from 'react-router-dom';
import { ZoomToast } from './components/ZoomToast';
import { hasHostBridge } from './lib/host-bridge';
import { isDemoMode } from './lib/demo-flag';

export function AppShell() {
  return (
    <div className="flex h-full w-full flex-col bg-agent-canvas text-agent-foreground">
      <ZoomToast />
      <main className="flex flex-1 overflow-hidden">
        <Outlet />
      </main>
      {isDemoMode() ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-agent-border bg-agent-muted px-3 py-1 text-xs text-agent-muted-foreground">
          <span>
            Demo &middot; interactive CoreLoop &amp; sandbox playbook (no live model — run{' '}
            <code className="rounded bg-agent-canvas px-1 py-0.5 font-mono text-[11px] text-agent-foreground">
              steerable-cli login
            </code>{' '}
            locally for live LLMs)
          </span>
          <a
            href="../"
            className="font-medium text-agent-foreground underline underline-offset-2 hover:opacity-80"
          >
            &larr; Docs
          </a>
        </div>
      ) : (
        !hasHostBridge() && (
          <div className="border-t border-agent-border bg-agent-muted px-3 py-1 text-xs text-agent-muted-foreground">
            Browser preview mode &middot; no host bridge
          </div>
        )
      )}
    </div>
  );
}
