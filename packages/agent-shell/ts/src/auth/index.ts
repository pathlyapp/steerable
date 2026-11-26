/**
 * Product-neutral authenticated identity, origin channel, and unauthenticated
 * bootstrap discovery contracts.
 */
import type {
  OriginChannel,
  Principal,
  PublicAuthMethod,
  PublicBootstrapPayload,
} from '@steerable/pack-sdk';
import { getBrand } from '../brand.js';

export type {
  OriginChannel,
  Principal,
  PublicAuthMethod,
  PublicBootstrapPayload,
} from '@steerable/pack-sdk';

/**
 * Default local identity injected when running in single-user desktop, CLI,
 * or loopback BS mode without an external AuthProvider.
 */
export const LOCAL_DEFAULT_PRINCIPAL: Principal = Object.freeze({
  id: 'local',
  tenantId: 'local',
  displayName: 'Local User',
  email: null,
  roles: Object.freeze(['owner']),
  isAdmin: true,
});

const VALID_ORIGIN_CHANNELS: ReadonlySet<OriginChannel> = new Set([
  'desktop',
  'web',
  'cli',
  'im',
  'webhook',
]);

/**
 * Normalizes an incoming channel hint from request headers, IPC metadata, or
 * CLI options, falling back to `fallback` ('web' by default).
 */
export function parseOriginChannel(
  value: unknown,
  fallback: OriginChannel = 'web',
): OriginChannel {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase() as OriginChannel;
    if (VALID_ORIGIN_CHANNELS.has(trimmed)) return trimmed;
  }
  return fallback;
}

/** True when a channel cannot host rich interactive approvals or workbenches. */
export function isRestrictedOriginChannel(channel: OriginChannel | undefined): boolean {
  return channel === 'im' || channel === 'webhook';
}

export type AuthDecision =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; body?: unknown };

/**
 * Authentication extension point for BS deployments.
 *
 * Implementations own all interpretation and validation of request headers,
 * including cookies and any identity assertions added by a trusted proxy.
 */
export interface AuthProvider {
  readonly id: string;
  authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<AuthDecision>;
  describeSelf(principal: Principal): Promise<unknown>;
  /**
   * Optional public bootstrap descriptor returned before authentication by
   * `GET /api/v2/auth/bootstrap`. Must never include secrets or private user data.
   */
  describeBootstrap?(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<Partial<PublicBootstrapPayload>> | Partial<PublicBootstrapPayload>;
}

export type PublicBootstrapResolver = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
) => Promise<Partial<PublicBootstrapPayload>> | Partial<PublicBootstrapPayload>;

let activeProvider: AuthProvider | null = null;
let bootstrapResolver: PublicBootstrapResolver | null = null;

/**
 * Registers the process-wide provider before the BS host starts.
 *
 * @returns A disposer that removes this provider if it is still active.
 */
export function registerAuthProvider(provider: AuthProvider): () => void {
  if (activeProvider) {
    throw new Error(
      `[auth] provider already registered: ${activeProvider.id}`,
    );
  }
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) activeProvider = null;
  };
}

/** Returns the provider registered by the product composition root, if any. */
export function getAuthProvider(): AuthProvider | null {
  return activeProvider;
}

/**
 * Registers an optional override for `GET /api/v2/auth/bootstrap`.
 */
export function registerBootstrapProvider(resolver: PublicBootstrapResolver): () => void {
  bootstrapResolver = resolver;
  return () => {
    if (bootstrapResolver === resolver) bootstrapResolver = null;
  };
}

/** Resets bootstrap override in tests. */
export function resetBootstrapProvider(): void {
  bootstrapResolver = null;
}

/**
 * Computes the unauthenticated `PublicBootstrapPayload` for login gates and
 * preflight checks (`GET /api/v2/auth/bootstrap`).
 */
export async function resolvePublicBootstrap(
  headers: Readonly<Record<string, string | string[] | undefined>> = {},
  extras?: Partial<PublicBootstrapPayload>,
): Promise<PublicBootstrapPayload> {
  const brand = getBrand();
  const fromProvider = activeProvider?.describeBootstrap
    ? await activeProvider.describeBootstrap(headers)
    : undefined;
  const fromOverride = bootstrapResolver
    ? await bootstrapResolver(headers)
    : undefined;
  const merged = {
    ...fromProvider,
    ...fromOverride,
    ...extras,
  };
  const authRequired = merged.authRequired ?? Boolean(activeProvider);
  const authMethods: readonly PublicAuthMethod[] =
    merged.authMethods ??
    (authRequired
      ? [{ kind: 'password', showTenantSlugInput: true }]
      : []);
  return {
    productName: merged.productName ?? brand.displayName,
    authRequired,
    authMethods,
    ...(merged.iamMode !== undefined ? { iamMode: merged.iamMode } : {}),
    ...(merged.defaultApplicationId !== undefined
      ? { defaultApplicationId: merged.defaultApplicationId }
      : {}),
    ...(merged.safeMode !== undefined ? { safeMode: merged.safeMode } : {}),
  };
}
