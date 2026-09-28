import { LuShieldAlert, LuTriangleAlert } from 'react-icons/lu';
import {
  type ApprovalDecisionKind,
  type ApprovalPromptRequest,
} from '@/lib/host-bridge';
import { t } from '@/i18n';

/**
 * ApprovalPromptMenu — W4-1 审批代数的输入区 UI。
 *
 * 由 ApprovalPromptProvider 提供当前请求，在普通输入框的位置让用户对
 * 工具调用做 7 变体决策（允许/拒绝 × 一次性/会话/持久 + 中止）。
 *
 * 持久化语义（与框架 ApprovalExecutor 对齐）：
 *   - 一次性：只作用于本次调用，不缓存。
 *   - 会话：按 category（默认=工具名）缓存在本 chat 的会话级 cache。
 *   - 持久：写入 ~/.steerable/approvals.json，跨会话生效。
 *
 * 请求队列及刷新恢复由 Provider 管理。
 */

const MODE_LABEL: Record<string, string> = {
  read: 'Read only',
  safe_write: 'Write',
  destructive: 'Dangerous',
  other: 'Other',
};

function summarizeArguments(args: Record<string, unknown>): string {
  // 'url' 必须在前列：批准一次 web_fetch 就是批准一次出网请求，
  // 用户必须看清目标地址（W5-2）。
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

const ALLOW_BUTTONS: DecisionButton[] = [
  { kind: 'allow_once', label: 'Allow once', tone: 'allow' },
  { kind: 'allow_for_session', label: 'Allow for this chat', tone: 'allow' },
  { kind: 'allow_always', label: 'Always allow', tone: 'allow' },
];

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
  const destructive = current.mode === 'destructive';
  // 网络出口拓宽（W-egress-ask）：sidecar 的 web 工具被 egress 代理 403
  // 后发起。白名单是代理进程级的（会话寿命），所以「始终」变体对网络
  // 出口没有意义——只给一次性/会话两档，且默认焦点在拒绝（安全默认：
  // 用户能认出 api.github.com，认不出 cdn.jsdelivr.net.evil.com）。
  const isEgress = current.category === 'network_egress';
  const isSandboxEscalation = current.category === 'sandbox_escalation';
  const egressHost =
    typeof current.arguments.host === 'string' ? current.arguments.host : '';
  const egressPort =
    typeof current.arguments.port === 'number' ? current.arguments.port : null;

  return (
    <div
      className="overflow-hidden rounded-agent-lg border border-agent-border bg-agent-canvas text-xs text-agent-foreground shadow-xl"
      data-testid="approval-composer"
    >
        <div className="flex items-center gap-2 border-b border-agent-border px-3 py-2">
          {destructive ? (
            <LuTriangleAlert className="h-4 w-4 shrink-0 text-agent-destructive" />
          ) : (
            <LuShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-agent-foreground">
              {isEgress ? (
                <>
                  {t('Agent requests internet access')}
                  <span className="mx-1 font-mono">
                    {egressHost}
                    {egressPort !== null ? `:${egressPort}` : ''}
                  </span>
                </>
              ) : isSandboxEscalation ? (
                <>{t('Agent requests to run a command outside the workspace')}</>
              ) : (
                <>
                  {t('Agent requests to run')}
                  <span className="mx-1 font-mono">{current.toolName}</span>
                  <span className="text-agent-muted-foreground">
                    {t('({mode} action)', {
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
            {isEgress ? (
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
              <p className="mt-2 text-[11px] leading-relaxed text-agent-muted-foreground">
                {t(
                  'Runs in the workspace sandbox. Writes outside it are blocked. To write outside, switch the sandbox to "Full access" and try again.',
                )}
              </p>
            </>
          )}
        </div>

        <div className="space-y-2 border-t border-agent-border px-3 py-2">
          <DecisionRow
            buttons={
              isEgress
                ? ALLOW_BUTTONS.filter((b) => b.kind !== 'allow_always')
                : ALLOW_BUTTONS
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
              ? t(
                  '"This chat" decisions are remembered in this chat until the agent process exits. With no action for about 3 minutes, the request is denied.',
                )
              : t(
                  '"This chat" decisions are remembered in this chat. "Always" decisions are written to ~/.steerable/approvals.json on this computer and apply across chats. With no action for about 2 minutes, the request is denied.',
                )}
          </p>
        </div>
    </div>
  );
}

export default ApprovalPromptMenu;
