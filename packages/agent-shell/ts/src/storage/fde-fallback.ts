/**
 * Ensures any ScopedStore exposes complete Phase9ScopedStore operations.
 *
 * SqliteScopedStore and MysqlScopedStore implement Phase9ScopedStore directly
 * against durable SQL tables; lightweight unit-test doubles fall back to
 * scope-isolated in-memory maps without losing tenant/user isolation.
 */
import { randomUUID } from 'node:crypto';
import type { ScopedStore } from './scoped-store.js';
import type {
  ChatDeliverableRecord,
  ChatUiReceiptRecord,
  ChatUiSurfaceRecord,
  MemoryDocumentRecord,
  MemoryEntryRecord,
  MemoryRefinementMetaRecord,
  MemoryScopeKind,
  PackCredentialRecord,
  PendingReconciliationRecord,
  Phase9ScopedStore,
} from './fde-types.js';

interface FallbackState {
  settings: Map<string, string>;
  credentials: Map<string, PackCredentialRecord>;
  reconciliations: Map<string, PendingReconciliationRecord>;
  surfaces: Map<string, ChatUiSurfaceRecord>;
  receipts: ChatUiReceiptRecord[];
  deliverables: Map<string, ChatDeliverableRecord>;
  memoryDocs: Map<string, MemoryDocumentRecord>;
  memoryEntries: Map<string, MemoryEntryRecord>;
  revokedHashes: Set<string>;
  refinementMeta: Map<string, MemoryRefinementMetaRecord>;
}

const tenantStates = new Map<string, FallbackState>();

function stateForTenant(tenantId: string): FallbackState {
  let s = tenantStates.get(tenantId);
  if (!s) {
    s = {
      settings: new Map(),
      credentials: new Map(),
      reconciliations: new Map(),
      surfaces: new Map(),
      receipts: [],
      deliverables: new Map(),
      memoryDocs: new Map(),
      memoryEntries: new Map(),
      revokedHashes: new Set(),
      refinementMeta: new Map(),
    };
    tenantStates.set(tenantId, s);
  }
  return s;
}

export function resetPhase9FallbackState(): void {
  tenantStates.clear();
}

