/**
 * W4-1 reverse channel: serve the sidecar-hosted CoreLoop's
 * `approval.request` calls by asking the desktop user (Electron renderer
 * modal) and returning the 7-variant decision.
 *
 * Fail-closed by construction: no window, no listener, a renderer error,
 * or an invalid reply all become `deny_once` — never a hang, never an
 * auto-allow. A command on the dangerous-command list is the exception:
 * the bridge returns `allow_once` without a card so the executor can
 * reject it with the blocked-command error. An explicit `timeoutMs` on
 * the approval config still fails closed as `timed_out`; the desktop
 * omits it, so the prompt waits until the user decides.
 *
 * The renderer answers via the `approval:decide` invoke with the requestId
 * echoed back; decisions are validated against the algebra's kind set
 * before crossing back to the sidecar.
 */

import { randomUUID } from 'node:crypto';
import type { SidecarReverseHandler } from './types.js';

/**
 * The approval algebra's decision variants (mirrors
 * `steerable_agent_runtime.approval.APPROVAL_KINDS`). `timed_out` is
 * synthesized by the sidecar on timeout, never by the UI.
 */
export const APPROVAL_DECISION_KINDS = [
  'allow_once',
  'allow_for_session',
  'allow_always',
  'deny_once',
  'deny_for_session',
  'deny_always',
  'abort',
] as const;

export type ApprovalDecisionKind = (typeof APPROVAL_DECISION_KINDS)[number];

export interface ApprovalPromptRequest {
  /** Correlation id echoed back by the renderer's `approval:decide`. */
  requestId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  mode: string;
  category: string;
  round: number;
  /** Chat that asked. The renderer only shows the card in that composer. */
  chatId?: string;
  /** Localized category name. Absent when the category is the tool name. */
  categoryLabel?: string;
  /** Shell cwd is outside the chat project's writable folders. */
  outsideWorkspace?: boolean;
  /**
   * `workspace` when the chat has no project and the cwd is outside the
   * conversation workspace. Absent means the project sentence.
   */
  outsideWorkspaceKind?: 'workspace';
  /**
   * Live command sandbox. `false` means the card must not say writes are
   * blocked. Absent keeps that sentence for an older sidecar.
   */
  sandboxEnforced?: boolean;
}

interface PendingApproval {
  prompt: ApprovalPromptRequest;
  resolve: (decision: { kind: ApprovalDecisionKind; reason: string }) => void;
}

export interface ApprovalBridgeDeps {
  /**
   * Push the prompt to all renderer windows (main.ts wires
   * `webContents.send('approval:request', …)`). Returning false/undefined
   * means no window was available → fail closed.
   */
  broadcast: (channel: 'approval:request', payload: ApprovalPromptRequest) => void;
  /** True when at least one renderer window can receive the prompt. */
  hasWindow: () => boolean;
  onLog?: (line: string) => void;
  /** Localized category name from the tool declaration or the shell dictionary. */
  categoryLabel?: (toolName: string, category: string) => string | undefined;
  /**
   * Whether a shell cwd sits outside the writable root.
   * `true` and `'project'` use the project sentence. `'workspace'` uses the
   * conversation-workspace sentence. `false` adds no outside-cwd sentence.
   */
  outsideWorkspace?: (input: {
    toolName: string;
    arguments: Record<string, unknown>;
    chatId?: string;
  }) => boolean | 'project' | 'workspace' | Promise<boolean | 'project' | 'workspace'>;
  /**
   * Pattern that will block this command in the executor.
   * When set, the bridge does not show a card.
   */
  blockedCommand?: (toolName: string, args: Record<string, unknown>) => string | null;
  /**
   * An allowed network_egress grant is not a tool result. The host stores it
   * on the running turn so the row survives reopening the chat.
   */
  recordEgressGrant?: (
    prompt: ApprovalPromptRequest,
    decision: { kind: ApprovalDecisionKind; reason: string },
  ) => void;
}

