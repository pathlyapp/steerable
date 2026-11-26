import { useEffect, useRef } from 'react';
import { LuFlag, LuShieldAlert, LuTriangleAlert } from 'react-icons/lu';
import {
  type ApprovalDecisionKind,
  type ApprovalPromptRequest,
} from '@/lib/host-bridge';
import { t } from '@/i18n';

/**
 * ApprovalPromptMenu — W4-1 & Phase 9 `outward` approval UI.
 *
 * Supports the 7-variant approval algebra for standard/egress/sandbox prompts,
 * and enforces single-invocation confirmation for `checkpoint === 'outward'`
 * (hiding session/always options and placing initial keyboard focus on Reject).
 */

const MODE_LABEL: Record<string, string> = {
  read: 'Read only',
  safe_write: 'Write',
  destructive: 'Dangerous',
  other: 'Other',
};

function summarizeArguments(args: Record<string, unknown>): string {
  for (const key of ['url', 'command', 'cmd', 'path', 'file', 'target', 'query', 'content']) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 300 ? `${v.slice(0, 300)}…` : v;
    }
  }
  const json = JSON.stringify(args);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

interface DecisionButton {
  kind: ApprovalDecisionKind;
  label: string;
  tone: 'allow' | 'deny' | 'abort';
}

function categoryName(label: string): string {
  return t(label);
}

function allowButtons(request: ApprovalPromptRequest): DecisionButton[] {
  const category = request.category !== request.toolName && request.categoryLabel
    ? categoryName(request.categoryLabel)
    : undefined;
  return [
    { kind: 'allow_once', label: 'Allow once', tone: 'allow' },
    {
      kind: 'allow_for_session',
      label: category ? t('Allow {category} for this chat', { category }) : 'Allow for this chat',
      tone: 'allow',
    },
    {
      kind: 'allow_always',
      label: category ? t('Always allow {category}', { category }) : 'Always allow',
      tone: 'allow',
    },
  ];
}

const DENY_BUTTONS: DecisionButton[] = [
  { kind: 'deny_once', label: 'Deny once', tone: 'deny' },
  { kind: 'deny_for_session', label: 'Deny for this chat', tone: 'deny' },
  { kind: 'deny_always', label: 'Always deny', tone: 'deny' },
];

function DecisionRow({
  buttons,
  onPick,
}: {
  buttons: DecisionButton[];
  onPick: (kind: ApprovalDecisionKind) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.map((b) => (
        <button
          key={b.kind}
          type="button"
          data-testid={`approval-${b.kind}`}
          onClick={() => onPick(b.kind)}
          className={
            b.tone === 'allow'
              ? 'rounded-agent-md bg-agent-foreground px-3 py-1.5 text-xs font-medium text-agent-canvas transition hover:opacity-90'
              : 'rounded-agent-md border border-agent-border px-3 py-1.5 text-xs font-medium text-agent-foreground transition hover:bg-agent-muted'
          }
        >
          {t(b.label)}
        </button>
      ))}
    </div>
  );
}

