import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SqliteScopedStore } from '../../src/storage/index.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import { ToolRouter } from '../../src/tool-router.js';
import { LocalExecutor } from '../../src/local-executor.js';
import { maybeRefreshDriftedChatTitle } from '../../src/local-backend/title-refresh.js';
import { SecretRedactor } from '../../src/auth/credentials.js';
import {
  MAX_MEMORY_INDEX_BYTES,
  MemoryStore,
  RSI_TTL_MS,
} from '../../src/memory/store.js';
import {
  buildMemoryTurnInjection,
  didChatContributeMemory,
  resetMemorySnapshotsForTests,
} from '../../src/memory/injector.js';
import {
  promoteAuthoringCandidate,
  stageAuthoringCandidate,
} from '../../src/memory/authoring-candidates.js';
import { redactInsightText } from '../../src/storage/insights-redact.js';
import { RejectedBeforeEffectError } from '../../src/sidecar/rejected-before-effect.js';
import type { Principal } from '../../src/auth/index.js';

describe('Phase 9 S4: Title Refresh, Dual-Layer Memory, Snapshot KV Cache, Zero-Trust RSI & Privacy', () => {
  let tempDir: string;
  let prevUserDataDir: string | undefined;
  let db: Database.Database;
  let store: SqliteScopedStore;
  let toolRouter: ToolRouter;
  let router: LocalBackendRouter;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'steerable-s4-'));
    prevUserDataDir = process.env.DEEPPATH_USER_DATA_DIR;
    process.env.DEEPPATH_USER_DATA_DIR = tempDir;
    resetMemorySnapshotsForTests();
    db = new Database(path.join(tempDir, 'host.sqlite'));
    db.pragma('foreign_keys = ON');
    store = new SqliteScopedStore(db, { tenantId: 'tenant-acme', userId: 'alice' });
    await store.initialize();
    toolRouter = new ToolRouter();
    router = new LocalBackendRouter(toolRouter, { store });
  });

  afterEach(() => {
    resetMemorySnapshotsForTests();
    if (prevUserDataDir === undefined) {
      delete process.env.DEEPPATH_USER_DATA_DIR;
    } else {
      process.env.DEEPPATH_USER_DATA_DIR = prevUserDataDir;
    }
    db?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T-SC-05: maybeRefreshDriftedChatTitle updates auto titles on 6th turn with scrubbed window and strictly skips user-renamed chats', async () => {
    const autoChat = await store.createChat('Initial Greeting');
    // Default titleSource is 'auto'; populate 6 user+assistant exchanges
    for (let i = 1; i <= 6; i += 1) {
      await store.addMessage(autoChat.id, 'user', `Turn ${i} secret=my-secret-key-9988`);
      await store.addMessage(autoChat.id, 'assistant', `Reply ${i} about Q4 financial audit`);
    }

    const redactor = new SecretRedactor();
    redactor.registerSecret('my-secret-key-9988');
    const evaluator = vi.fn().mockResolvedValue({
      drifted: true,
      newTitle: 'Q4 Financial Audit Review',
    });

    const refreshed = await maybeRefreshDriftedChatTitle({
      store,
      chatId: autoChat.id,
      evaluateDrift: evaluator,
      redactor,
    });
    expect(refreshed.updated).toBe(true);
    expect(refreshed.title).toBe('Q4 Financial Audit Review');
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(evaluator.mock.calls[0][0].scrubbedHead).not.toContain('my-secret-key-9988');

    // Lock titleSource = 'user' -> evaluator MUST NOT even be called!
    await store.updateChat(autoChat.id, {
      title: 'My CustomPinned Title',
      titleSource: 'user',
    });
    evaluator.mockClear();

    const skipped = await maybeRefreshDriftedChatTitle({
      store,
      chatId: autoChat.id,
      evaluateDrift: evaluator,
    });
    expect(skipped).toEqual({
      updated: false,
      skippedReason: 'user_locked_title',
      title: 'My CustomPinned Title',
    });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it('T-MEM-01 & T-MEM-02: isolates <userDataDir>/memory from LocalExecutor file/shell tools and enforces user/workspace/tenant RBAC', async () => {
    const alice: Principal = {
      id: 'alice',
      tenantId: 'tenant-acme',
      displayName: 'Alice',
      isAdmin: false,
      roles: ['member'],
      authSource: 'oidc',
    };
    const admin: Principal = {
      id: 'admin-1',
      tenantId: 'tenant-acme',
      displayName: 'Admin',
      isAdmin: true,
      roles: ['admin'],
      authSource: 'oidc',
    };

    // Admin writes tenant shared rules -> 200
    const adminPut = await router.handle({
      method: 'PUT',
      path: '/api/v2/memory',
      principal: admin,
      body: {
        scope: 'tenant',
        contentMarkdown: 'Always format currency in CNY with two decimals.',
      },
    });
    expect(adminPut.status).toBe(200);

    // Non-admin Alice tries to write tenant rules -> 403
    const aliceForbiddenTenantWrite = await router.handle({
      method: 'PUT',
      path: '/api/v2/memory',
      principal: alice,
      body: {
        scope: 'tenant',
        contentMarkdown: 'Unauthorized override',
      },
    });
    expect(aliceForbiddenTenantWrite.status).toBe(403);

    // Non-admin Alice CAN read tenant rules
    const aliceReadTenant = await router.handle({
      method: 'GET',
      path: '/api/v2/memory?scope=tenant',
      principal: alice,
    });
    expect(aliceReadTenant.status).toBe(200);
    expect((aliceReadTenant.data as { contentMarkdown: string }).contentMarkdown).toContain(
      'CNY with two decimals',
    );

    // Alice tries to read Bob's personal memory -> 403
    const crossUserRead = await router.handle({
      method: 'GET',
      path: '/api/v2/memory?scope=user&scopeId=bob',
      principal: alice,
    });
    expect(crossUserRead.status).toBe(403);

    // T-MEM-01: LocalExecutor blocks reading, writing, and shell cat on <userDataDir>/memory
    const executor = new LocalExecutor();
    const privateMemFile = path.join(tempDir, 'memory', 'tenant', 'MEMORY.md');

    const readAttempt = await executor.readLocalFile({ path: privateMemFile });
    expect(readAttempt.success).toBe(false);
    expect(readAttempt.error).toContain('host-isolated private storage');

    const writeAttempt = await executor.writeLocalFile({
      path: privateMemFile,
      content: 'pwned',
      createDirs: true,
    });
    expect(writeAttempt.success).toBe(false);
    expect(writeAttempt.error).toContain('host-isolated private storage');

    const shellAttempt = await executor.executeShell({
      command: `cat "${privateMemFile}"`,
    });
    expect(shellAttempt.success).toBe(false);
    expect(shellAttempt.error).toContain('private-deny');
  });

  it('T-MEM-03, T-MEM-04, T-MEM-05 & T-MEM-09: preserves prefix snapshot across mid-session edits/withdraws, refreshes post-compaction, rejects >16 KiB without FIFO eviction, and strips insights free text', async () => {
    const memStore = new MemoryStore(store);
    await memStore.setPermissionMode('auto');
    const ruleOne = 'Rule #1: Never delete historical audit rows.';
    await memStore.writeDocument({
      scope: 'workspace',
      scopeId: 'proj-1',
      contentMarkdown: ruleOne,
    });

    // T-MEM-05: Capacity overflow (>16 KiB) rejects with MEMORY_CONSOLIDATION_REQUIRED and leaves Rule #1 intact!
    await expect(
      memStore.writeDocument({
        scope: 'workspace',
        scopeId: 'proj-1',
        contentMarkdown: `${ruleOne}\n${'x'.repeat(MAX_MEMORY_INDEX_BYTES + 100)}`,
      }),
    ).rejects.toBeInstanceOf(RejectedBeforeEffectError);
    const intact = await memStore.readDocument({ scope: 'workspace', scopeId: 'proj-1' });
    expect(intact.contentMarkdown).toBe(ruleOne);

    // Turn 1: Anchors initial snapshot
    const turn1 = await buildMemoryTurnInjection({
      memoryStore: memStore,
      chatId: 'chat-kv-1',
      workspaceId: 'proj-1',
      compactionEpoch: 0,
    });
    expect(turn1.anchoredPrefixNote).toContain('<untrusted_memory_note trust="untrusted">');
    expect(turn1.anchoredPrefixNote).toContain(ruleOne);
    expect(turn1.tailDeltaNotice).toBe('');
    expect(didChatContributeMemory('chat-kv-1')).toBe(true);

    // T-MEM-09: Insights free-text redactor strips all text for chats where memory contributed!
    expect(redactInsightText('Sensitive preference text', 200, { chatId: 'chat-kv-1' })).toBe('');
    expect(redactInsightText('Normal non-memory chat', 200, { chatId: 'chat-clean' })).toBe(
      'Normal non-memory chat',
    );

    // Mid-session propose & withdraw via router
    const propRes = await router.handle({
      method: 'POST',
      path: '/api/v2/memory/propose',
      body: {
        scope: 'workspace',
        scopeId: 'proj-1',
        chatId: 'chat-kv-1',
        turnId: 'turn-2',
        content: 'Prefer ISO-8601 dates in exports.',
      },
    });
    const refId = (propRes.data as { meta: { id: string } }).meta.id;

    // Turn 3 (no compaction): anchoredPrefixNote MUST be 100% byte-identical to Turn 1; delta appears in tail!
    const turn3 = await buildMemoryTurnInjection({
      memoryStore: memStore,
      chatId: 'chat-kv-1',
      workspaceId: 'proj-1',
      compactionEpoch: 0,
    });
    expect(turn3.anchoredPrefixNote).toBe(turn1.anchoredPrefixNote);
    expect(turn3.tailDeltaNotice).toContain(`[memory delta] saved workspace paragraph ${refId}`);

    // CompactionBoundary occurs (`compactionEpoch: 1`) -> snapshot refreshes to include new paragraph!
    const postCompact = await buildMemoryTurnInjection({
      memoryStore: memStore,
      chatId: 'chat-kv-1',
      workspaceId: 'proj-1',
      compactionEpoch: 1,
    });
    expect(postCompact.anchoredPrefixNote).toContain('Prefer ISO-8601 dates in exports.');
    expect(postCompact.tailDeltaNotice).toBe('');
  });

  it('T-MEM-06, T-MEM-07, T-MEM-08 & T-MEM-10: enforces 30d RSI expiry, Make ordinary, humanEdited protection, user-revoked blacklist, subagent write ban, baseHash lock & authoring-candidates', async () => {
    const memStore = new MemoryStore(store);
    await memStore.setPermissionMode('auto');
    const t0 = Date.UTC(2026, 10, 1);

    const proposed = await memStore.proposeRefinement({
      id: 'r001',
      scope: 'workspace',
      scopeId: 'proj-rsi',
      content: 'Retry transient 502 gateway errors once.',
      evidence: { chatId: 'c1', turnId: 't1', toolCallId: 'tc1' },
      nowMs: t0,
    });
    expect(proposed.accepted).toBe(true);

    // T-MEM-06: At +31 days, expired active RSI paragraph is hidden from model injection without deleting source text!
    const expiredVisible = await memStore.renderVisibleMarkdownForScope({
      scope: 'workspace',
      scopeId: 'proj-rsi',
      principal: {
        id: 'alice',
        tenantId: 'tenant-acme',
        displayName: 'Alice',
        isAdmin: false,
        roles: [],
        authSource: 'local',
      },
      budgetBytes: 4096,
      nowMs: t0 + RSI_TTL_MS + 60_000,
    });
    expect(expiredVisible).toBe('');
    const rawDocStillIntact = await memStore.readDocument({
      scope: 'workspace',
      scopeId: 'proj-rsi',
    });
    expect(rawDocStillIntact.contentMarkdown).toContain('Retry transient 502 gateway errors once.');

    // Convert to ordinary ("Make ordinary") -> permanently visible even after +31 days!
    await memStore.convertRefinementToOrdinary({
      refinementId: 'r001',
      workspaceId: 'proj-rsi',
    });
    const ordinaryVisible = await memStore.renderVisibleMarkdownForScope({
      scope: 'workspace',
      scopeId: 'proj-rsi',
      principal: {
        id: 'alice',
        tenantId: 'tenant-acme',
        displayName: 'Alice',
        isAdmin: false,
        roles: [],
        authSource: 'local',
      },
      budgetBytes: 4096,
      nowMs: t0 + RSI_TTL_MS * 3,
    });
    expect(ordinaryVisible).toContain('Retry transient 502 gateway errors once.');

    // T-MEM-07: Human-edited RSI block is protected from auto-overwrite; withdraw permanently blacklists content!
    await memStore.proposeRefinement({
      id: 'r002',
      scope: 'workspace',
      scopeId: 'proj-rsi',
      content: 'Use port 8080 for staging.',
      evidence: { chatId: 'c1', turnId: 't2' },
    });
    const beforeHuman = await memStore.readDocument({ scope: 'workspace', scopeId: 'proj-rsi' });
    const editedMd = beforeHuman.contentMarkdown.replace('8080', '9090');
    const savedHuman = await memStore.writeDocument({
      scope: 'workspace',
      scopeId: 'proj-rsi',
      contentMarkdown: editedMd,
      baseHash: beforeHuman.contentSha256,
      isHumanEdit: true,
    });

    // T-MEM-10: Stale baseHash returns 409 MEMORY_BASE_HASH_CONFLICT
    const stalePut = await router.handle({
      method: 'PUT',
      path: '/api/v2/memory',
      body: {
        scope: 'workspace',
        scopeId: 'proj-rsi',
        contentMarkdown: 'stale overwrite',
        baseHash: beforeHuman.contentSha256,
      },
    });
    expect(stalePut.status).toBe(409);
    expect((stalePut.data as { code: string }).code).toBe('MEMORY_BASE_HASH_CONFLICT');
    expect(savedHuman.contentSha256).not.toBe(beforeHuman.contentSha256);

    // Attempting to overwrite human-edited r002 creates a conflictDraft instead of overwriting!
    const overwriteAttempt = await memStore.proposeRefinement({
      id: 'r002',
      scope: 'workspace',
      scopeId: 'proj-rsi',
      content: 'Use port 7070 for staging.',
      evidence: { chatId: 'c1', turnId: 't3' },
    });
    expect(overwriteAttempt.accepted).toBe(false);
    if (!overwriteAttempt.accepted) {
      expect(overwriteAttempt.reason).toBe('human_edited_conflict');
      expect(overwriteAttempt.conflictDraft).toBeDefined();
    }

    // Withdraw r002 -> permanently blocks re-learning same text!
    await memStore.withdrawRefinement({ refinementId: 'r002', workspaceId: 'proj-rsi' });
    const reProposeRevoked = await memStore.proposeRefinement({
      scope: 'workspace',
      scopeId: 'proj-rsi',
      content: 'Use port 9090 for staging.',
      evidence: { chatId: 'c1', turnId: 't4' },
    });
    expect(reProposeRevoked).toEqual({ accepted: false, reason: 'user_revoked' });

    // T-MEM-08: Subagent & fork cannot call memory_propose, but CAN call memory_read
    const subWrite = (await toolRouter.execute(
      { name: 'memory_propose', arguments: { content: 'Subagent note' } },
      { chatId: 'sub-1', isSubagent: true },
    )) as { success: boolean; error: string };
    expect(subWrite.success).toBe(false);
    expect(subWrite.error).toBe('subagent_memory_write_forbidden');

    const subRead = (await toolRouter.execute(
      { name: 'memory_read', arguments: { scope: 'workspace' } },
      { chatId: 'sub-1', projectRoot: 'proj-rsi', isSubagent: true },
    )) as { success: boolean; contentMarkdown: string };
    expect(subRead.success).toBe(true);

    // Dual-hash quarantine sandbox for candidate SKILL.md
    const staged = await stageAuthoringCandidate({
      name: 'ledger-helper',
      skillMarkdown: '# Ledger Helper\nCheck row totals before export.',
      reviewSummary: 'Safe pure instruction skill',
      sourceChatId: 'c1',
    });
    expect(staged.staticCheckPassed).toBe(true);
    await expect(
      promoteAuthoringCandidate({
        id: staged.id,
        expectedCandidateHash: 'tampered',
        expectedReviewHash: staged.reviewHash,
      }),
    ).rejects.toThrow('authoring_candidate_hash_mismatch');
    const promoted = await promoteAuthoringCandidate({
      id: staged.id,
      expectedCandidateHash: staged.candidateHash,
      expectedReviewHash: staged.reviewHash,
    });
    expect(promoted.installedPath).toContain(path.join('skills', 'ledger-helper', 'SKILL.md'));
  });
});
