import type { ApprovalDecisionKind } from '@steerable/agent-client';

export type ApprovePolicy = 'deny' | 'allow-read' | 'allow-all';

const READ_TOOLS = new Set([
  'local_read_file',
  'local_list_scripts',
  'web_search',
  'web_fetch',
]);

export function parseApprovePolicy(raw: string | undefined): ApprovePolicy | null {
  if (raw === undefined || raw === 'deny' || raw === 'allow-read' || raw === 'allow-all') {
    return raw ?? 'deny';
  }
  return null;
}

/** Headless answer for one approval prompt. Denied read-policy calls still exit 3. */
export function decisionFor(
  policy: ApprovePolicy,
  prompt: { toolName?: string; category?: string },
): ApprovalDecisionKind {
  if (policy === 'allow-all') return 'allow_once';
  const toolName = prompt.toolName ?? '';
  const category = prompt.category ?? '';
  if (policy === 'allow-read' && (category === 'read' || READ_TOOLS.has(toolName))) return 'allow_once';
  return 'deny_once';
}

export function denied(kind: ApprovalDecisionKind): boolean {
  return kind === 'deny_once' || kind === 'deny_for_session' || kind === 'deny_always' || kind === 'abort';
}
