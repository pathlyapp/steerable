import type { ApprovalDecisionKind } from '@steerable/agent-client';

import { cliText } from './copy.js';

export type ApprovePolicy = 'deny' | 'allow-read' | 'allow-all';
export type ApprovalSurface = 'run' | 'tui';

export interface ApprovalSpec {
  policy: ApprovePolicy | 'ask';
  answerAsk: boolean;
}

export function resolveApprovalRequest(
  raw: string | undefined,
  surface: ApprovalSurface,
): ApprovalSpec | null {
  if (raw === undefined) {
    return surface === 'tui'
      ? { policy: 'ask', answerAsk: false }
      : { policy: 'deny', answerAsk: false };
  }
  if (raw !== 'deny' && raw !== 'allow-read' && raw !== 'allow-all') return null;
  return { policy: raw, answerAsk: raw === 'allow-all' };
}

export function parseApprovePolicy(raw: string | undefined): ApprovePolicy | null {
  const spec = resolveApprovalRequest(raw, 'run');
  if (!spec || spec.policy === 'ask') return null;
  return spec.policy;
}

/**
 * `mode` is the declared tool mode. A missing mode is not treated as read.
 * `prompt` means the TUI should show the card.
 */
export function decisionFor(
  spec: ApprovalSpec,
  prompt: { mode?: string },
  surface: ApprovalSurface,
): ApprovalDecisionKind | 'prompt' {
  if (spec.policy === 'allow-all') return 'allow_once';
  if (spec.policy === 'ask') return 'prompt';
  if (spec.policy === 'allow-read' && prompt.mode === 'read') return 'allow_once';
  if (spec.policy === 'allow-read' && surface === 'tui') return 'prompt';
  return 'deny_once';
}

/** The sidecar copies this reason onto the stored tool row as `approval.auto`. */
export const UNATTENDED_APPROVAL_REASON = 'unattended';

export function unattendedAskText(): string {
  return cliText('ask.unattended');
}

export function autoAnswer(questions: { id: string }[], text = unattendedAskText()): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions) answers[question.id] = text;
  return answers;
}

export function denied(kind: ApprovalDecisionKind): boolean {
  return kind === 'deny_once' || kind === 'deny_for_session' || kind === 'deny_always' || kind === 'abort';
}
