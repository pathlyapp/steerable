import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import {
  LOCAL_DEFAULT_PRINCIPAL,
  registerAuthProvider,
  resetBootstrapProvider,
  type Principal,
} from '../../src/auth/index.js';
import {
  CredentialBroker,
  REDACTED_CREDENTIAL_MARKER,
  SecretRedactor,
} from '../../src/auth/credentials.js';
import {
  registerApplications,
  registerPackDataSources,
  resetActiveApplication,
  resetPhase9PackRegistries,
  resolveActiveApplication,
  setActiveApplication,
} from '../../src/scenario/applications.js';
import { createToolInvokeHandler } from '../../src/sidecar/reverse-tools.js';
import { createApprovalBridge } from '../../src/sidecar/reverse-approval.js';
import {
  beginTurnSecurityContext,
  endTurnSecurityContext,
} from '../../src/local-backend/turn-security-context.js';
import { createBsServer, type BsServerDeps } from '../../src/server/http-server.js';
import { registerPackHttpRoutes, resetPackHttpRoutes } from '../../src/host/http-routes.js';
import { resetPhase9FallbackState } from '../../src/storage/fde-fallback.js';
import type { ScopedStore } from '../../src/storage/scoped-store.js';

function createFakeScopedStore(tenantId: string, userId: string): ScopedStore {
  return {
    scope: { tenantId, userId },
    addMessage: vi.fn(),
  } as unknown as ScopedStore;
}

