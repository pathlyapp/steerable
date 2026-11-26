/**
 * Background title drift refresh via controlled `SideCallPort` guardrails (Phase 9 R7-3).
 *
 * Strictly preserves Phase 1 `title_source` ownership:
 * - Whenever `chat.titleSource === 'user'` (manually renamed by user), returns
 *   immediately with ZERO sidecall invocations and NEVER overwrites the title.
 * - For `chat.titleSource === 'auto'`, checks every `intervalAssistantTurns` (default 6)
 *   using scrubbed `2,000` head + `8,000` tail context and a `15s` hard timeout.
 */
import { SecretRedactor } from '../auth/credentials.js';
import type { ScopedStore } from '../storage/scoped-store.js';

export const TITLE_REFRESH_HEAD_CHARS = 2_000;
export const TITLE_REFRESH_TAIL_CHARS = 8_000;
export const TITLE_REFRESH_TIMEOUT_MS = 15_000;
export const TITLE_REFRESH_TURN_INTERVAL = 6;

export interface TitleDriftDecision {
  readonly drifted: boolean;
  readonly newTitle?: string;
}

export type TitleDriftEvaluator = (input: {
  readonly caller: 'sidecall:title_refresh';
  readonly currentTitle: string;
  readonly scrubbedHead: string;
  readonly scrubbedTail: string;
  readonly signal: AbortSignal;
}) => Promise<TitleDriftDecision>;

export async function maybeRefreshDriftedChatTitle(options: {
  readonly store: ScopedStore;
  readonly chatId: string;
  readonly evaluateDrift: TitleDriftEvaluator;
  readonly redactor?: SecretRedactor;
  readonly parentSignal?: AbortSignal;
  readonly intervalAssistantTurns?: number;
  readonly timeoutMs?: number;
}): Promise<{
  readonly updated: boolean;
  readonly skippedReason?: 'chat_not_found' | 'user_locked_title' | 'below_interval' | 'no_drift' | 'degraded';
  readonly title?: string;
}> {
  const chat = await options.store.getChat(options.chatId);
  if (!chat) {
    return { updated: false, skippedReason: 'chat_not_found' };
  }

  // Invariant (T-SC-05): user-renamed chats are NEVER touched or evaluated
  if (chat.titleSource === 'user') {
    return { updated: false, skippedReason: 'user_locked_title', title: chat.title };
  }

  const messages = await options.store.listMessages(options.chatId, 200);
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const interval = options.intervalAssistantTurns ?? TITLE_REFRESH_TURN_INTERVAL;
  if (assistantMessages.length < interval || assistantMessages.length % interval !== 0) {
    return { updated: false, skippedReason: 'below_interval', title: chat.title };
  }

  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const recentTailText = messages
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const redactor = options.redactor ?? new SecretRedactor();
  const scrubbedHead = redactor.redact(firstUser.slice(0, TITLE_REFRESH_HEAD_CHARS));
  const scrubbedTail = redactor.redact(recentTailText.slice(-TITLE_REFRESH_TAIL_CHARS));

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? TITLE_REFRESH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error('title_refresh_timeout')), timeoutMs);
  const onParentAbort = () => controller.abort(options.parentSignal?.reason);
  if (options.parentSignal) {
    if (options.parentSignal.aborted) {
      clearTimeout(timer);
      return { updated: false, skippedReason: 'degraded', title: chat.title };
    }
    options.parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const decision = await options.evaluateDrift({
      caller: 'sidecall:title_refresh',
      currentTitle: chat.title,
      scrubbedHead,
      scrubbedTail,
      signal: controller.signal,
    });
    const candidate = decision.newTitle?.trim();
    if (!decision.drifted || !candidate || candidate === chat.title) {
      return { updated: false, skippedReason: 'no_drift', title: chat.title };
    }
    // Re-check chat.titleSource right before writing in case user renamed concurrently
    const freshChat = await options.store.getChat(options.chatId);
    if (!freshChat || freshChat.titleSource === 'user') {
      return { updated: false, skippedReason: 'user_locked_title', title: freshChat?.title };
    }
    await options.store.updateChat(options.chatId, {
      title: candidate.slice(0, 80),
      titleSource: 'auto',
    });
    return { updated: true, title: candidate.slice(0, 80) };
  } catch {
    // Guardrail #4: silent fail-safe degradation
    return { updated: false, skippedReason: 'degraded', title: chat.title };
  } finally {
    clearTimeout(timer);
    options.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