export function ApprovalPromptMenu({
  request: current,
  pendingCount,
  onDecide,
}: {
  request: ApprovalPromptRequest;
  pendingCount: number;
  onDecide: (kind: ApprovalDecisionKind) => void;
}) {
  const isOutward = current.checkpoint === 'outward';
  const outwardRejectRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOutward) return;
    outwardRejectRef.current?.focus();
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDecide('deny_once');
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [isOutward, current.requestId, onDecide]);

  const destructive = current.mode === 'destructive';
  const isEgress = current.category === 'network_egress';
  const isSandboxEscalation = current.category === 'sandbox_escalation';
  const isBrowser = current.category === 'browser';
  const sandboxOff = current.sandboxEnforced === false;
  const outsideWorkspace =
    current.outsideWorkspace === true &&
    !isOutward &&
    !isEgress &&
    !isSandboxEscalation &&
    !isBrowser &&
    !sandboxOff;
  const cwd = typeof current.arguments.cwd === 'string' ? current.arguments.cwd : '';
  const egressHost =
    typeof current.arguments.host === 'string' ? current.arguments.host : '';
  const egressPort =
    typeof current.arguments.port === 'number' ? current.arguments.port : null;

  return (
    <div
      className="overflow-hidden rounded-agent-lg border border-agent-border bg-agent-canvas text-xs text-agent-foreground shadow-xl"
      data-testid="approval-composer"
      onKeyDown={(e) => {
        if (isOutward && e.key === 'Escape') {
          e.preventDefault();
          onDecide('deny_once');
        }
      }}
    >
      <div
        className={`flex items-center gap-2 border-b px-3 py-2 ${
          isOutward
            ? 'border-rose-500/30 bg-rose-500/10'
            : 'border-agent-border'
        }`}
      >
        {isOutward ? (
          <LuFlag className="h-4 w-4 shrink-0 text-agent-destructive" aria-hidden="true" />
        ) : destructive ? (
          <LuTriangleAlert className="h-4 w-4 shrink-0 text-agent-destructive" />
        ) : (
          <LuShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-agent-foreground">
            {isOutward ? (
              <span data-testid="approval-outward-badge">
                {t('Outward submission · manual confirmation required every time')}
                <span className="mx-1 font-mono">{current.toolName}</span>
              </span>
            ) : isEgress ? (
              <>
                {t('Agent requests internet access')}
                <span className="mx-1 font-mono">
                  {egressHost}
                  {egressPort !== null ? `:${egressPort}` : ''}
                </span>
                {current.categoryLabel ? (
                  <span className="text-agent-muted-foreground">
                    {t('({category})', { category: categoryName(current.categoryLabel) })}
                  </span>
                ) : null}
              </>
            ) : isSandboxEscalation ? (
              <>
                {t('Agent requests to run a command outside the workspace')}
                {current.categoryLabel ? (
                  <span className="ml-1 text-agent-muted-foreground">
                    {t('({category})', { category: categoryName(current.categoryLabel) })}
                  </span>
                ) : null}
              </>
            ) : isBrowser && current.toolName === 'browser_navigate' ? (
              <>
                {t('Agent requests to open a page')}
                <span className="mx-1 font-mono">{current.toolName}</span>
                {current.categoryLabel ? (
                  <span className="text-agent-muted-foreground">
                    {t('({category})', { category: categoryName(current.categoryLabel) })}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                {t('Agent requests to run')}
                <span className="mx-1 font-mono">{current.toolName}</span>
                <span className="text-agent-muted-foreground">
                  {current.categoryLabel
                    ? t('({category})', { category: categoryName(current.categoryLabel) })
                    : t('({mode} action)', {
                        mode: MODE_LABEL[current.mode] ? t(MODE_LABEL[current.mode]) : current.mode,
                      })}
                </span>
              </>
            )}
          </div>
          {pendingCount > 0 && (
            <div className="mt-0.5 text-[11px] text-agent-muted-foreground">
              {t('{count} more awaiting approval', { count: pendingCount })}
            </div>
          )}
        </div>
      </div>

      <div className="max-h-48 overflow-auto px-3 py-2">
        <pre className="whitespace-pre-wrap break-all rounded-agent-md bg-agent-muted/50 px-3 py-2 font-mono text-xs text-agent-foreground">
          {summarizeArguments(current.arguments)}
        </pre>
        {isOutward ? (
          <p className="mt-2 text-[11px] leading-relaxed text-agent-muted-foreground">
            {t(
              'This action submits data to an external system or modifies authoritative records. Session and permanent auto-allow grants are disabled.',
            )}
          </p>
        ) : isEgress ? (
          <p className="mt-2 text-[11px] leading-relaxed text-agent-muted-foreground">
            {t(
              'This domain is not on the egress allowlist. Check the full spelling before allowing it (lookalike domains often use similar spellings, such as cdn.jsdelivr.net.evil.com). Allowing it applies only to this chat. To allow it permanently, add the domain to the egress allowlist in Settings.',
            )}
          </p>
        ) : isSandboxEscalation ? (
          <p className="mt-2 text-[11px] leading-relaxed text-agent-muted-foreground">
            {t(
              'The workspace sandbox blocked this command. Allowing it retries only this command, without limiting where it can write.',
            )}
          </p>
        ) : isBrowser ? (
          <p className="mt-2 text-[11px] leading-relaxed text-agent-muted-foreground">
            {t(
              'Opening pages, clicking, filling, and pressing keys act on that site and can send information off this computer. Scrolling, reading, and screenshots do not need approval.',
            )}
          </p>
        ) : outsideWorkspace ? (
          <p className="mt-2 text-[11px] leading-relaxed text-agent-muted-foreground">
            {current.outsideWorkspaceKind === 'workspace'
              ? cwd
                ? t(
                    'The command runs in the sandbox. Working directory {cwd} is outside this chat workspace, so writes there are blocked.',
                    { cwd },
                  )
                : t(
                    'The command runs in the sandbox. Its working directory is outside this chat workspace, so writes there are blocked.',
                  )
              : cwd
                ? t(
                    'The command runs in the sandbox. Working directory {cwd} is outside the project, so writes there are blocked. Add that directory as a project source folder when a write is required.',
                    { cwd },
                  )
                : t(
                    'The command runs in the sandbox. Its working directory is outside the project, so writes there are blocked. Add that directory as a project source folder when a write is required.',
                  )}
          </p>
        ) : (
          <>
            {current.category !== current.toolName && (
              <p className="mt-2 text-[11px] text-agent-muted-foreground">
                {t(
                  'Saved category: {category} (a chat or always decision applies to every call in this category)',
                  { category: current.category },
                )}
              </p>
            )}
            {!sandboxOff && (
              <p className="mt-2 text-[11px] leading-relaxed text-agent-muted-foreground">
                {t(
                  'Runs in the workspace sandbox. Writes outside it are blocked. To write outside, switch the sandbox to "Full access" and try again.',
                )}
              </p>
            )}
          </>
        )}
      </div>

      {isOutward ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-agent-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              ref={outwardRejectRef}
              type="button"
              data-testid="approval-deny_once"
              onClick={() => onDecide('deny_once')}
              className="rounded-agent-md border border-agent-border px-3 py-1.5 text-xs font-medium text-agent-foreground transition hover:bg-agent-muted"
            >
              {t('Reject this submission')}
            </button>
            <button
              type="button"
              data-testid="approval-abort"
              onClick={() => onDecide('abort')}
              className="rounded-agent-md bg-agent-destructive px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
            >
              {t('Abort this turn')}
            </button>
          </div>
          <button
            type="button"
            data-testid="approval-allow_once"
            onClick={() => onDecide('allow_once')}
            className="rounded-agent-md bg-agent-foreground px-3 py-1.5 text-xs font-medium text-agent-canvas transition hover:opacity-90"
          >
            {t('Approve this submission')}
          </button>
        </div>
      ) : (
        <div className="space-y-2 border-t border-agent-border px-3 py-2">
          <DecisionRow
            buttons={
              isEgress
                ? allowButtons(current).filter((b) => b.kind !== 'allow_always')
                : allowButtons(current)
            }
            onPick={onDecide}
          />
          <div className="flex items-center justify-between gap-2">
            <DecisionRow
              buttons={
                isEgress
                  ? DENY_BUTTONS.filter((b) => b.kind !== 'deny_always')
                  : DENY_BUTTONS
              }
              onPick={onDecide}
            />
            <button
              type="button"
              onClick={() => onDecide('abort')}
              className="shrink-0 rounded-agent-md bg-agent-destructive px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
              data-testid="approval-abort"
            >
              {t('Abort this turn')}
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-agent-muted-foreground">
            {isEgress
              ? t('With no action for about 3 minutes, the request is denied and that network access fails.')
              : t('"This chat" applies only to this chat. "Always" is saved on this computer and applies to every chat.')}
          </p>
        </div>
      )}
    </div>
  );
}

export default ApprovalPromptMenu;
