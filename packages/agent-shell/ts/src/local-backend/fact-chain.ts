/**
 * Read-only Execution Provenance (`FactChainGraph`) assembler (R5-2).
 *
 * Reconstructs `requestNode -> toolNodes[] -> deliverableNode` strictly from
 * authoritative host/ledger records without fabricating citations from assistant
 * prose:
 *  - Missing request snapshot (e.g., imported legacy transcript) -> `status: 'gap'`
 *  - Zero tool calls in the turn -> `evidenceStatus: 'no_tool_evidence'`
 *  - Verified deliverable -> compares live workspace file SHA-256 against archived
 *    `snapshotSha256` to report `'unchanged' | 'modified' | 'deleted'`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { ensurePhase9Store } from '../storage/fde-fallback.js';
import type { ChatDeliverableRecord } from '../storage/fde-types.js';
import type { ScopedStore } from '../storage/scoped-store.js';

export interface FactChainGraphDto {
  readonly chatId: string;
  readonly targetKind: 'message' | 'tool' | 'deliverable';
  readonly targetId: string;
  readonly requestNode: {
    readonly status: 'recorded' | 'gap';
    readonly model?: string;
    readonly policyDigest?: string;
    readonly systemPromptSummary?: string;
    readonly attachmentHashes?: readonly string[];
    readonly gapReason?: string;
  };
  readonly evidenceStatus: 'recorded' | 'no_tool_evidence' | 'gap';
  readonly toolNodes: readonly {
    readonly id: string;
    readonly toolName: string;
    readonly argsSummary: string;
    readonly status: 'executed' | 'outcome_unknown' | 'failed';
    readonly durationMs?: number;
  }[];
  readonly deliverableNode?: {
    readonly id: string;
    readonly fileName: string;
    readonly filePath: string;
    readonly verificationStatus: 'verified' | 'warnings' | 'failed' | 'unverified';
    readonly verifierSummary?: string | null;
    readonly snapshotSha256: string;
    readonly workspaceState: 'unchanged' | 'modified' | 'deleted';
    readonly snapshotDownloadUrl?: string | null;
  } | null;
}

async function computeFileSha256OrNull(filePath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(filePath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

async function buildDeliverableNode(
  chatId: string,
  deliv: ChatDeliverableRecord,
): Promise<NonNullable<FactChainGraphDto['deliverableNode']>> {
  const liveHash = await computeFileSha256OrNull(deliv.filePath);
  const workspaceState: 'unchanged' | 'modified' | 'deleted' =
    liveHash === null
      ? 'deleted'
      : liveHash === deliv.sha256
        ? 'unchanged'
        : 'modified';
  return {
    id: deliv.id,
    fileName: deliv.fileName,
    filePath: deliv.filePath,
    verificationStatus: deliv.verificationStatus,
    verifierSummary: deliv.summary,
    snapshotSha256: deliv.sha256,
    workspaceState,
    snapshotDownloadUrl: deliv.reportPath
      ? `/api/v2/chats/${encodeURIComponent(chatId)}/deliverables/${encodeURIComponent(deliv.id)}/snapshot`
      : null,
  };
}

export async function assembleFactChainGraph(options: {
  readonly store: ScopedStore;
  readonly chatId: string;
  readonly targetKind: 'message' | 'tool' | 'deliverable';
  readonly targetId: string;
}): Promise<FactChainGraphDto> {
  const p9 = ensurePhase9Store(options.store);
  const messages = await options.store.listMessages(options.chatId, 200);
  const deliverables = await p9.listChatDeliverables(options.chatId);

  let matchedDeliverable: ChatDeliverableRecord | undefined;
  if (options.targetKind === 'deliverable') {
    matchedDeliverable = deliverables.find((d) => d.id === options.targetId);
  }

  let matchedMessage =
    options.targetKind === 'message'
      ? messages.find((m) => m.id === options.targetId)
      : matchedDeliverable?.messageId
        ? messages.find((m) => m.id === matchedDeliverable!.messageId)
        : undefined;

  if (!matchedMessage && options.targetKind === 'tool') {
    matchedMessage = messages.find((m) => {
      if (!m.messageMetadata) return false;
      return m.messageMetadata.includes(options.targetId);
    });
  }
  if (!matchedMessage) {
    matchedMessage = messages.find((m) => m.role === 'assistant');
  }

  if (!matchedDeliverable && matchedMessage) {
    matchedDeliverable =
      deliverables.find((d) => d.messageId === matchedMessage!.id) ?? deliverables[0];
  }

  let meta: Record<string, unknown> | null = null;
  if (matchedMessage?.messageMetadata) {
    try {
      const parsed: unknown = JSON.parse(matchedMessage.messageMetadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      meta = null;
    }
  }

  const importedWithoutSnapshot =
    !meta ||
    meta.imported === true ||
    (meta.model === undefined &&
      meta.traceId === undefined &&
      meta.executedActions === undefined &&
      meta.policyDigest === undefined);

  const requestNode: FactChainGraphDto['requestNode'] = importedWithoutSnapshot
    ? {
        status: 'gap',
        gapReason: 'imported_without_request_snapshot',
      }
    : {
        status: 'recorded',
        ...(typeof meta?.model === 'string' ? { model: meta.model } : {}),
        ...(typeof meta?.policyDigest === 'string'
          ? { policyDigest: meta.policyDigest }
          : {}),
        ...(Array.isArray(meta?.attachmentHashes)
          ? {
              attachmentHashes: meta.attachmentHashes.filter(
                (h): h is string => typeof h === 'string',
              ),
            }
          : {}),
      };

  const rawActions = Array.isArray(meta?.executedActions)
    ? (meta!.executedActions as Array<Record<string, unknown>>)
    : [];

  const toolNodes: FactChainGraphDto['toolNodes'] = rawActions.map((act, idx) => {
    const id = typeof act.id === 'string' && act.id ? act.id : `tool_${idx + 1}`;
    const toolName = String(act.tool ?? act.name ?? 'unknown');
    const argsSummary = act.arguments ? JSON.stringify(act.arguments).slice(0, 200) : '';
    const isUnknown =
      act.outcomeUnknown === true ||
      (typeof act.error === 'string' && act.error.includes('outcome_unknown'));
    const status: 'executed' | 'outcome_unknown' | 'failed' = isUnknown
      ? 'outcome_unknown'
      : act.success === false
        ? 'failed'
        : 'executed';
    return {
      id,
      toolName,
      argsSummary,
      status,
      ...(typeof act.durationMs === 'number' ? { durationMs: act.durationMs } : {}),
    };
  });

  const evidenceStatus: FactChainGraphDto['evidenceStatus'] =
    importedWithoutSnapshot && toolNodes.length === 0
      ? 'gap'
      : toolNodes.length === 0
        ? 'no_tool_evidence'
        : 'recorded';

  const deliverableNode = matchedDeliverable
    ? await buildDeliverableNode(options.chatId, matchedDeliverable)
    : null;

  return {
    chatId: options.chatId,
    targetKind: options.targetKind,
    targetId: options.targetId,
    requestNode,
    evidenceStatus,
    toolNodes,
    deliverableNode,
  };
}
