/**
 * Host-managed CredentialBroker & SecretRedactor (R1).
 *
 * Plaintext credentials never enter LLM context, tool schemas, persisted
 * traces, or diagnostic bundles:
 *  - Encrypted at rest with AES-256-GCM using `STEERABLE_CREDENTIAL_MASTER_KEY`
 *    (required in multi-tenant mode) or a mode-0600 local master secret under
 *    `<userDataDir>/credential-master-key.bin` in single-user local mode.
 *  - Scoped to `'tenant'` (`owner_user_id = '__tenant__'`) or `'user'`
 *    (`owner_user_id = principal.id`) with role-based access checks against
 *    `PackDataSource.requiredRoles`.
 *  - Outbound `credentials.fetch(...)` injects auth headers/query at the egress
 *    boundary and strips injected auth headers on cross-origin HTTP redirects.
 *  - Every resolved secret is automatically registered into `SecretRedactor`
 *    so plaintext, URL-encoded, and Base64-encoded occurrences are scrubbed to
 *    `[REDACTED:credential]` before tool outputs reach the model or trace DB.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CredentialInjection,
  PackCredentialClient,
  PackDataSource,
  Principal,
} from '@steerable/pack-sdk';
import { getAuthProvider } from './index.js';
import { getUserDataDir } from '../runtime.js';
import type { ScopedStore } from '../storage/scoped-store.js';
import { ensurePhase9Store } from '../storage/fde-fallback.js';
import { getRegisteredDataSource, listRegisteredDataSources } from '../scenario/applications.js';

export const REDACTED_CREDENTIAL_MARKER = '[REDACTED:credential]';
export const TENANT_CREDENTIAL_OWNER = '__tenant__';

const MIN_REDACT_SECRET_LEN = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_CREDENTIAL_REDIRECTS = 5;

const globalSecretNeedles = new Set<string>();

/**
 * Registers a host-level secret so every `SecretRedactor` instance created
 * afterward scrubs its raw, URL-encoded, and Base64-encoded forms.
 */
export function registerGlobalSecret(secret: string): () => void {
  const trimmed = secret.trim();
  if (trimmed.length < MIN_REDACT_SECRET_LEN) return () => {};
  globalSecretNeedles.add(trimmed);
  return () => {
    globalSecretNeedles.delete(trimmed);
  };
}

/** Clears process-wide registered secrets in unit tests. */
export function clearGlobalSecretsForTests(): void {
  globalSecretNeedles.clear();
}

/**
 * Tracks active plaintext secrets and scrubs their raw, URL-encoded, and
 * base64-encoded forms from strings and structured JSON payloads.
 */
export class SecretRedactor {
  private readonly needles = new Set<string>();

  constructor() {
    for (const secret of globalSecretNeedles) {
      this.registerSecret(secret);
    }
  }

  /** Registers one or more secret strings for scrubbing. */
  registerSecret(secret: string): void {
    const trimmed = secret.trim();
    if (trimmed.length < MIN_REDACT_SECRET_LEN) return;
    this.needles.add(trimmed);
    const urlEncoded = encodeURIComponent(trimmed);
    if (urlEncoded.length >= MIN_REDACT_SECRET_LEN) {
      this.needles.add(urlEncoded);
    }
    const b64 = Buffer.from(trimmed, 'utf8').toString('base64');
    if (b64.length >= MIN_REDACT_SECRET_LEN) {
      this.needles.add(b64);
    }
  }

  /** Registers every string leaf inside a CredentialInjection payload. */
  registerInjection(injection: CredentialInjection): void {
    for (const group of [injection.headers, injection.query, injection.env]) {
      if (!group) continue;
      for (const value of Object.values(group)) {
        if (typeof value === 'string') {
          this.registerSecret(value);
          const parts = value.trim().split(/\s+/);
          if (parts.length >= 2 && /^(bearer|basic|token|apikey)$/i.test(parts[0] ?? '')) {
            this.registerSecret(parts.slice(1).join(' '));
          }
        }
      }
    }
  }

  get hasSecrets(): boolean {
    return this.needles.size > 0;
  }

  /** Alias for `redactString` matching `SideCallPort` / `diag-bundle` callers. */
  redact(input: string): string {
    return this.redactString(input);
  }

  /** Scrubs all registered secret needles in `input` (longest match first). */
  redactString(input: string): string {
    if (!input || this.needles.size === 0) return input;
    let out = input;
    const ordered = [...this.needles].sort((a, b) => b.length - a.length);
    for (const needle of ordered) {
      if (out.includes(needle)) {
        out = out.split(needle).join(REDACTED_CREDENTIAL_MARKER);
      }
    }
    return out;
  }

