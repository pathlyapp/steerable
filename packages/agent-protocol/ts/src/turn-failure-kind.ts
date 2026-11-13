/**
 * Failure classification shared by every surface that has to explain a failed
 * turn: the web failure card and the command line.
 *
 * Lives in Tier 1 because the browser bundle cannot import the host client,
 * and both surfaces must classify a failure the same way.
 *
 * The backend classifies provider failures (`LLMError.kind`) and records the
 * value with the turn. Matching on that field — never on message text — keeps
 * wording stable while error strings change. Each surface owns its own copy;
 * this module owns only the vocabulary and the reader.
 */

/** One provider failure class the backend can record. */
export type TurnFailureKind =
  | 'transport'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'invalid_request'
  | 'context_overflow'
  | 'unknown';

/** Every kind, in the order diagnostics list them. */
export const TURN_FAILURE_KINDS: readonly TurnFailureKind[] = [
  'transport',
  'rate_limit',
  'server',
  'auth',
  'invalid_request',
  'context_overflow',
  'unknown',
];

/** Structured failure detail persisted with a turn (`messageMetadata.failure`). */
export interface TurnFailureDetail {
  kind: TurnFailureKind;
  /** Proxy the failing request used, credentials already stripped. */
  proxy?: string;
  /** Provider attempts spent on the request, including the last. */
  attempts?: number;
  statusCode?: number;
}

/**
 * Narrows an unknown metadata value to a failure kind.
 *
 * Returns undefined for anything unrecognized — an older sidecar that sent
 * nothing, a value from a newer one, a corrupted record — so the caller can
 * fall back to a generic message instead of inventing a cause.
 *
 * @param value Raw `errorKind` metadata.
 * @returns The kind, or undefined.
 */
export function readTurnFailureKind(value: unknown): TurnFailureKind | undefined {
  return typeof value === 'string' && (TURN_FAILURE_KINDS as readonly string[]).includes(value)
    ? (value as TurnFailureKind)
    : undefined;
}

/**
 * Reads the persisted failure block, dropping fields of the wrong type.
 *
 * @param value Raw `messageMetadata.failure`.
 * @returns The detail, or undefined when no usable kind is present.
 */
export function readTurnFailureDetail(value: unknown): TurnFailureDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = readTurnFailureKind(record.errorKind);
  if (!kind) return undefined;
  const proxy = typeof record.proxy === 'string' && record.proxy ? record.proxy : undefined;
  const attempts =
    typeof record.attempts === 'number' && Number.isFinite(record.attempts) ? record.attempts : undefined;
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

/**
 * Classifies a raw error message that arrived without backend metadata.
 *
 * Only the command line needs this: the sidecar reports some failures as a
 * plain message (a transport error before the turn starts), and a wall of
 * provider text is not an answer. Web cards always have metadata.
 *
 * @param message Raw error text.
 * @returns The best kind for that text; `unknown` when nothing matches.
 */
export function classifyErrorMessage(message: string): TurnFailureKind {
  const text = message.toLowerCase();
  if (/\b(401|403)\b|unauthor|invalid[ _-]?api[ _-]?key|authentication fail|incorrect api key/.test(text)) {
    return 'auth';
  }
  if (/\b429\b|rate[ _-]?limit|too many requests|quota exceeded/.test(text)) return 'rate_limit';
  if (/context[ _-]?(length|window)|too many tokens|maximum context/.test(text)) return 'context_overflow';
  if (/\b(400|404|422)\b|invalid[ _-]?request|bad request/.test(text)) return 'invalid_request';
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable/.test(text)) return 'server';
  if (
    /econnrefused|econnreset|enotfound|etimedout|socket hang up|network|fetch failed|connection (kept )?(dropping|reset|refused)/.test(
      text,
    )
  ) {
    return 'transport';
  }
  if (/overloaded|governor/.test(text)) return 'server';
  return 'unknown';
}
