/**
 * Credential checks shared by the command line and the terminal interface.
 *
 * Both surfaces must answer the same question before a turn: is there a key
 * the sidecar can use, and if not, which environment variable would fix it?
 * The answer comes from one resolver so `run`, `doctor` and the TUI banner
 * never disagree.
 */

import type { LlmSettings } from '@steerable/agent-shell/storage/llm-settings';
import { maskApiKey, resolveApiKey, sanitizeLlmProvider } from '@steerable/agent-shell/storage/llm-settings';

export { maskApiKey };

/** Settings fields the resolvers read, in the wire shape the backend sends. */
export type SettingsPayload = Record<string, unknown>;

/**
 * Narrows a settings payload to the fields credential resolution needs.
 *
 * @param payload `GET /api/v2/local-settings/llm` body.
 * @returns Settings shaped for {@link resolveApiKey}.
 */
export function credentialSettings(payload: SettingsPayload): Pick<LlmSettings, 'provider' | 'vendorId' | 'baseUrl' | 'apiKey'> {
  return {
    provider: sanitizeLlmProvider(payload.provider),
    ...(typeof payload.vendorId === 'string' ? { vendorId: payload.vendorId } : {}),
    ...(typeof payload.baseUrl === 'string' ? { baseUrl: payload.baseUrl } : {}),
    ...(typeof payload.apiKey === 'string' ? { apiKey: payload.apiKey } : {}),
  };
}

/**
 * Whether a turn can start on these settings.
 *
 * A payload without a `provider` field is not an LLM-settings response at all
 * (a stub, a proxy, an endpoint that changed shape). Refusing to start a turn
 * on that would make an unrelated response break every run, so it passes
 * through and the turn reports its own failure.
 *
 * @param payload Settings payload from the backend.
 * @param env Environment to read keys from.
 * @returns `ok`, or the environment variables that would unblock it.
 */
export function preflightApiKey(
  payload: SettingsPayload,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; envNames: readonly string[] } {
  if (typeof payload.provider !== 'string') return { ok: true };
  const resolved = resolveApiKey(credentialSettings(payload), env);
  if (resolved.key || resolved.source.kind === 'not_required') return { ok: true };
  return { ok: false, envNames: resolved.envNames };
}
