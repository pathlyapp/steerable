import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SqliteScopedStore } from '../../src/storage/index.js';
import { ensurePhase9Store } from '../../src/storage/fde-fallback.js';
import {
  ensurePinnedSessionSpec,
  reconcileChatProjectionFromLedger,
} from '../../src/local-backend/state-reconcile.js';
import {
  computePolicyDigest,
  PolicyBoundApprovalStore,
} from '../../src/security/policy-digest.js';
import {
  beginTurnSecurityContext,
  endTurnSecurityContext,
  getHostActivitySnapshot,
} from '../../src/local-backend/turn-security-context.js';
import { LOCAL_DEFAULT_PRINCIPAL } from '../../src/auth/index.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import { createToolInvokeHandler } from '../../src/sidecar/reverse-tools.js';

describe('Phase 9 S2: State Ownership, Outcome Unknown Reconciliation, Policy Digest & Host Activity', () => {
  let tempDir: string;
  let db: Database.Database;
  let store: SqliteScopedStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'steerable-s2-'));
    db = new Database(path.join(tempDir, 'host.sqlite'));
    db.pragma('foreign_keys = ON');
    store = new SqliteScopedStore(db, { tenantId: 'local', userId: 'local' });
    await store.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T-OUT-01: reconcileChatProjectionFromLedger backfills unprojected sidecar ledger turns without duplication and Pin bindings stay immutable', async () => {
    await store.createChatAgent({ id: 'agent-v1', name: 'Agent V1' });
    const chat = await store.createChat('Ledger Test', 'agent-v1');

    const pin1 = await ensurePinnedSessionSpec(store, chat.id, {
      workspaceRoot: '/tmp/ws-initial',
      defaultAgentId: 'agent-v1',
      activeApplicationId: 'app-initial',
    });
    expect(pin1.workspaceRoot).toBe('/tmp/ws-initial');
    expect(pin1.agentId).toBe('agent-v1');
    expect(pin1.applicationId).toBe('app-initial');

    // Global defaults change later — existing session pin MUST NOT drift!
    const pin2 = await ensurePinnedSessionSpec(store, chat.id, {
      workspaceRoot: '/tmp/ws-changed',
      defaultAgentId: 'agent-v2',
      activeApplicationId: 'app-changed',
    });
    expect(pin2).toEqual(pin1);

    // Simulate host crash after user message persisted, before assistant reply projected
    await store.addMessage(chat.id, 'user', 'Run batch check', JSON.stringify({ ledgerSeq: 1 }));

    const firstReconcile = await reconcileChatProjectionFromLedger(store, chat.id, [
      { ledgerSeq: 1, role: 'user', content: 'Run batch check' },
      { ledgerSeq: 2, role: 'assistant', content: 'Batch check completed: 0 anomalies.' },
    ]);
    expect(firstReconcile).toEqual({ backfilledCount: 1, totalProjected: 2 });

    // Idempotent on repeat reconciliation
    const secondReconcile = await reconcileChatProjectionFromLedger(store, chat.id, [
      { ledgerSeq: 1, role: 'user', content: 'Run batch check' },
      { ledgerSeq: 2, role: 'assistant', content: 'Batch check completed: 0 anomalies.' },
    ]);
    expect(secondReconcile).toEqual({ backfilledCount: 0, totalProjected: 2 });
  });

  it('T-OUT-06: non-idempotent failure locks tool across invokes; /reconcile confirmed_succeeded keeps blocking while confirmed_not_executed unlocks without auto-retrying', async () => {
    const chat = await store.createChat('Reconcile Flow');
    const router = new LocalBackendRouter({} as never, { store });

    let toolExecCount = 0;
    let shouldFail = true;
    const invoke = createToolInvokeHandler({
      toolRouter: {
        listSchemas: () => [
          {
            name: 'external_submit_job',
            description: 'Submit external job',
            inputSchema: { type: 'object', required: ['jobCode'] },
            mode: 'external',
            idempotent: false,
          },
        ],
        getSchemaByName: (name: string) =>
          name === 'external_submit_job'
            ? {
                name: 'external_submit_job',
                description: 'Submit external job',
                inputSchema: { type: 'object', required: ['jobCode'] },
                mode: 'external',
                idempotent: false,
              }
            : undefined,
        execute: vi.fn(async () => {
          toolExecCount += 1;
          if (shouldFail) {
            throw new Error('downstream socket timeout after 15s');
          }
          return { submitted: true };
        }),
      } as never,
    });

    const sec = beginTurnSecurityContext({
      chatId: chat.id,
      principal: LOCAL_DEFAULT_PRINCIPAL,
      originChannel: 'web',
      store,
    });
    try {
      // 1. Missing required field fails BEFORE dispatch as effect='none' (no lock!)
      const schemaFail = (await invoke({
        name: 'external_submit_job',
        arguments: {},
        context: { chatId: chat.id },
      })) as Record<string, unknown>;
      expect(schemaFail.effect).toBe('none');
      expect(schemaFail.outcomeUnknown).toBeUndefined();
      expect(toolExecCount).toBe(0);

      // 2. Handler timeout settles as outcomeUnknown=true and persists pending_reconciliation
      const unknownOut = (await invoke({
        name: 'external_submit_job',
        arguments: { jobCode: 'J-100' },
        context: { chatId: chat.id },
      })) as Record<string, unknown>;
      expect(unknownOut.outcomeUnknown).toBe(true);
      expect(unknownOut.effect).toBe('unknown');
      expect(unknownOut.retryable).toBe(false);
      const recId = String(unknownOut.reconciliationId);
      expect(recId.length).toBeGreaterThan(8);
      expect(toolExecCount).toBe(1);

      // 3. Repeat call is blocked BEFORE execution with reconciliation_required
      shouldFail = false;
      const blocked = (await invoke({
        name: 'external_submit_job',
        arguments: { jobCode: 'J-100' },
        context: { chatId: chat.id },
      })) as Record<string, unknown>;
      expect(blocked.error).toContain('reconciliation_required');
      expect(blocked.effect).toBe('none');
      expect(toolExecCount).toBe(1);

      // 4. Reconciling as confirmed_succeeded records ledger note, NEVER re-runs tool, and keeps duplicate call blocked
      const resSucceeded = await router.handle({
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/reconcile`,
        body: {
          reconciliationId: recId,
          resolution: 'confirmed_succeeded',
          note: 'Verified job J-100 in external console',
        },
        principal: LOCAL_DEFAULT_PRINCIPAL,
      });
      expect(resSucceeded.status).toBe(200);
      expect(toolExecCount).toBe(1);

      const stillBlocked = (await invoke({
        name: 'external_submit_job',
        arguments: { jobCode: 'J-100' },
        context: { chatId: chat.id },
      })) as Record<string, unknown>;
      expect(stillBlocked.error).toContain('reconciliation_committed');
      expect(toolExecCount).toBe(1);

      // 5. Reconciling as confirmed_not_executed releases lock WITHOUT auto-running tool; next explicit call succeeds
      const resNotExec = await router.handle({
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/reconcile`,
        body: {
          reconciliationId: recId,
          resolution: 'confirmed_not_executed',
          note: 'Queue was empty',
        },
        principal: LOCAL_DEFAULT_PRINCIPAL,
      });
      expect(resNotExec.status).toBe(200);
      expect(toolExecCount).toBe(1); // Still 1 — reconcile itself did NOT invoke tool!

      const afterUnlock = (await invoke({
        name: 'external_submit_job',
        arguments: { jobCode: 'J-100' },
        context: { chatId: chat.id },
      })) as Record<string, unknown>;
      expect(afterUnlock.success).toBe(true);
      expect(toolExecCount).toBe(2);
    } finally {
      endTurnSecurityContext(chat.id, sec);
    }
  });

  it('T-OUT-09: computePolicyDigest ignores model/UI fields and PolicyBoundApprovalStore invalidates allow_always on policy expansion', () => {
    const basePolicy = {
      approvalMode: 'host',
      sandboxEnforced: true,
      writableRoots: ['/work/proj-a'],
      allowedHosts: ['api.internal.local'],
      model: 'gpt-4o',
      theme: 'dark',
    };
    const modelChanged = {
      ...basePolicy,
      model: 'deepseek-v3',
      theme: 'light',
      baseUrl: 'https://new-llm.internal',
    };
    const expandedNetwork = {
      ...basePolicy,
      allowedHosts: ['api.internal.local', 'untrusted.example.com'],
    };

    const digest1 = computePolicyDigest(basePolicy);
    const digest2 = computePolicyDigest(modelChanged);
    const digest3 = computePolicyDigest(expandedNetwork);

    expect(digest1).toHaveLength(32);
    expect(digest1).toBe(digest2);
    expect(digest3).not.toBe(digest1);

    const storePath = path.join(tempDir, 'approvals.json');
    const approvalStore = new PolicyBoundApprovalStore(storePath);
    approvalStore.put(digest1, 'local_exec_shell', 'allow_always');
    expect(approvalStore.get(digest1, 'local_exec_shell')).toBe('allow_always');

    // Model switch keeps grant valid
    expect(approvalStore.get(digest2, 'local_exec_shell')).toBe('allow_always');

    // Policy expansion invalidates grant (requires fresh confirmation)
    expect(approvalStore.get(digest3, 'local_exec_shell')).toBeNull();
  });

  it('T-OUT-10: getHostActivitySnapshot transitions running_turn -> awaiting_human -> idle accurately', async () => {
    const chat = await store.createChat('Activity Probe');
    const p9 = ensurePhase9Store(store);

    expect(getHostActivitySnapshot({ pendingApprovals: 0 }).state).toBe('idle');

    const sec = beginTurnSecurityContext({
      chatId: chat.id,
      principal: LOCAL_DEFAULT_PRINCIPAL,
      originChannel: 'web',
      store,
    });
    expect(getHostActivitySnapshot({ pendingApprovals: 0 }).state).toBe('running_turn');
    endTurnSecurityContext(chat.id, sec);

    expect(getHostActivitySnapshot({ pendingApprovals: 1 }).state).toBe('awaiting_human');

    await p9.createPendingReconciliation({
      chatId: chat.id,
      toolName: 'external_write',
      argsDigest: 'deadbeef00001111',
      argsPreview: '{}',
      errorDetail: 'timeout',
    });
    expect(
      getHostActivitySnapshot({ pendingApprovals: 0, pendingReconciliations: 1 }).state,
    ).toBe('awaiting_human');
  });
});
