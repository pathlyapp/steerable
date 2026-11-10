/**
 * Command-line text for a failed turn.
 *
 * Each failure gets one line saying what happened, one line with the exact
 * command that fixes it, and the raw provider text indented underneath. The
 * category comes from `@steerable/agent-protocol`, so this file says the same
 * thing the web failure card says.
 */

import { classifyErrorMessage, type TurnFailureKind } from '@steerable/agent-protocol';

/** Everything the CLI needs to describe one failure. */
export interface FailureReportInput {
  /** Backend-provided message; classified when no kind is known. */
  message: string;
  /** Provider failure class, when the event carried one. */
  kind?: TurnFailureKind;
  statusCode?: number;
  /** Provider name shown in parentheses, e.g. `DeepSeek`. */
  providerLabel: string;
  /** Host from the configured base URL, e.g. `api.deepseek.com`. */
  host: string;
  /** Chat id, so the fix line can be pasted as-is. */
  chatId?: string;
  /** Finished tool steps that a resumed turn will not repeat. */
  completedSteps?: number;
  /** Model id, for the "try another model" line. */
  model?: string;
  /** Where credentials came from, used to word the auth fix. */
  credentialSource?: 'config' | 'env' | 'none';
  /** Environment variable an auth failure should point at. */
  envName?: string;
}

/** Human-readable failure text, ready to write to stderr. */
export interface FailureReport {
  kind: TurnFailureKind;
  /** First line: what happened. */
  headline: string;
  /** Follow-up lines: what to do, each runnable or copy-pasteable. */
  fixes: string[];
  /** The provider's own text, for searching; indented by the caller. */
  detail: string;
}

/**
 * Builds the CLI's failure text.
 *
 * @param input Message, classification hints, and the settings the turn used.
 * @returns Headline, fix lines, and the raw detail.
 */
export function failureReport(input: FailureReportInput): FailureReport {
  const kind = input.kind ?? classifyErrorMessage(input.message);
  const resume = input.chatId
    ? `steerable-cli run --chat ${input.chatId} "继续"`
    : 'steerable-cli run "继续"';
  const steps = input.completedSteps ?? 0;
  const resumed = steps > 0 ? `已完成的 ${steps} 步不会重做。` : '';
  switch (kind) {
    case 'auth':
      return {
        kind,
        headline: `模型服务拒绝了 API key（${input.providerLabel}）。`,
        fixes:
          input.credentialSource === 'env' && input.envName
            ? [
                `检查环境变量：${input.envName}`,
                '或重新登录：steerable-cli login',
              ]
            : ['重新登录：steerable-cli login', '或在提供方控制台核对这个 key 是否已失效'],
        detail: input.message,
      };
    case 'transport':
      return {
        kind,
        headline: input.host ? `连不上模型服务（${input.host}）。` : '连不上模型服务。',
        fixes: [`检查网络或代理后继续：${resume}`, resumed].filter(Boolean),
        detail: input.message,
      };
    case 'rate_limit':
      return {
        kind,
        headline: '模型服务正在限流。',
        fixes: [`稍后继续：${resume}`, resumed].filter(Boolean),
        detail: input.message,
      };
    case 'server':
      return {
        kind,
        headline: input.statusCode ? `模型服务出错（HTTP ${input.statusCode}）。` : '模型服务出错。',
        fixes: [
          `稍后重试：${resume}`,
          input.model ? `持续出现时换模型：steerable-cli config set model <model>` : '持续出现时换一个模型。',
        ],
        detail: input.message,
      };
    case 'invalid_request':
      return {
        kind,
        headline: '模型服务拒绝了这次请求。',
        fixes: [
          '加 --verbose 重跑，把日志里的原始错误贴出来。',
          input.model ? `也可以换模型再试：steerable-cli config set model <model>` : '',
        ].filter(Boolean),
        detail: input.message,
      };
    case 'context_overflow':
      return {
        kind,
        headline: '对话已经超出模型的上下文长度。',
        fixes: ['新开一个会话：steerable-cli run "<任务>"', '或在 TUI 里用 /compact 压缩上下文'],
        detail: input.message,
      };
    default:
      return {
        kind,
        headline: '回合失败。',
        fixes: ['查看日志：~/.agent-shell/logs/main.log', '或加 --verbose 重跑，把原始错误贴出来'],
        detail: input.message,
      };
  }
}

/**
 * Renders a report as the lines the CLI writes to stderr.
 *
 * @param report The report to render.
 * @returns Headline, fix lines, then the raw detail indented by four spaces.
 */
export function failureLines(report: FailureReport): string[] {
  const detail = report.detail.trim();
  return [
    report.headline,
    ...report.fixes.map((line) => `  ${line}`),
    ...(detail ? [`    ${detail.replace(/^coreloop stream failed:\s*LoopError:\s*/i, '')}`] : []),
  ];
}