describe('Phase 9 S1: Principal, CredentialBroker, Bootstrap & Safe Recovery', () => {
  let tempDir: string;
  let server: Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'steerable-s1-'));
    writeFileSync(path.join(tempDir, 'index.html'), '<!doctype html><head></head><body></body>');
    resetPhase9PackRegistries();
    resetBootstrapProvider();
    resetPackHttpRoutes();
    resetPhase9FallbackState();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
    resetPhase9PackRegistries();
    resetBootstrapProvider();
    resetPackHttpRoutes();
    resetPhase9FallbackState();
  });

  it('T-AUTH-01 & T-BOOT-01: GET /api/v2/auth/bootstrap succeeds unauthenticated while /api/v2/* enforces auth and injects Principal', async () => {
    const seenPrincipals: Principal[] = [];
    registerPackHttpRoutes('acme', [
      {
        method: 'POST',
        path: '/host/acme/inspect',
        handler: async (req) => {
          seenPrincipals.push(req.principal!);
          return { principalId: req.principal?.id, channel: req.originChannel };
        },
      },
    ]);

    const alice: Principal = {
      id: 'u-alice',
      tenantId: 't-acme',
      displayName: 'Alice',
      email: 'alice@example.com',
      roles: ['analyst'],
      isAdmin: false,
    };

    const disposeAuth = registerAuthProvider({
      id: 'test-oidc',
      async authenticate(headers) {
        if (headers.authorization === 'Bearer valid-alice') {
          return { ok: true, principal: alice };
        }
        return { ok: false, status: 401 };
      },
      async describeSelf(p) {
        return p;
      },
      async describeBootstrap() {
        return {
          productName: 'Acme Workbench',
          authRequired: true,
          iamMode: 'sso',
          authMethods: [
            {
              kind: 'oidc',
              providerId: 'corp-oidc',
              label: 'Sign in with Corporate SSO',
              authorizePath: '/auth/oidc/authorize',
            },
          ],
        };
      },
    });

    try {
      server = createBsServer({
        store: createFakeScopedStore('local', 'local'),
        localBackendRouter: {
          handle: vi.fn(async (req) => ({
            status: 200,
            data: { principal: req.principal, originChannel: req.originChannel },
          })),
          handleStream: vi.fn(),
        } as unknown as BsServerDeps['localBackendRouter'],
        localExecutor: {} as BsServerDeps['localExecutor'],
        localScriptRegistry: {} as BsServerDeps['localScriptRegistry'],
        terminalManager: {} as BsServerDeps['terminalManager'],
        approvalBridge: {
          decide: vi.fn(),
          pending: () => [],
          handler: vi.fn(),
        },
        askUserBridge: {
          answer: vi.fn(),
          pending: () => [],
          handler: vi.fn(),
          takeResolved: vi.fn(() => []),
        } as unknown as BsServerDeps['askUserBridge'],
        maybeExecInTerminal: vi.fn(),
        bus: { attach: vi.fn() } as unknown as BsServerDeps['bus'],
        webDistDir: tempDir,
      });

      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      // 1. Unauthenticated bootstrap succeeds with 200 and zero secrets
      const bootRes = await fetch(`${base}/api/v2/auth/bootstrap`);
      expect(bootRes.status).toBe(200);
      const bootBody = (await bootRes.json()) as Record<string, unknown>;
      expect(bootBody.authRequired).toBe(true);
      expect(bootBody.iamMode).toBe('sso');
      expect(bootBody.authMethods).toEqual([
        {
          kind: 'oidc',
          providerId: 'corp-oidc',
          label: 'Sign in with Corporate SSO',
          authorizePath: '/auth/oidc/authorize',
        },
      ]);

      // 2. Unauthenticated API call returns 401
      const unauthRes = await fetch(`${base}/api/v2/chats`);
      expect(unauthRes.status).toBe(401);

      // 3. Authenticated pack host route receives Alice's frozen Principal + originChannel
      const hostRes = await fetch(`${base}/host/acme/inspect`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-alice',
          'Content-Type': 'application/json',
          'X-Steerable-Origin-Channel': 'desktop',
        },
        body: JSON.stringify({}),
      });
      expect(hostRes.status).toBe(200);
      const hostData = (await hostRes.json()) as Record<string, unknown>;
      expect(hostData).toEqual({ principalId: 'u-alice', channel: 'desktop' });
      expect(Object.isFrozen(seenPrincipals[0])).toBe(true);

      // 4. Health activity endpoint works
      const healthRes = await fetch(`${base}/host/health/activity`, {
        headers: { Authorization: 'Bearer valid-alice' },
      });
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as { state: string; activeTurns: number };
      expect(healthJson.state).toBe('idle');
      expect(healthJson.activeTurns).toBe(0);
    } finally {
      disposeAuth();
    }
  });

  it('T-AUTH-02: Local mode injects LOCAL_DEFAULT_PRINCIPAL when no AuthProvider is registered', async () => {
    let capturedPrincipal: Principal | undefined;
    const invoke = createToolInvokeHandler({
      toolRouter: {
        listSchemas: () => [],
        getSchemaByName: () => undefined,
        execute: vi.fn(async (_call, ctx) => {
          capturedPrincipal = ctx?.principal;
          return { ok: true };
        }),
      } as never,
    });

    const out = await invoke({
      name: 'pack_tool',
      arguments: {},
      context: { chatId: 'chat-local-1' },
    });
    expect(out).toEqual({ success: true, data: { value: { ok: true } } });
    expect(capturedPrincipal).toEqual(LOCAL_DEFAULT_PRINCIPAL);
  });

  it('T-AUTH-03 & T-AUTH-05: CredentialBroker isolates user credentials across principals, scrubs plaintext/encoded secrets, and ignores forged args.principal', async () => {
    registerPackDataSources('erp-pack', [
      {
        id: 'erp-personal-token',
        label: { en: 'ERP Personal Token', zh: 'ERP 个人令牌' },
        authKind: 'bearer',
        scope: 'user',
      },
      {
        id: 'erp-admin-vault',
        label: { en: 'ERP Tenant Vault', zh: 'ERP 租户密钥' },
        authKind: 'header',
        scope: 'tenant',
        requiredRoles: ['finance_admin'],
      },
    ]);

    const broker = new CredentialBroker({ masterKey: randomBytes(32) });
    const userA: Principal = {
      id: 'user-a',
      tenantId: 'tenant-1',
      displayName: 'User A',
      email: null,
      roles: ['finance_admin'],
      isAdmin: false,
    };
    const userB: Principal = {
      id: 'user-b',
      tenantId: 'tenant-1',
      displayName: 'User B',
      email: null,
      roles: ['viewer'],
      isAdmin: false,
    };

    const storeA = createFakeScopedStore('tenant-1', 'user-a');
    const storeB = createFakeScopedStore('tenant-1', 'user-b');

    const topSecret = 'sk_live_SuperSecretToken_998877';
    await broker.setCredential(storeA, userA, 'erp-personal-token', {
      secret: topSecret,
    });
    await broker.setCredential(storeA, userA, 'erp-admin-vault', {
      secret: 'vault_key_445566',
      headerName: 'X-Vault-Key',
    });

    // User B in the same tenant cannot resolve User A's user-scoped token OR role-gated tenant vault
    const redactorB = new SecretRedactor();
    expect(
      await broker.resolveForTool(storeB, userB, 'erp-personal-token', redactorB),
    ).toBeNull();
    expect(
      await broker.resolveForTool(storeB, userB, 'erp-admin-vault', redactorB),
    ).toBeNull();

    // User A resolves decrypted injection; echoed plaintext, URL-encoded, and base64 forms are scrubbed!
    const turnSec = beginTurnSecurityContext({
      chatId: 'chat-sec-1',
      principal: userA,
      originChannel: 'web',
      store: storeA,
    });
    try {
      const invoke = createToolInvokeHandler({
        toolRouter: {
          listSchemas: () => [],
          getSchemaByName: () => undefined,
          execute: vi.fn(async (call, ctx) => {
            // T-AUTH-05: forged args.principal never overrides ctx.principal!
            expect(call.arguments.principal).toEqual({ id: 'root', isAdmin: true });
            expect(ctx?.principal?.id).toBe('user-a');
            expect(ctx?.principal?.isAdmin).toBe(false);

            const resolved = await broker.resolveForTool(
              storeA,
              ctx!.principal!,
              'erp-personal-token',
              turnSec.redactor,
            );
            const authHeader = resolved?.headers?.Authorization ?? '';
            const b64 = Buffer.from(topSecret, 'utf8').toString('base64');
            return {
              success: true,
              debugEcho: `used ${authHeader} and b64=${b64} and url=${encodeURIComponent(topSecret)}`,
            };
          }),
        } as never,
      });

      const result = (await invoke({
        name: 'erp_sync',
        arguments: { principal: { id: 'root', isAdmin: true } },
        context: { chatId: 'chat-sec-1' },
      })) as { debugEcho: string };

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(topSecret);
      expect(serialized).not.toContain(Buffer.from(topSecret, 'utf8').toString('base64'));
      expect(serialized).toContain(REDACTED_CREDENTIAL_MARKER);
    } finally {
      endTurnSecurityContext('chat-sec-1', turnSec);
    }
  });

  it('T-AUTH-04: IM/Webhook origin channels block outward tools with workbench handoff and downgrade allow_always to allow_once', async () => {
    const store = createFakeScopedStore('local', 'local');
    const turnSec = beginTurnSecurityContext({
      chatId: 'chat-im-1',
      principal: LOCAL_DEFAULT_PRINCIPAL,
      originChannel: 'im',
      store,
    });
    try {
      const executeSpy = vi.fn();
      const invoke = createToolInvokeHandler({
        toolRouter: {
          listSchemas: () => [
            {
              name: 'send_external_invoice',
              description: 'Send external invoice',
              inputSchema: {},
              mode: 'external',
              checkpoint: 'outward',
            },
          ],
          getSchemaByName: (name: string) =>
            name === 'send_external_invoice'
              ? {
                  name: 'send_external_invoice',
                  description: 'Send external invoice',
                  inputSchema: {},
                  mode: 'external',
                  checkpoint: 'outward' as const,
                }
              : undefined,
          execute: executeSpy,
        } as never,
      });

      const out = (await invoke({
        name: 'send_external_invoice',
        arguments: { invoiceId: 'INV-1' },
        context: { chatId: 'chat-im-1' },
      })) as Record<string, unknown>;
      expect(out.success).toBe(false);
      expect(out.effect).toBe('none');
      expect(out.retryable).toBe(true);
      expect(String(out.error)).toContain('outward_confirmation_required');
      expect(String(out.workbenchHref)).toContain('/#/agent/chat-im-1');
      expect(executeSpy).not.toHaveBeenCalled();

      // Approval bridge also downgrades allow_always -> allow_once on IM channel
      let capturedPromptRequestId = '';
      const bridge = createApprovalBridge({
        hasWindow: () => true,
        broadcast: (_ch, prompt) => {
          capturedPromptRequestId = prompt.requestId;
        },
      });
      const pendingDecision = bridge.handler({
        toolName: 'local_exec_shell',
        arguments: { command: 'echo ok' },
        mode: 'local',
        category: 'local_exec_shell',
        round: 1,
        chatId: 'chat-im-1',
      });
      bridge.decide({
        requestId: capturedPromptRequestId,
        kind: 'allow_always',
        reason: 'im click',
      });
      const settled = (await pendingDecision) as { kind: string };
      expect(settled.kind).toBe('allow_once');
    } finally {
      endTurnSecurityContext('chat-im-1', turnSec);
    }
  });

  it('T-BOOT-02 & T-BOOT-04: Safe Recovery Mode (?safe=1) bypasses restrictive ApplicationManifest and reset restores default shell', async () => {
    registerApplications('kiosk-pack', [
      {
        id: 'locked-kiosk',
        title: { en: 'Locked Kiosk', zh: '受限终端' },
        defaultAgentProfileId: 'kiosk-agent',
        allowedPackIds: ['kiosk-pack'],
        hiddenNavItems: ['skills', 'mcp', 'agents', 'terminal'],
      },
    ]);
    const store = createFakeScopedStore('local', 'local');
    await setActiveApplication(store, 'locked-kiosk');

    const normal = await resolveActiveApplication(store, { safeMode: false });
    expect(normal.id).toBe('locked-kiosk');
    expect(normal.hiddenNavItems).toEqual(['skills', 'mcp', 'agents', 'terminal']);

    const safe = await resolveActiveApplication(store, { safeMode: true });
    expect(safe.id).toBe('default');
    expect(safe.safeMode).toBe(true);
    expect(safe.customApplicationBypassed).toBe(true);
    expect(safe.hiddenNavItems).toEqual([]);

    const afterReset = await resetActiveApplication(store);
    expect(afterReset.id).toBe('default');
    const reloaded = await resolveActiveApplication(store, { safeMode: false });
    expect(reloaded.id).toBe('default');
    expect(reloaded.hiddenNavItems).toEqual([]);
  });

  it('T-AUTH-03b & T-BOOT-02b: credentials.fetch strips auth headers across cross-origin 302, multi-tenant rejects missing master key, and registering ApplicationManifest never auto-activates', async () => {
    // 1. Multi-tenant mode without STEERABLE_CREDENTIAL_MASTER_KEY refuses to start
    const prevMaster = process.env.STEERABLE_CREDENTIAL_MASTER_KEY;
    delete process.env.STEERABLE_CREDENTIAL_MASTER_KEY;
    try {
      expect(() =>
        new CredentialBroker({ requireExplicitMasterKey: true }).assertReady(),
      ).toThrow(/STEERABLE_CREDENTIAL_MASTER_KEY/);
    } finally {
      if (prevMaster !== undefined) {
        process.env.STEERABLE_CREDENTIAL_MASTER_KEY = prevMaster;
      }
    }

    // 2. Registering an ApplicationManifest only adds a candidate; active app remains 'default'
    registerApplications('candidate-pack', [
      {
        id: 'candidate-app',
        title: { en: 'Candidate App' },
        hiddenNavItems: ['mcp'],
      },
    ]);
    const store = createFakeScopedStore('tenant-x', 'user-x');
    const activeBeforeAdopt = await resolveActiveApplication(store);
    expect(activeBeforeAdopt.id).toBe('default');
    expect(activeBeforeAdopt.hiddenNavItems).toEqual([]);

    // 3. credentials.fetch injects Authorization on origin A and strips it on 302 redirect to origin B
    registerPackDataSources('redirect-pack', [
      {
        id: 'origin-a-token',
        label: { en: 'Origin A Token' },
        authKind: 'bearer',
        scope: 'user',
      },
    ]);
    const broker = new CredentialBroker({ masterKey: randomBytes(32) });
    const localStore = createFakeScopedStore('local', 'local');
    await broker.setCredential(localStore, LOCAL_DEFAULT_PRINCIPAL, 'origin-a-token', {
      secret: 'secret_origin_a_token_12345',
    });

    const http = await import('node:http');
    let originBAuthHeader: string | undefined = 'not-called';
    let originAAuthHeader: string | undefined;

    const serverB = http.createServer((req, res) => {
      originBAuthHeader = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ landed: 'B' }));
    });
    await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', resolve));
    const portB = (serverB.address() as AddressInfo).port;

    const serverA = http.createServer((req, res) => {
      originAAuthHeader = req.headers.authorization;
      res.writeHead(302, { Location: `http://localhost:${portB}/target` });
      res.end();
    });
    await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', resolve));
    const portA = (serverA.address() as AddressInfo).port;

    try {
      const redactor = new SecretRedactor();
      const resp = await broker.fetchWithCredential(
        localStore,
        LOCAL_DEFAULT_PRINCIPAL,
        'origin-a-token',
        `http://127.0.0.1:${portA}/start`,
        undefined,
        redactor,
      );
      expect(resp.status).toBe(200);
      expect(originAAuthHeader).toBe('Bearer secret_origin_a_token_12345');
      expect(originBAuthHeader).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => serverA.close(() => resolve()));
      await new Promise<void>((resolve) => serverB.close(() => resolve()));
    }
  });
});