  /** Deeply scrubs any string fields inside a JSON-compatible value. */
  redactUnknown<T>(value: T): T {
    if (this.needles.size === 0) return value;
    return this.walk(value, new WeakSet<object>()) as T;
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redactString(value);
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = this.walk(v, seen);
    }
    return out;
  }
}

export interface StoredSecretPayload {
  /** Bearer token, password, API key, or OAuth access token. */
  secret?: string;
  /** Optional username for Basic auth. */
  username?: string;
  /** Optional header name when `authKind === 'header'`. */
  headerName?: string;
  /** Optional explicit injection map when `authKind === 'custom_env'` or multi-header. */
  headers?: Record<string, string>;
  query?: Record<string, string>;
  env?: Record<string, string>;
}

export interface CredentialMetadataItem {
  readonly sourceId: string;
  readonly label: Readonly<Record<string, string>>;
  readonly authKind: NonNullable<PackDataSource['authKind']>;
  readonly scope: NonNullable<PackDataSource['scope']>;
  readonly requiredRoles: readonly string[];
  readonly configured: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export class CredentialAccessError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialAccessError';
  }
}

function isMultiTenantRuntime(): boolean {
  return process.env.DEEPPATH_TEAM_MODE === '1' || getAuthProvider() !== null;
}

function resolveMasterKey(
  explicitKey?: Buffer,
  requireExplicitMasterKey?: boolean,
): Buffer {
  if (explicitKey) {
    if (explicitKey.byteLength !== 32) {
      throw new Error('[credentials] explicit master key must be 32 bytes');
    }
    return explicitKey;
  }
  const envKey = process.env.STEERABLE_CREDENTIAL_MASTER_KEY?.trim();
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    const asBase64 = Buffer.from(envKey, 'base64');
    if (asBase64.byteLength === 32) return asBase64;
    return createHash('sha256').update(envKey, 'utf8').digest();
  }
  if (requireExplicitMasterKey ?? isMultiTenantRuntime()) {
    throw new Error(
      '[credentials] STEERABLE_CREDENTIAL_MASTER_KEY is required in multi-tenant mode',
    );
  }
  const dir = getUserDataDir();
  mkdirSync(dir, { recursive: true });
  // File uses .bin (never .pem/.key) with mode 0600 for owner-only local persistence.
  const filePath = path.join(dir, 'credential-master-key.bin');
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath);
    if (raw.byteLength === 32) return raw;
  }
  const generated = randomBytes(32);
  writeFileSync(filePath, generated, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Read-only / non-POSIX filesystem fallback
    }
  }
  return generated;
}

