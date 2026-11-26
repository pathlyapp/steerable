/**
 * Snapshot-anchored memory injector (Phase 9 R8-2).
 *
 * Prefix KV-cache invariants:
 * 1. `system` prompt bytes remain 100% static — memory NEVER enters `system`.
 * 2. A `<untrusted_memory_note trust="untrusted">` snapshot is captured ONLY at
 *    session Turn 1 and immediately after a `CompactionBoundary` rewrite (`compactionEpoch` bump).
 * 3. Mid-session writes, renewals, or withdrawals NEVER mutate the anchored turn-1
 *    snapshot message; instead, they append a single `[memory delta] ...` line
 *    immediately before the latest user message on the next turn.
 * 4. Tracks `memoryContributed` per chat so `insights` telemetry automatically
 *    strips free-text transcripts whenever private memory entered a session.
 */
import { LOCAL_DEFAULT_PRINCIPAL, type Principal } from '../auth/index.js';
import {
  MemoryStore,
  TENANT_INJECT_BUDGET_BYTES,
  USER_INJECT_BUDGET_BYTES,
  WORKSPACE_INJECT_BUDGET_BYTES,
} from './store.js';

interface AnchoredSessionMemory {
  snapshotBlock: string;
  compactionEpoch: number;
  pendingDeltas: string[];
  memoryContributed: boolean;
}

const sessionMemoryMap = new Map<string, AnchoredSessionMemory>();

export interface MemoryTurnInjection {
  /** Immutable snapshot block for the session's initial user prefix (empty if no memory). */
  readonly anchoredPrefixNote: string;
  /** Tail delta lines for mid-session edits/withdrawals since last turn (empty on turn 1). */
  readonly tailDeltaNotice: string;
  /** True if any non-empty memory entered this chat session. */
  readonly memoryContributed: boolean;
}

export async function buildMemoryTurnInjection(options: {
  readonly memoryStore: MemoryStore;
  readonly chatId: string;
  readonly principal?: Principal;
  readonly workspaceId?: string;
  readonly compactionEpoch?: number;
  readonly nowMs?: number;
}): Promise<MemoryTurnInjection> {
  const mode = await options.memoryStore.getPermissionMode();
  const epoch = options.compactionEpoch ?? 0;
  const existing = sessionMemoryMap.get(options.chatId);

  if (mode === 'off') {
    return {
      anchoredPrefixNote: '',
      tailDeltaNotice: '',
      memoryContributed: existing?.memoryContributed ?? false,
    };
  }

  // Reuse frozen snapshot mid-session unless CompactionBoundary bumped `compactionEpoch`
  if (existing && existing.compactionEpoch === epoch) {
    const deltas = existing.pendingDeltas.splice(0, existing.pendingDeltas.length);
    const tailDeltaNotice = deltas.length > 0 ? deltas.join('\n') : '';
    return {
      anchoredPrefixNote: existing.snapshotBlock,
      tailDeltaNotice,
      memoryContributed: existing.memoryContributed,
    };
  }

  const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
  const workspaceId = options.workspaceId || 'default';

  const [tenantMd, workspaceMd, userMd] = await Promise.all([
    options.memoryStore.renderVisibleMarkdownForScope({
      scope: 'tenant',
      scopeId: principal.tenantId,
      principal,
      budgetBytes: TENANT_INJECT_BUDGET_BYTES,
      nowMs: options.nowMs,
    }),
    options.memoryStore.renderVisibleMarkdownForScope({
      scope: 'workspace',
      scopeId: workspaceId,
      principal,
      budgetBytes: WORKSPACE_INJECT_BUDGET_BYTES,
      nowMs: options.nowMs,
    }),
    options.memoryStore.renderVisibleMarkdownForScope({
      scope: 'user',
      scopeId: principal.id,
      principal,
      budgetBytes: USER_INJECT_BUDGET_BYTES,
      nowMs: options.nowMs,
    }),
  ]);

  const sections: string[] = [];
  if (tenantMd) sections.push(`## Tenant shared rules\n${tenantMd}`);
  if (workspaceMd) sections.push(`## Workspace memory\n${workspaceMd}`);
  if (userMd) sections.push(`## Personal preferences\n${userMd}`);

  const snapshotBlock =
    sections.length > 0
      ? `<untrusted_memory_note trust="untrusted">\n${sections.join('\n\n')}\n</untrusted_memory_note>`
      : '';

  const contributed = Boolean(snapshotBlock) || (existing?.memoryContributed ?? false);
  sessionMemoryMap.set(options.chatId, {
    snapshotBlock,
    compactionEpoch: epoch,
    pendingDeltas: [],
    memoryContributed: contributed,
  });

  return {
    anchoredPrefixNote: snapshotBlock,
    tailDeltaNotice: '',
    memoryContributed: contributed,
  };
}

export function recordMidSessionMemoryDelta(chatId: string | undefined, deltaSummary: string): void {
  if (!chatId) return;
  const entry = sessionMemoryMap.get(chatId);
  const formatted = deltaSummary.startsWith('[memory delta]')
    ? deltaSummary
    : `[memory delta] ${deltaSummary}`;
  if (entry) {
    entry.pendingDeltas.push(formatted);
    entry.memoryContributed = true;
  } else {
    sessionMemoryMap.set(chatId, {
      snapshotBlock: '',
      compactionEpoch: 0,
      pendingDeltas: [formatted],
      memoryContributed: true,
    });
  }
}

export function didChatContributeMemory(chatId: string): boolean {
  return sessionMemoryMap.get(chatId)?.memoryContributed === true;
}

export function resetMemorySnapshotsForTests(): void {
  sessionMemoryMap.clear();
}
