/**
 * Failed-turn presentation: what to say and what to offer, per failure kind.
 *
 * The backend classifies every provider failure (`LLMError.kind`) and records
 * it with the turn. Matching on that field — never on the message text — keeps
 * the copy stable while error strings change, and keeps untranslated exception
 * names out of the headline. The message itself belongs in the details
 * disclosure, which is for whoever reads it: the user reporting a problem and
 * the person on support.
 */

import { t } from '@/i18n';

export type FailureKind =
  | 'transport'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'invalid_request'
  | 'context_overflow'
  | 'unknown';

/** The provider classifications the backend can send. */
const KINDS: readonly FailureKind[] = [
  'transport',
  'rate_limit',
  'server',
  'auth',
  'invalid_request',
  'context_overflow',
  'unknown',
];

/** One action a failed turn can offer. */
export type FailureAction =
  | { kind: 'retry' }
  | { kind: 'network-diagnostics' }
  | { kind: 'open-model-settings' }
  | { kind: 'new-chat' };

/** Structured failure detail persisted with the turn (`messageMetadata.failure`). */
export interface TurnFailureDetail {
  kind: FailureKind;
  /** Proxy the failing request used, credentials already stripped. */
  proxy?: string;
  /** Provider attempts spent on the request, including the last. */
  attempts?: number;
  statusCode?: number;
}

/** Everything the card renders, derived from one failure. */
export interface FailurePresentation {
  title: string;
  body: string;
  /** The primary action: the most likely thing to fix this failure. */
  primary: FailureAction;
  secondary: FailureAction[];
  /** True when the details disclosure carries a classified cause. */
  classified: boolean;
}

/**
 * Narrows an unknown metadata value to a failure kind.
 *
 * Returns undefined for anything unrecognized — an older sidecar that sent
 * nothing, a value from a newer one, a corrupted record. The caller then shows
 * the generic card with the raw message, which is still actionable when the
 * only remedy is reporting it.
 */
export function readFailureKind(value: unknown): FailureKind | undefined {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? (value as FailureKind)
    : undefined;
}

/**
 * Copy and actions for one failure.
 *
 * The primary action is the one most likely to make the next attempt work:
 * a rejected key needs settings, an over-long conversation needs a fresh one,
 * and everything else is worth retrying once the cause clears. Actions whose
 * handler is unavailable at render time (`available`) are dropped by the card,
 * so this function can describe the ideal set without knowing the shell.
 */
export function failurePresentation(
  detail: TurnFailureDetail | undefined,
  options: { completedSteps?: number } = {},
): FailurePresentation {
  const steps = options.completedSteps ?? 0;
  const attempts = detail?.attempts;
  const retried =
    typeof attempts === 'number' && attempts > 1
      ? t('Retried {count} times. ', { count: attempts - 1 })
      : '';
  switch (detail?.kind) {
    case 'transport': {
      const next =
        steps > 0
          ? t(
              "When your network is back, select Continue. The {count} completed steps won't run again.",
              { count: steps },
            )
          : t('When your network is back, select Continue.');
      return {
        title: t("Can't reach the model service right now"),
        body: t('The connection kept dropping. ') + retried + next,
        primary: { kind: 'retry' },
        secondary: [{ kind: 'network-diagnostics' }],
        classified: true,
      };
    }
    case 'auth':
      return {
        title: t('The model service rejected the API key'),
        body: t('Check the API key in settings, then select Continue.'),
        primary: { kind: 'open-model-settings' },
        secondary: [{ kind: 'retry' }],
        classified: true,
      };
    case 'rate_limit':
      return {
        title: t('The model service is limiting requests'),
        body: t('Select Continue in a moment.'),
        primary: { kind: 'retry' },
        secondary: [],
        classified: true,
      };
    case 'server':
      return {
        title: t('The model service had an error'),
        body: t('Select Continue in a moment.'),
        primary: { kind: 'retry' },
        secondary: [],
        classified: true,
      };
    case 'context_overflow':
      return {
        title: t('This conversation is too long for the model'),
        body: t('Start a new chat, or select Regenerate to try a different approach.'),
        primary: { kind: 'new-chat' },
        secondary: [{ kind: 'retry' }],
        classified: true,
      };
    case 'invalid_request':
      return {
        title: t('The model service rejected this request'),
        body: t('Select Continue to try again, or copy the diagnostic info to report it.'),
        primary: { kind: 'retry' },
        secondary: [],
        classified: true,
      };
    default:
      return {
        title: t('Reply failed'),
        body: t('Select Continue to try again, or copy the diagnostic info to report it.'),
        primary: { kind: 'retry' },
        secondary: [],
        classified: false,
      };
  }
}

/** Reads the persisted failure block, dropping fields of the wrong type. */
export function readFailureDetail(value: unknown): TurnFailureDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = readFailureKind(record.errorKind);
  if (!kind) return undefined;
  const proxy =
    typeof record.proxy === 'string' && record.proxy ? record.proxy : undefined;
  const attempts =
    typeof record.attempts === 'number' && Number.isFinite(record.attempts)
      ? record.attempts
      : undefined;
  const statusCode =
    typeof record.statusCode === 'number' && Number.isFinite(record.statusCode)
      ? record.statusCode
      : undefined;
  return {
    kind,
    ...(proxy ? { proxy } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}