export function ensurePhase9Store(store: ScopedStore): ScopedStore & Phase9ScopedStore {
  if (
    typeof store.upsertPackCredential === 'function' &&
    typeof store.createPendingReconciliation === 'function' &&
    typeof store.upsertChatUiSurface === 'function' &&
    typeof store.saveChatDeliverable === 'function' &&
    typeof store.upsertMemoryEntry === 'function' &&
    typeof store.getCustomSetting === 'function'
  ) {
    return store as ScopedStore & Phase9ScopedStore;
  }

  const scope = store.scope ?? { tenantId: 'local', userId: 'local' };
  const st = stateForTenant(scope.tenantId);
  const uPrefix = `${scope.userId}\u0000`;

  const fallback: Phase9ScopedStore = {
    async getCustomSetting(key) {
      if (typeof store.getCustomSetting === 'function') return store.getCustomSetting(key);
      return st.settings.get(`${uPrefix}${key}`) ?? null;
    },
    async setCustomSetting(key, value) {
      if (typeof store.setCustomSetting === 'function') return store.setCustomSetting(key, value);
      if (value === null) st.settings.delete(`${uPrefix}${key}`);
      else st.settings.set(`${uPrefix}${key}`, value);
    },
    async upsertPackCredential(input) {
      const updatedAt = new Date().toISOString();
      const rec: PackCredentialRecord = {
        tenantId: scope.tenantId,
        ownerUserId: input.ownerUserId,
        sourceId: input.sourceId,
        authKind: input.authKind,
        cipherText: input.cipherText,
        iv: input.iv,
        authTag: input.authTag,
        updatedBy: input.updatedBy,
        updatedAt,
      };
      st.credentials.set(`${input.ownerUserId}\u0000${input.sourceId}`, rec);
      return rec;
    },
    async getPackCredential(ownerUserId, sourceId) {
      return st.credentials.get(`${ownerUserId}\u0000${sourceId}`) ?? null;
    },
    async listPackCredentials(ownerUserIds) {
      const ids = new Set(ownerUserIds && ownerUserIds.length > 0 ? ownerUserIds : [scope.userId, '__tenant__']);
      return [...st.credentials.values()]
        .filter((r) => ids.has(r.ownerUserId))
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    },
    async deletePackCredential(ownerUserId, sourceId) {
      return st.credentials.delete(`${ownerUserId}\u0000${sourceId}`);
    },
    async createPendingReconciliation(input) {
      const id = input.id ?? randomUUID();
      const rec: PendingReconciliationRecord = {
        id,
        chatId: input.chatId,
        toolName: input.toolName,
        argsDigest: input.argsDigest,
        argsPreview: input.argsPreview,
        errorDetail: input.errorDetail,
        status: 'pending',
        resolutionNote: null,
        resolvedBy: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      st.reconciliations.set(`${uPrefix}${id}`, rec);
      return rec;
    },
    async listPendingReconciliations(chatId, options) {
      const out: PendingReconciliationRecord[] = [];
      for (const [k, rec] of st.reconciliations.entries()) {
        if (!k.startsWith(uPrefix) || rec.chatId !== chatId) continue;
        if (!options?.includeResolved && rec.status !== 'pending') continue;
        out.push(rec);
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async resolvePendingReconciliation(input) {
      const key = `${uPrefix}${input.reconciliationId}`;
      const existing = st.reconciliations.get(key);
      if (!existing || existing.chatId !== input.chatId) return null;
      const updated: PendingReconciliationRecord = {
        ...existing,
        status: input.status,
        resolutionNote: input.resolutionNote ?? null,
        resolvedBy: input.resolvedBy,
        resolvedAt: new Date().toISOString(),
      };
      st.reconciliations.set(key, updated);
      return updated;
    },
    async upsertChatUiSurface(input) {
      const key = `${uPrefix}${input.chatId}\u0000${input.spec.surfaceId}`;
      const existing = st.surfaces.get(key);
      const rec: ChatUiSurfaceRecord = {
        chatId: input.chatId,
        surfaceId: input.spec.surfaceId,
        revision: existing ? existing.revision + 1 : 1,
        title: { ...input.spec.title },
        spec: input.spec,
        state: input.state ?? existing?.state ?? {},
        status: input.status ?? existing?.status ?? 'active',
        updatedAt: new Date().toISOString(),
      };
      st.surfaces.set(key, rec);
      return rec;
    },
    async getChatUiSurface(chatId, surfaceId) {
      return st.surfaces.get(`${uPrefix}${chatId}\u0000${surfaceId}`) ?? null;
    },
    async listChatUiSurfaces(chatId) {
      const prefix = `${uPrefix}${chatId}\u0000`;
      const out: ChatUiSurfaceRecord[] = [];
      for (const [k, v] of st.surfaces.entries()) {
        if (k.startsWith(prefix)) out.push(v);
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async recordChatUiReceipt(input) {
      const rec: ChatUiReceiptRecord = {
        id: randomUUID(),
        chatId: input.chatId,
        surfaceId: input.surfaceId,
        revision: input.revision,
        actionId: input.actionId,
        toolName: input.toolName,
        payload: input.payload,
        sourceFingerprints: input.sourceFingerprints,
        result: input.result,
        actorId: input.actorId,
        createdAt: new Date().toISOString(),
      };
      st.receipts.push(rec);
      return rec;
    },
    async listChatUiReceipts(chatId, surfaceId) {
      return st.receipts
        .filter((r) => r.chatId === chatId && (!surfaceId || r.surfaceId === surfaceId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async saveChatDeliverable(input) {
      const id = input.id ?? randomUUID();
      const rec: ChatDeliverableRecord = {
        id,
        chatId: input.chatId,
        messageId: input.messageId ?? null,
        filePath: input.filePath,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        verificationStatus: input.verificationStatus,
        verifierId: input.verifierId ?? null,
        issues: [...(input.issues ?? [])],
        summary: input.summary ?? null,
        reportPath: input.reportPath ?? null,
        sourceRefs: [...(input.sourceRefs ?? [])],
        toolCalls: [...(input.toolCalls ?? [])],
        createdAt: new Date().toISOString(),
      };
      st.deliverables.set(`${uPrefix}${id}`, rec);
      return rec;
    },
    async listChatDeliverables(chatId) {
      const out: ChatDeliverableRecord[] = [];
      for (const [k, v] of st.deliverables.entries()) {
        if (k.startsWith(uPrefix) && v.chatId === chatId) out.push(v);
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getMemoryDocument(scopeKind, scopeId) {
      return st.memoryDocs.get(`${uPrefix}${scopeKind}\u0000${scopeId}`) ?? null;
    },
    async putMemoryDocument(input) {
      const rec: MemoryDocumentRecord = {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        contentMarkdown: input.contentMarkdown,
        contentSha256: input.contentSha256,
        updatedBy: input.updatedBy,
        sourceChatId: input.sourceChatId ?? null,
        updatedAt: new Date().toISOString(),
      };
      st.memoryDocs.set(`${uPrefix}${input.scopeKind}\u0000${input.scopeId}`, rec);
      return rec;
    },
    async listMemoryEntries(scopeKind, scopeId, includeRevoked = false) {
      const out: MemoryEntryRecord[] = [];
      for (const [k, v] of st.memoryEntries.entries()) {
        if (!k.startsWith(uPrefix)) continue;
        if (scopeKind && v.scopeKind !== scopeKind) continue;
        if (scopeId !== undefined && v.scopeId !== scopeId) continue;
        if (!includeRevoked && v.status !== 'active') continue;
        out.push(v);
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async upsertMemoryEntry(input) {
      const hashKey = `${uPrefix}${input.scopeKind}\u0000${input.scopeId}\u0000${input.contentSha256}`;
      const now = new Date().toISOString();
      if (st.revokedHashes.has(hashKey)) {
        return {
          skippedRevoked: true,
          entry: {
            id: input.id ?? randomUUID(),
            scopeKind: input.scopeKind,
            scopeId: input.scopeId,
            content: input.content,
            contentSha256: input.contentSha256,
            sourceChatId: input.sourceChatId ?? null,
            status: 'revoked',
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      for (const [k, existing] of st.memoryEntries.entries()) {
        if (
          k.startsWith(uPrefix) &&
          existing.scopeKind === input.scopeKind &&
          existing.scopeId === input.scopeId &&
          existing.contentSha256 === input.contentSha256
        ) {
          const updated: MemoryEntryRecord = {
            ...existing,
            content: input.content,
            status: 'active',
            updatedAt: now,
          };
          st.memoryEntries.set(k, updated);
          return { skippedRevoked: false, entry: updated };
        }
      }
      const id = input.id ?? randomUUID();
      const entry: MemoryEntryRecord = {
        id,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        content: input.content,
        contentSha256: input.contentSha256,
        sourceChatId: input.sourceChatId ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      st.memoryEntries.set(`${uPrefix}${id}`, entry);
      return { skippedRevoked: false, entry };
    },
    async revokeMemoryEntry(entryId) {
      const key = `${uPrefix}${entryId}`;
      const existing = st.memoryEntries.get(key);
      if (!existing) return null;
      const updated: MemoryEntryRecord = {
        ...existing,
        status: 'revoked',
        updatedAt: new Date().toISOString(),
      };
      st.memoryEntries.set(key, updated);
      st.revokedHashes.add(`${uPrefix}${existing.scopeKind}\u0000${existing.scopeId}\u0000${existing.contentSha256}`);
      return updated;
    },
    async isMemoryHashRevoked(scopeKind, scopeId, contentSha256) {
      return st.revokedHashes.has(`${uPrefix}${scopeKind}\u0000${scopeId}\u0000${contentSha256}`);
    },
    async clearMemoryScope(scopeKind, scopeId) {
      let deleted = 0;
      for (const [k, v] of [...st.memoryEntries.entries()]) {
        if (!k.startsWith(uPrefix)) continue;
        if (scopeKind && v.scopeKind !== scopeKind) continue;
        if (scopeId !== undefined && v.scopeId !== scopeId) continue;
        st.revokedHashes.add(`${uPrefix}${v.scopeKind}\u0000${v.scopeId}\u0000${v.contentSha256}`);
        st.memoryEntries.delete(k);
        deleted += 1;
      }
      for (const [k, v] of [...st.memoryDocs.entries()]) {
        if (!k.startsWith(uPrefix)) continue;
        if (scopeKind && v.scopeKind !== scopeKind) continue;
        if (scopeId !== undefined && v.scopeId !== scopeId) continue;
        st.memoryDocs.delete(k);
      }
      return deleted;
    },
    async getMemoryRefinementMeta(scopeKind: MemoryScopeKind, scopeId: string) {
      return (
        st.refinementMeta.get(`${uPrefix}${scopeKind}\u0000${scopeId}`) ?? {
          scopeKind,
          scopeId,
          refinedSessionCount: 0,
          lastRefinedAt: null,
          lastStatus: null,
        }
      );
    },
    async setMemoryRefinementMeta(input) {
      const rec: MemoryRefinementMetaRecord = {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        refinedSessionCount: input.refinedSessionCount,
        lastRefinedAt: input.lastRefinedAt ?? null,
        lastStatus: input.lastStatus ?? null,
      };
      st.refinementMeta.set(`${uPrefix}${input.scopeKind}\u0000${input.scopeId}`, rec);
      return rec;
    },
  };

  return Object.assign(Object.create(store), store, fallback) as ScopedStore & Phase9ScopedStore;
}
