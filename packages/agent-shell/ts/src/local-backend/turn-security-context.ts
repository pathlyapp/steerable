/**
 * Authoritative in-memory turn security context & host activity tracker.
 *
 * `Principal` and `PackCredentialClient` stay inside the trusted Node host
 * process keyed by `chatId`; the sidecar/model never supplies or mutates
 * `principal`, preventing prompt-injected `args.principal` escalation.
 */
import type {
  OriginChannel,
  PackCredentialClient,
  Principal,
} from '@steerable/pack-sdk';
import { LOCAL_DEFAULT_PRINCIPAL } from '../auth/index.js';
import {
  SecretRedactor,
  defaultCredentialBroker,
} from '../auth/credentials.js';
import type { ScopedStore } from '../storage/scoped-store.js';

export interface ActiveTurnSecurityContext {
  readonly chatId: string;
  readonly principal: Principal;
  readonly originChannel: OriginChannel;
  readonly store: ScopedStore;
  readonly redactor: SecretRedactor;
  readonly credentials: PackCredentialClient;
  readonly startedAtMs: number;
}

const activeTurns = new Map<string, ActiveTurnSecurityContext>();
let lastActivityAtMs = Date.now();
let pendingApprovalsGetter: (() => number) | null = null;
let pendingQuestionsGetter: (() => number) | null = null;

export function touchHostActivity(): void {
  lastActivityAtMs = Date.now();
}

export function bindHostPendingCounters(counters: {
  pendingApprovals: () => number;
  pendingQuestions?: () => number;
}): void {
  pendingApprovalsGetter = counters.pendingApprovals;
  pendingQuestionsGetter = counters.pendingQuestions ?? null;
}

export function beginTurnSecurityContext(input: {
  chatId: string;
  principal?: Principal;
  originChannel?: OriginChannel;
  store: ScopedStore;
}): ActiveTurnSecurityContext {
  touchHostActivity();
  const principal = input.principal ?? LOCAL_DEFAULT_PRINCIPAL;
  const originChannel = input.originChannel ?? 'web';
  const redactor = new SecretRedactor();
  const credentials = defaultCredentialBroker.createClient(
    input.store,
    principal,
    redactor,
  );
  const ctx: ActiveTurnSecurityContext = {
    chatId: input.chatId,
    principal,
    originChannel,
    store: input.store,
    redactor,
    credentials,
    startedAtMs: Date.now(),
  };
  activeTurns.set(input.chatId, ctx);
  return ctx;
}

export function getTurnSecurityContext(
  chatId: string | undefined,
): ActiveTurnSecurityContext | undefined {
  if (!chatId) return undefined;
  return activeTurns.get(chatId);
}

export function endTurnSecurityContext(
  chatId: string,
  expected?: ActiveTurnSecurityContext,
): void {
  touchHostActivity();
  const current = activeTurns.get(chatId);
  if (!current) return;
  if (!expected || current === expected) {
    activeTurns.delete(chatId);
  }
}

export interface HostActivitySnapshot {
  readonly state: 'running_turn' | 'awaiting_human' | 'idle';
  readonly activeTurns: number;
  readonly pendingApprovals: number;
  readonly lastActivityAt: string;
}

export function getHostActivitySnapshot(overrides?: {
  readonly pendingApprovals?: number;
  readonly pendingReconciliations?: number;
}): HostActivitySnapshot {
  const runningCount = activeTurns.size;
  const approvals =
    (overrides?.pendingApprovals ??
      (pendingApprovalsGetter?.() ?? 0) + (pendingQuestionsGetter?.() ?? 0)) +
    (overrides?.pendingReconciliations ?? 0);
  const state: HostActivitySnapshot['state'] =
    runningCount > 0
      ? 'running_turn'
      : approvals > 0
        ? 'awaiting_human'
        : 'idle';
  return {
    state,
    activeTurns: runningCount,
    pendingApprovals: approvals,
    lastActivityAt: new Date(lastActivityAtMs).toISOString(),
  };
}
