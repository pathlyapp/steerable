const REJECTED_BEFORE_EFFECT_BRAND: unique symbol = Symbol('steerable.RejectedBeforeEffect');

export class RejectedBeforeEffectError extends Error {
  readonly [REJECTED_BEFORE_EFFECT_BRAND] = true;
  readonly code: string;
  readonly retryable: boolean;

  private constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = 'RejectedBeforeEffectError';
    this.code = code;
    this.retryable = retryable;
  }

  /**
   * Framework-internal factory for pre-dispatch rejections (schema validation,
   * approval denial, sandbox pre-check, path confinement, reconciliation lock).
   * Never exported from `@steerable/pack-sdk` so tool handlers cannot forge
   * `effect: 'none'` after executing external side effects.
   */
  static create(code: string, message: string, retryable = true): RejectedBeforeEffectError {
    return new RejectedBeforeEffectError(code, message, retryable);
  }
}

export function isRejectedBeforeEffectError(err: unknown): err is RejectedBeforeEffectError {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err as Record<symbol, unknown>)[REJECTED_BEFORE_EFFECT_BRAND] === true,
  );
}

/**
 * Lightweight pre-dispatch JSON Schema check for required keys and primitive
 * property types so malformed LLM arguments fail BEFORE entering a non-idempotent
 * pack tool handler.
 */
export function validateArgsAgainstJsonSchema(
  toolName: string,
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): void {
  if (!schema || typeof schema !== 'object') return;
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === 'string' && (args[key] === undefined || args[key] === null)) {
        throw RejectedBeforeEffectError.create(
          'schema_validation_failed',
          `invalid arguments for "${toolName}": missing required property "${key}"`,
          true,
        );
      }
    }
  }
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, propSpec] of Object.entries(properties as Record<string, unknown>)) {
      if (args[key] === undefined || !propSpec || typeof propSpec !== 'object') continue;
      const expectedType = (propSpec as { type?: unknown }).type;
      if (typeof expectedType !== 'string') continue;
      const val = args[key];
      const ok =
        (expectedType === 'string' && typeof val === 'string') ||
        (expectedType === 'number' && typeof val === 'number' && Number.isFinite(val)) ||
        (expectedType === 'integer' && typeof val === 'number' && Number.isInteger(val)) ||
        (expectedType === 'boolean' && typeof val === 'boolean') ||
        (expectedType === 'array' && Array.isArray(val)) ||
        (expectedType === 'object' && Boolean(val) && typeof val === 'object' && !Array.isArray(val));
      if (!ok) {
        throw RejectedBeforeEffectError.create(
          'schema_validation_failed',
          `invalid arguments for "${toolName}": property "${key}" expected ${expectedType}`,
          true,
        );
      }
    }
  }
}