export interface ApprovalBridge {
  /** Reverse-channel handler for the sidecar's `approval.request`. */
  handler: SidecarReverseHandler;
  /** Requests still awaiting a renderer decision, used after page refresh. */
  pending: () => ApprovalPromptRequest[];
  /**
   * IPC entry point for the renderer's answer (`ipcMain.handle(
   * 'approval:decide')`). Unknown requestIds are dropped (late answer to an
   * already-settled prompt).
   */
  decide: (payload: unknown) => { ok: boolean };
}

export function createApprovalBridge(deps: ApprovalBridgeDeps): ApprovalBridge {
  const pending = new Map<string, PendingApproval>();

  const deny = (reason: string) => ({ kind: 'deny_once' as const, reason });

  return {
    handler: async (params) => {
      const p = (params ?? {}) as Partial<ApprovalPromptRequest>;
      const toolName = typeof p.toolName === 'string' ? p.toolName : '';
      if (!toolName) {
        return { kind: 'deny_once', reason: 'malformed approval request (no toolName)' };
      }
      const args =
        p.arguments && typeof p.arguments === 'object'
          ? (p.arguments as Record<string, unknown>)
          : {};
      if (deps.blockedCommand?.(toolName, args)) {
        deps.onLog?.(`approval: ${toolName} matches the dangerous-command list; no card`);
        return { kind: 'allow_once', reason: '' };
      }
      if (!deps.hasWindow()) {
        deps.onLog?.(`approval: no renderer window; denying ${toolName} once`);
        return deny('no renderer window available to approve the call');
      }
      const requestId = randomUUID();
      const chatId = typeof p.chatId === 'string' && p.chatId ? p.chatId : undefined;
      const category = typeof p.category === 'string' ? p.category : toolName;
      const categoryLabel = deps.categoryLabel?.(toolName, category);
      const fence = deps.outsideWorkspace
        ? await deps.outsideWorkspace({ toolName, arguments: args, ...(chatId ? { chatId } : {}) })
        : false;
      const outsideWorkspace = fence === true || fence === 'project' || fence === 'workspace';
      const prompt: ApprovalPromptRequest = {
        requestId,
        toolName,
        arguments: args,
        mode: typeof p.mode === 'string' ? p.mode : 'other',
        category,
        round: typeof p.round === 'number' ? p.round : 0,
        ...(chatId ? { chatId } : {}),
        ...(categoryLabel ? { categoryLabel } : {}),
        ...(outsideWorkspace ? { outsideWorkspace: true } : {}),
        ...(fence === 'workspace' ? { outsideWorkspaceKind: 'workspace' as const } : {}),
        ...(typeof p.sandboxEnforced === 'boolean' ? { sandboxEnforced: p.sandboxEnforced } : {}),
      };
      deps.onLog?.(`approval: prompting for ${toolName} (${prompt.mode}/${prompt.category})`);
      return await new Promise((resolve) => {
        pending.set(requestId, { prompt, resolve });
        try {
          deps.broadcast('approval:request', prompt);
        } catch (err) {
          pending.delete(requestId);
          resolve(deny(`approval prompt failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    },

    pending: () => Array.from(pending.values(), ({ prompt }) => prompt),

    decide: (payload) => {
      const p = (payload ?? {}) as {
        requestId?: unknown;
        kind?: unknown;
        reason?: unknown;
      };
      const requestId = typeof p.requestId === 'string' ? p.requestId : '';
      const entry = pending.get(requestId);
      if (!entry) return { ok: false };
      pending.delete(requestId);
      const kind = APPROVAL_DECISION_KINDS.find((k) => k === p.kind);
      if (!kind) {
        entry.resolve(deny(`renderer returned an invalid decision kind: ${String(p.kind)}`));
        return { ok: true };
      }
      const reason = typeof p.reason === 'string' ? p.reason : '';
      entry.resolve({ kind, reason });
      if (
        entry.prompt.toolName === 'network_egress'
        && (kind === 'allow_once' || kind === 'allow_for_session' || kind === 'allow_always')
      ) {
        try {
          deps.recordEgressGrant?.(entry.prompt, { kind, reason });
        } catch (err) {
          deps.onLog?.(`approval: failed to store egress grant: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { ok: true };
    },
  };
}