function encryptPayload(payload: StoredSecretPayload, key: Buffer): {
  cipherText: string;
  iv: string;
  authTag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptPayload(
  record: { cipherText: string; iv: string; authTag: string },
  key: Buffer,
): StoredSecretPayload {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.cipherText, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as StoredSecretPayload;
}

function effectiveAuthKind(source: PackDataSource): NonNullable<PackDataSource['authKind']> {
  return source.authKind ?? 'bearer';
}

function effectiveScope(source: PackDataSource): NonNullable<PackDataSource['scope']> {
  return source.scope ?? 'tenant';
}

function effectiveLabel(source: PackDataSource): Readonly<Record<string, string>> {
  return source.label ?? { en: source.id, zh: source.id };
}

function toCredentialInjection(
  authKind: NonNullable<PackDataSource['authKind']>,
  payload: StoredSecretPayload,
): CredentialInjection {
  const headers: Record<string, string> = { ...(payload.headers ?? {}) };
  const query: Record<string, string> = { ...(payload.query ?? {}) };
  const env: Record<string, string> = { ...(payload.env ?? {}) };

  if (payload.secret) {
    if (authKind === 'bearer' || authKind === 'oauth2') {
      headers.Authorization ??= `Bearer ${payload.secret}`;
    } else if (authKind === 'basic') {
      const user = payload.username ?? '';
      const encoded = Buffer.from(`${user}:${payload.secret}`, 'utf8').toString('base64');
      headers.Authorization ??= `Basic ${encoded}`;
    } else if (authKind === 'header') {
      const headerName = payload.headerName?.trim() || 'X-API-Key';
      headers[headerName] ??= payload.secret;
    }
  }

  return {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function hasRequiredRoles(principal: Principal, source: PackDataSource): boolean {
  if (principal.isAdmin) return true;
  const required = source.requiredRoles ?? [];
  if (required.length === 0) return true;
  const held = new Set(principal.roles);
  return required.some((r) => held.has(r));
}

function ownerUserIdForSource(principal: Principal, source: PackDataSource): string {
  return effectiveScope(source) === 'tenant' ? TENANT_CREDENTIAL_OWNER : principal.id;
}

export class CredentialBroker {
  private readonly explicitKey?: Buffer;
  private readonly requireExplicitMasterKey?: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<
    string,
    { updatedAt: string; payload: StoredSecretPayload }
  >();

  constructor(options?: {
    masterKey?: Buffer;
    requireExplicitMasterKey?: boolean;
    fetchImpl?: typeof fetch;
  }) {
    this.explicitKey = options?.masterKey;
    this.requireExplicitMasterKey = options?.requireExplicitMasterKey;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  private key(): Buffer {
    return resolveMasterKey(this.explicitKey, this.requireExplicitMasterKey);
  }

  /** Asserts that master key resolution succeeds (used at multi-tenant boot). */
  assertReady(): void {
    this.key();
  }

  /** Stores or updates an encrypted credential for a registered PackDataSource. */
  async setCredential(
    store: ScopedStore,
    principal: Principal,
    sourceId: string,
    payload: StoredSecretPayload,
  ): Promise<CredentialMetadataItem> {
    const source = getRegisteredDataSource(sourceId);
    if (!source) {
      throw new CredentialAccessError(404, `Unknown data source: ${sourceId}`);
    }
    const scope = effectiveScope(source);
    const authKind = effectiveAuthKind(source);
    if (scope === 'tenant' && !principal.isAdmin && !hasRequiredRoles(principal, source)) {
      throw new CredentialAccessError(
        403,
        `Principal ${principal.id} is not authorized to configure tenant data source ${sourceId}`,
      );
    }
    if (!hasRequiredRoles(principal, source)) {
      throw new CredentialAccessError(
        403,
        `Principal ${principal.id} lacks required role for data source ${sourceId}`,
      );
    }
    const encrypted = encryptPayload(payload, this.key());
    const ownerUserId = ownerUserIdForSource(principal, source);
    const p9 = ensurePhase9Store(store);
    const saved = await p9.upsertPackCredential({
      ownerUserId,
      sourceId,
      authKind,
      cipherText: encrypted.cipherText,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      updatedBy: principal.id,
    });
    this.cache.set(`${principal.tenantId}\u0000${ownerUserId}\u0000${sourceId}`, {
      updatedAt: saved.updatedAt,
      payload,
    });
    return {
      sourceId: source.id,
      label: effectiveLabel(source),
      authKind,
      scope,
      requiredRoles: source.requiredRoles ?? [],
      configured: true,
      updatedBy: saved.updatedBy,
      updatedAt: saved.updatedAt,
    };
  }

  /** Deletes a stored credential. */
  async deleteCredential(
    store: ScopedStore,
    principal: Principal,
    sourceId: string,
  ): Promise<boolean> {
    const source = getRegisteredDataSource(sourceId);
    if (!source) {
      throw new CredentialAccessError(404, `Unknown data source: ${sourceId}`);
    }
    if (effectiveScope(source) === 'tenant' && !principal.isAdmin) {
      throw new CredentialAccessError(
        403,
        `Only tenant administrators can delete tenant data source ${sourceId}`,
      );
    }
    const ownerUserId = ownerUserIdForSource(principal, source);
    this.cache.delete(`${principal.tenantId}\u0000${ownerUserId}\u0000${sourceId}`);
    const p9 = ensurePhase9Store(store);
    return p9.deletePackCredential(ownerUserId, sourceId);
  }

  /** Lists registered PackDataSources and whether each has a configured secret (never returns secrets). */
  async listMetadata(
    store: ScopedStore,
    principal: Principal,
  ): Promise<CredentialMetadataItem[]> {
    const p9 = ensurePhase9Store(store);
    const rows = await p9.listPackCredentials([principal.id, TENANT_CREDENTIAL_OWNER]);
    const byKey = new Map(rows.map((r) => [`${r.ownerUserId}\u0000${r.sourceId}`, r]));
    return listRegisteredDataSources()
      .filter((source) => source.authKind !== undefined || !source.query)
      .map((source) => {
        const owner = ownerUserIdForSource(principal, source);
        const found = hasRequiredRoles(principal, source)
          ? byKey.get(`${owner}\u0000${source.id}`)
          : undefined;
        return {
          sourceId: source.id,
          label: effectiveLabel(source),
          authKind: effectiveAuthKind(source),
          scope: effectiveScope(source),
          requiredRoles: source.requiredRoles ?? [],
          configured: Boolean(found),
          updatedBy: found?.updatedBy ?? null,
          updatedAt: found?.updatedAt ?? null,
        };
      });
  }

  /**
   * Resolves a decrypted `CredentialInjection` for `principal`, checking `updatedAt`
   * against the store so rotated secrets in multi-process deployments invalidate
   * stale caches immediately, and registers every secret value in `redactor`.
   */
  async resolveForTool(
    store: ScopedStore,
    principal: Principal,
    sourceId: string,
    redactor: SecretRedactor,
  ): Promise<CredentialInjection | null> {
    const source = getRegisteredDataSource(sourceId);
    if (!source) return null;
    if (!hasRequiredRoles(principal, source)) return null;
    const ownerUserId = ownerUserIdForSource(principal, source);
    const p9 = ensurePhase9Store(store);
    const row = await p9.getPackCredential(ownerUserId, sourceId);
    const cacheKey = `${principal.tenantId}\u0000${ownerUserId}\u0000${sourceId}`;
    if (!row || row.tenantId !== principal.tenantId) {
      this.cache.delete(cacheKey);
      return null;
    }
    const cached = this.cache.get(cacheKey);
    const payload =
      cached && cached.updatedAt === row.updatedAt
        ? cached.payload
        : decryptPayload(row, this.key());
    if (!cached || cached.updatedAt !== row.updatedAt) {
      this.cache.set(cacheKey, { updatedAt: row.updatedAt, payload });
    }
    if (payload.secret) redactor.registerSecret(payload.secret);
    const injection = toCredentialInjection(effectiveAuthKind(source), payload);
    redactor.registerInjection(injection);
    return injection;
  }

  /**
   * Executes an outbound HTTP request with host-injected credentials and
   * automatic cross-origin redirect stripping (R1-2).
   */
  async fetchWithCredential(
    store: ScopedStore,
    principal: Principal,
    sourceId: string,
    target: string | URL,
    init: RequestInit | undefined,
    redactor: SecretRedactor,
    fetchOverride?: typeof fetch,
  ): Promise<Response> {
    const injection = await this.resolveForTool(store, principal, sourceId, redactor);
    const doFetch = fetchOverride ?? this.fetchImpl;
    const initialUrl = new URL(String(target));
    const initialOrigin = initialUrl.origin;

    const injectedHeaderNames: string[] = [];
    const baseHeaders = new Headers(init?.headers);
    if (injection?.headers) {
      for (const [k, v] of Object.entries(injection.headers)) {
        baseHeaders.set(k, v);
        injectedHeaderNames.push(k);
      }
    }
    if (injection?.query) {
      for (const [k, v] of Object.entries(injection.query)) {
        initialUrl.searchParams.set(k, v);
      }
    }

    let currentUrl = initialUrl;
    let currentHeaders = new Headers(baseHeaders);
    let currentMethod = init?.method ?? 'GET';
    let currentBody = init?.body;

    for (let hop = 0; hop <= MAX_CREDENTIAL_REDIRECTS; hop += 1) {
      const response = await doFetch(currentUrl.toString(), {
        ...init,
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        redirect: 'manual',
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }
      const location = response.headers.get('location');
      if (!location || hop === MAX_CREDENTIAL_REDIRECTS) {
        return response;
      }
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.origin !== initialOrigin) {
        for (const headerName of injectedHeaderNames) {
          currentHeaders.delete(headerName);
        }
        currentHeaders.delete('authorization');
        currentHeaders.delete('cookie');
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod.toUpperCase() === 'POST')
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = nextUrl;
    }

    throw new Error('[credentials] redirect limit exceeded');
  }

  /** Creates the `PackCredentialClient` passed on `PackToolContext.credentials`. */
  createClient(
    store: ScopedStore,
    principal: Principal,
    redactor: SecretRedactor,
    fetchOverride?: typeof fetch,
  ): PackCredentialClient {
    return {
      resolve: (sourceId: string) =>
        this.resolveForTool(store, principal, sourceId, redactor),
      fetch: (sourceId: string, url: string | URL, init?: RequestInit) =>
        this.fetchWithCredential(
          store,
          principal,
          sourceId,
          url,
          init,
          redactor,
          fetchOverride,
        ),
    };
  }
}

export const defaultCredentialBroker = new CredentialBroker();
