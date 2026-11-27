/**
 * Product-neutral environment sanitizer for tool-spawned child processes
 * (`local_exec_shell`, `local_run_snippet`, and interactive PTY sessions).
 *
 * Host master keys, internal RPC tokens, shared database URLs, and host-managed
 * model provider API keys are stripped from ambient `process.env` before a tool
 * subprocess starts, while explicit per-call `extraEnv` (such as `custom_env`
 * injections authorized through `CredentialBroker`) is preserved.
 */
import { SecretRedactor, registerGlobalSecret } from './auth/credentials.js';

const DEFAULT_PROTECTED_EXACT_KEYS: ReadonlySet<string> = new Set([
  'STEERABLE_CREDENTIAL_MASTER_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPAT_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY',
]);

const DEFAULT_PROTECTED_PREFIXES: readonly string[] = [
  'STEERABLE_INTERNAL_',
];

const DEFAULT_PROTECTED_SUFFIXES: readonly string[] = [
  '_INTERNAL_TOKEN',
  '_INTERNAL_BEARER',
  '_BOOTSTRAP_TOKEN',
  '_MYSQL_URL',
  '_DATABASE_URL',
  '_POSTGRES_URL',
];

const customExactKeys = new Set<string>();
const customPrefixes = new Set<string>();

/**
 * Registers additional exact environment variable names or `PREFIX_` patterns
 * to strip from tool-spawned child processes.
 *
 * Entries ending with `_` match as case-insensitive prefixes; all other entries
 * match exact variable names case-insensitively.
 */
export function registerProtectedEnvKeys(entries: readonly string[]): () => void {
  const addedExact: string[] = [];
  const addedPrefixes: string[] = [];
  for (const raw of entries) {
    const upper = raw.trim().toUpperCase();
    if (!upper) continue;
    if (upper.endsWith('_')) {
      if (!customPrefixes.has(upper)) {
        customPrefixes.add(upper);
        addedPrefixes.push(upper);
      }
    } else if (!customExactKeys.has(upper)) {
      customExactKeys.add(upper);
      addedExact.push(upper);
    }
  }
  return () => {
    for (const k of addedExact) customExactKeys.delete(k);
    for (const p of addedPrefixes) customPrefixes.delete(p);
  };
}

/** Clears custom protected env rules in unit tests. */
export function resetProtectedEnvKeysForTests(): void {
  customExactKeys.clear();
  customPrefixes.clear();
}

/** True when `key` is a host-protected secret variable that tools must not inherit. */
export function isProtectedHostEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  if (!upper) return false;
  if (DEFAULT_PROTECTED_EXACT_KEYS.has(upper) || customExactKeys.has(upper)) {
    return true;
  }
  for (const prefix of DEFAULT_PROTECTED_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const prefix of customPrefixes) {
    if (upper.startsWith(prefix)) return true;
  }
  for (const suffix of DEFAULT_PROTECTED_SUFFIXES) {
    if (upper.endsWith(suffix)) return true;
  }
  return false;
}

function registerUrlPasswordIfPresent(raw: string): void {
  try {
    const parsed = new URL(raw);
    if (parsed.password) {
      registerGlobalSecret(decodeURIComponent(parsed.password));
    }
  } catch {
    // Non-URL secret value; full string registration already covers it.
  }
}

/**
 * Builds a clean child-process environment from `sourceEnv`, stripping
 * host-protected keys (and registering their values into `SecretRedactor`),
 * then applying caller-supplied `extraEnv`.
 */
export function scrubToolSubprocessEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue;
    if (isProtectedHostEnvKey(key)) {
      if (value.trim().length > 0) {
        registerGlobalSecret(value);
        registerUrlPasswordIfPresent(value);
      }
      continue;
    }
    clean[key] = value;
  }
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value === 'string') {
        clean[key] = value;
      }
    }
  }
  return clean;
}

/** Scrubs any registered global/host secrets from subprocess text output. */
export function redactSubprocessText(text: string): string {
  if (!text) return text;
  const redactor = new SecretRedactor();
  return redactor.hasSecrets ? redactor.redactString(text) : text;
}
