import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SqliteScopedStore } from '../../src/storage/index.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import { ToolRouter } from '../../src/tool-router.js';
import { executePresentFiles } from '../../src/present-files.js';
import {
  registerDeliverableVerifiers,
  registerPackDataSources,
  resetPhase9PackRegistries,
} from '../../src/scenario/applications.js';
import { RejectedBeforeEffectError } from '../../src/sidecar/rejected-before-effect.js';

describe('Phase 9 S3: UiSurface $source Drift, Authoritative Row Lookup, DeliverableVerifier & FactChainGraph', () => {
  let tempDir: string;
  let prevUserDataDir: string | undefined;
  let db: Database.Database;
  let store: SqliteScopedStore;
  let toolRouter: ToolRouter;
  let router: LocalBackendRouter;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'steerable-s3-'));
    prevUserDataDir = process.env.DEEPPATH_USER_DATA_DIR;
    process.env.DEEPPATH_USER_DATA_DIR = tempDir;
    db = new Database(path.join(tempDir, 'host.sqlite'));
    db.pragma('foreign_keys = ON');
    store = new SqliteScopedStore(db, { tenantId: 'local', userId: 'local' });
    await store.initialize();
    resetPhase9PackRegistries();
    toolRouter = new ToolRouter();
    router = new LocalBackendRouter(toolRouter, { store });
  });

  afterEach(() => {
    resetPhase9PackRegistries();
    if (prevUserDataDir === undefined) {
      delete process.env.DEEPPATH_USER_DATA_DIR;
    } else {
      process.env.DEEPPATH_USER_DATA_DIR = prevUserDataDir;
    }
    db?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('T-UIS-02: rejects UiSurface > 64 KiB, > 500 table rows, or unclosed component kinds via RejectedBeforeEffect', async () => {
    const chat = await store.createChat('Cap Test');

    // 1. Unknown component kind
    await expect(
      router.handle({
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/surfaces`,
        body: {
          surfaceId: 's-bad-kind',
          title: 'Bad Kind',
          components: [{ kind: 'arbitrary-html-iframe', id: 'x' }],
        },
      }),
    ).rejects.toBeInstanceOf(RejectedBeforeEffectError);

    // 2. 501 rows in table
    const rows501 = Array.from({ length: 501 }, (_, idx) => ({ id: `r-${idx}`, name: `Row ${idx}` }));
    await expect(
      router.handle({
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/surfaces`,
        body: {
          surfaceId: 's-501',
          title: 'Too Many Rows',
          components: [
            {
              kind: 'table',
              id: 't1',
              columns: [{ key: 'id', label: 'ID' }],
              rows: rows501,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(RejectedBeforeEffectError);

    // 3. > 64 KiB payload
    await expect(
      router.handle({
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/surfaces`,
        body: {
          surfaceId: 's-huge',
          title: 'Oversized',
          components: [
            {
              kind: 'detail-card',
              id: 'd1',
              fields: [{ key: 'blob', label: 'Blob', value: 'x'.repeat(70_000) }],
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(RejectedBeforeEffectError);
  });

  it('T-UIS-03 & T-UIS-04: $source drift returns 409 UI_STALE with zero tool calls; fresh submit uses server-authoritative rows and deduplicates (chatId, commandId)', async () => {
    const chat = await store.createChat('Approval Workbench');
    let liveTickets = [
      { id: 'T-101', vendor: 'Acme Industrial', amount: 50000, status: 'pending' },
      { id: 'T-102', vendor: 'Beta Logistics', amount: 12000, status: 'pending' },
    ];

    registerPackDataSources('test-pack', [
      {
        id: 'pending_tickets',
        description: 'Read-only pending tickets source',
        query: async () => liveTickets.map((r) => ({ ...r })),
      },
    ]);

    const executedBatches: Array<Record<string, unknown>> = [];
    toolRouter.registerToolContributions([
      {
        name: 'batch_approve_tickets',
        description: 'Approve selected tickets',
        mode: 'destructive',
        idempotent: false,
        checkpoint: 'outward',
        inputSchema: {
          type: 'object',
          properties: {
            selectedRowIds: { type: 'array' },
            selectedRows: { type: 'array' },
            note: { type: 'string' },
          },
        },
        handler: async (args) => {
          executedBatches.push(args);
          return { approvedCount: (args.selectedRows as unknown[])?.length ?? 0 };
        },
      },
    ]);

    const renderRes = await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/surfaces`,
      body: {
        surfaceId: 'ticket-approval',
        title: 'Pending Purchase Orders',
        data: {
          tickets: { $source: 'pending_tickets', params: { dept: 'ops' } },
        },
        components: [
          {
            kind: 'table',
            id: 'tbl-tickets',
            dataKey: 'tickets',
            rowIdField: 'id',
            selectable: true,
            columns: [
              { key: 'id', label: 'ID' },
              { key: 'vendor', label: 'Vendor' },
              { key: 'amount', label: 'Amount' },
            ],
          },
        ],
        actions: [
          {
            id: 'approve_selected',
            label: 'Batch Approve',
            toolName: 'batch_approve_tickets',
            dataKey: 'tickets',
            requiresSelection: true,
            checkpoint: 'outward',
          },
        ],
      },
    });
    expect(renderRes.status).toBe(200);
    const initialSurface = (renderRes.data as { surface: Record<string, unknown> }).surface;
    const initialHashes = initialSurface.sourceHashes as Record<string, string>;
    expect(initialHashes.tickets).toMatch(/^[0-9a-f]{64}$/);

    // Simulate external DB mutation BEFORE operator clicks submit -> must return 409 UI_STALE and NOT call tool!
    liveTickets = [
      { id: 'T-101', vendor: 'Acme Industrial', amount: 85000, status: 'pending' },
      { id: 'T-102', vendor: 'Beta Logistics', amount: 12000, status: 'pending' },
    ];

    const staleRes = await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/surfaces/ticket-approval/actions`,
      body: {
        commandId: 'cmd-stale-1',
        actionId: 'approve_selected',
        expectedRevision: initialSurface.revision,
        sourceHashes: initialHashes,
        selectedRowIds: ['T-101'],
      },
    });
    expect(staleRes.status).toBe(409);
    expect(staleRes.data).toEqual({
      code: 'UI_STALE',
      staleKeys: ['tickets'],
    });
    expect(executedBatches).toHaveLength(0);

    // Refresh surface -> picks up new revision & hash
    const refreshRes = await router.handle({
      method: 'GET',
      path: `/api/v2/chats/${chat.id}/surfaces/ticket-approval/refresh`,
    });
    expect(refreshRes.status).toBe(200);
    const refreshedSurface = (refreshRes.data as { surface: Record<string, unknown> }).surface;
    const freshHashes = refreshedSurface.sourceHashes as Record<string, string>;
    expect(refreshedSurface.revision).toBe(2);

    // Restricted channel (IM) trying to dispatch outward UI action -> blocked with 403
    const imBlocked = await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/surfaces/ticket-approval/actions`,
      originChannel: 'im',
      body: {
        commandId: 'cmd-im-1',
        actionId: 'approve_selected',
        expectedRevision: refreshedSurface.revision,
        sourceHashes: freshHashes,
        selectedRowIds: ['T-101'],
      },
    });
    expect(imBlocked.status).toBe(403);
    expect(executedBatches).toHaveLength(0);

    // T-UIS-04: Client attempts to forge `rows: [{ id: 'T-101', amount: 1 }]`; server ignores it and uses authoritative 85000!
    const okRes = await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/surfaces/ticket-approval/actions`,
      originChannel: 'web',
      body: {
        commandId: 'cmd-valid-1',
        actionId: 'approve_selected',
        expectedRevision: refreshedSurface.revision,
        sourceHashes: freshHashes,
        selectedRowIds: ['T-101'],
        rows: [{ id: 'T-101', vendor: 'Forged', amount: 1 }],
        note: 'Verified revised PO',
      },
    });
    expect(okRes.status).toBe(200);
    expect(executedBatches).toHaveLength(1);
    expect(executedBatches[0].selectedRows).toEqual([
      { id: 'T-101', vendor: 'Acme Industrial', amount: 85000, status: 'pending' },
    ]);

    // Duplicate submission with same (chatId, commandId) -> deduplicated without invoking tool a second time!
    const dupRes = await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/surfaces/ticket-approval/actions`,
      originChannel: 'web',
      body: {
        commandId: 'cmd-valid-1',
        actionId: 'approve_selected',
        expectedRevision: refreshedSurface.revision,
        sourceHashes: freshHashes,
        selectedRowIds: ['T-101'],
      },
    });
    expect(dupRes.status).toBe(200);
    expect((dupRes.data as { deduplicated: boolean }).deduplicated).toBe(true);
    expect(executedBatches).toHaveLength(1);
  });

  it('T-VER-01, T-VER-02, T-VER-03 & T-VER-05: DeliverableVerifier blocks unmasked/timed-out outputs, archives 0444 snapshot on pass, and FactChainGraph reports honest gaps & post-delivery edits', async () => {
    const chat = await store.createChat('Deliverable Audit');
    const draftPath = path.join(tempDir, 'report.md');
    writeFileSync(draftPath, 'Confidential SSN: 110101199003071234', 'utf8');

    registerDeliverableVerifiers('audit-pack', [
      {
        id: 'pii-redaction-check',
        description: 'Rejects unredacted 18-digit ID numbers in markdown deliverables',
        matchExtensions: ['.md'],
        verify: async ({ filePath }) => {
          const text = await import('node:fs/promises').then((fs) => fs.readFile(filePath, 'utf8'));
          if (/\b\d{18}\b/.test(text)) {
            return {
              status: 'failed',
              summary: 'Detected unmasked 18-digit ID',
              issues: [
                {
                  severity: 'blocking',
                  code: 'unmasked_id_number',
                  message: 'Found unmasked 18-digit ID number in deliverable',
                  location: 'line 1',
                },
              ],
            };
          }
          return {
            status: 'verified',
            summary: '0 unmasked PII entities found',
            issues: [],
          };
        },
      },
    ]);

    // T-VER-01: Blocking issue intercepts present_files and requests model follow-up
    const blocked = await executePresentFiles(
      { files: [{ path: draftPath, purpose: 'output' }] },
      tempDir,
      { store, chatId: chat.id },
    );
    expect(blocked.success).toBe(false);
    if (!blocked.success) {
      expect(blocked.needsFollowup).toBe(true);
      expect(blocked.error).toContain('deliverable_verification_failed');
      expect((blocked.data?.blockers as unknown[])?.length).toBe(1);
    }

    // Fix file content so verifier passes -> T-VER-03 immutable snapshot archived!
    const cleanText = 'Confidential SSN: 110101********1234';
    writeFileSync(draftPath, cleanText, 'utf8');
    const msg = await store.addMessage(
      chat.id,
      'assistant',
      'Here is the redacted report.',
      JSON.stringify({
        model: 'deepseek-chat',
        policyDigest: 'abcd1234',
        executedActions: [
          {
            id: 'act_redact_1',
            tool: 'redact_document',
            arguments: { path: draftPath },
            success: true,
          },
        ],
      }),
    );

    const passed = await executePresentFiles(
      { files: [{ path: draftPath, purpose: 'output' }] },
      tempDir,
      { store, chatId: chat.id, messageId: msg.id },
    );
    expect(passed.success).toBe(true);
    if (!passed.success) throw new Error('expected pass');
    expect(passed.deliverables).toHaveLength(1);
    const deliv = passed.deliverables![0];
    expect(deliv.verificationStatus).toBe('verified');

    // Mutate workspace file AFTER delivery -> FactChainGraph detects `workspaceState: 'modified'` while snapshot route still serves original bytes!
    writeFileSync(draftPath, 'TAMPERED AFTER DELIVERY', 'utf8');

    const fcRes = await router.handle({
      method: 'GET',
      path: `/api/v2/chats/${chat.id}/fact-chain?targetKind=deliverable&targetId=${encodeURIComponent(deliv.id)}`,
    });
    expect(fcRes.status).toBe(200);
    const graph = (fcRes.data as { graph: Record<string, unknown> }).graph;
    expect((graph.deliverableNode as { workspaceState: string }).workspaceState).toBe('modified');
    expect((graph.requestNode as { status: string; model: string }).status).toBe('recorded');
    expect((graph.toolNodes as unknown[]).length).toBe(1);

    const snapRaw = await router.handleRaw({
      method: 'GET',
      path: `/api/v2/chats/${chat.id}/deliverables/${deliv.id}/snapshot`,
    });
    expect('kind' in snapRaw && snapRaw.kind === 'file').toBe(true);
    if ('kind' in snapRaw && snapRaw.kind === 'file') {
      const snapBytes = await import('node:fs/promises').then((fs) =>
        fs.readFile(snapRaw.filePath, 'utf8'),
      );
      expect(snapBytes).toBe(cleanText);
    }

    // T-VER-02: Verifier timeout blocks present_files
    resetPhase9PackRegistries();
    registerDeliverableVerifiers('slow-pack', [
      {
        id: 'hanging-verifier',
        description: 'Simulates hung verifier',
        matchExtensions: ['.md'],
        verify: () => new Promise(() => {}),
      },
    ]);
    const timedOut = await executePresentFiles(
      { files: [{ path: draftPath, purpose: 'output' }] },
      tempDir,
      { store, chatId: chat.id, verifierTimeoutMs: 40 },
    );
    expect(timedOut.success).toBe(false);
    if (!timedOut.success) {
      expect(timedOut.needsFollowup).toBe(true);
      expect(timedOut.error).toContain('timed out');
    }

    // T-VER-05: Honest gap & no_tool_evidence
    const noToolChat = await store.createChat('Pure Chat');
    const pureMsg = await store.addMessage(
      noToolChat.id,
      'assistant',
      'Pure reasoning answer without tools.',
      JSON.stringify({ model: 'deepseek-chat', executedActions: [] }),
    );
    const noToolFc = await router.handle({
      method: 'GET',
      path: `/api/v2/chats/${noToolChat.id}/fact-chain?targetKind=message&targetId=${encodeURIComponent(pureMsg.id)}`,
    });
    const noToolGraph = (noToolFc.data as { graph: Record<string, unknown> }).graph;
    expect(noToolGraph.evidenceStatus).toBe('no_tool_evidence');
    expect(noToolGraph.toolNodes).toEqual([]);

    const importedChat = await store.createChat('Imported Chat');
    const importedMsg = await store.addMessage(
      importedChat.id,
      'assistant',
      'Legacy imported reply without metadata.',
    );
    const gapFc = await router.handle({
      method: 'GET',
      path: `/api/v2/chats/${importedChat.id}/fact-chain?targetKind=message&targetId=${encodeURIComponent(importedMsg.id)}`,
    });
    const gapGraph = (gapFc.data as { graph: Record<string, unknown> }).graph;
    expect((gapGraph.requestNode as { status: string }).status).toBe('gap');
  });
});
