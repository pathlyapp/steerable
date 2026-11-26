/**
 * State Ownership Projection Reconciliation & Pin Invariants (R2-1).
 *
 * Implements the rules documented in `docs/spec/state-ownership.md`:
 *  1. Sidecar `sessions.db` is authoritative for turn history (`LedgerTurnEntry[]`);
 *     host `chat_messages` is a projection that backfills missing entries on
 *     reconnect without duplicating already-projected turns.
 *  2. Session `Pin` bindings (`workspaceRoot`, `agentId`, `applicationId`) are
 *     captured at session creation and never drift when global defaults change.
 */
import type { ScopedStore } from '../storage/scoped-store.js';

export interface LedgerHistoryItem {
  readonly ledgerSeq: number;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PinnedSessionSpec {
  readonly workspaceRoot: string | null;
  readonly agentId: string;
  readonly applicationId: string;
  readonly pinnedAt: string;
}

/**
 * Reconciles host `chat_messages` projection against authoritative sidecar
 * ledger items (`sessions.db`). Missing items are appended in `ledgerSeq`
 * order with `ledgerSeq` recorded in `message_metadata`.
 */
export async function reconcileChatProjectionFromLedger(
  store: ScopedStore,
  chatId: string,
  ledgerItems: readonly LedgerHistoryItem[],
): Promise<{ backfilledCount: number; totalProjected: number }> {
  const existing = await store.listMessages(chatId);
  const seenLedgerSeqs = new Set<number>();
  const existingUserAssistantPairs = new Set<string>();

  for (const msg of existing) {
    if (msg.messageMetadata) {
      try {
        const parsed = JSON.parse(msg.messageMetadata) as { ledgerSeq?: unknown };
        if (typeof parsed.ledgerSeq === 'number') {
          seenLedgerSeqs.add(parsed.ledgerSeq);
        }
      } catch {
        // Ignore malformed legacy metadata
      }
    }
    existingUserAssistantPairs.add(`${msg.role}\u0000${msg.content}`);
  }

  const sorted = [...ledgerItems].sort((a, b) => a.ledgerSeq - b.ledgerSeq);
  let backfilledCount = 0;

  for (const item of sorted) {
    if (seenLedgerSeqs.has(item.ledgerSeq)) continue;
    // Avoid duplicating pre-existing messages written before crash without ledgerSeq
    if (
      seenLedgerSeqs.size === 0 &&
      existingUserAssistantPairs.has(`${item.role}\u0000${item.content}`)
    ) {
      existingUserAssistantPairs.delete(`${item.role}\u0000${item.content}`);
      continue;
    }
    const mergedMeta = {
      ...(item.metadata ?? {}),
      ledgerSeq: item.ledgerSeq,
      reconciledFromLedger: true,
    };
    await store.addMessage(
      chatId,
      item.role,
      item.content,
      JSON.stringify(mergedMeta),
    );
    seenLedgerSeqs.add(item.ledgerSeq);
    backfilledCount += 1;
  }

  return {
    backfilledCount,
    totalProjected: existing.length + backfilledCount,
  };
}

/**
 * Captures or reads the immutable `PinnedSessionSpec` for `chatId` so subsequent
 * changes to global default agent or active application never mutate an existing
 * session's bound environment (`Pin` category in `state-ownership.md`).
 */
export async function ensurePinnedSessionSpec(
  store: ScopedStore,
  chatId: string,
  globalDefaults: {
    readonly workspaceRoot?: string | null;
    readonly defaultAgentId: string;
    readonly activeApplicationId: string;
  },
): Promise<PinnedSessionSpec> {
  const key = `chat_pin:${chatId}`;
  if (typeof store.getCustomSetting === 'function') {
    const raw = await store.getCustomSetting(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PinnedSessionSpec;
        if (parsed && typeof parsed.agentId === 'string' && typeof parsed.applicationId === 'string') {
          return Object.freeze(parsed);
        }
      } catch {
        // Re-pin if corrupted
      }
    }
  }
  const chat = await store.getChat(chatId);
  const pinned: PinnedSessionSpec = Object.freeze({
    workspaceRoot: globalDefaults.workspaceRoot ?? null,
    agentId: chat?.agentId ?? globalDefaults.defaultAgentId,
    applicationId: globalDefaults.activeApplicationId,
    pinnedAt: new Date().toISOString(),
  });
  if (typeof store.setCustomSetting === 'function') {
    await store.setCustomSetting(key, JSON.stringify(pinned));
  }
  return pinned;
}
