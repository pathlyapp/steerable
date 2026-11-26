/**
 * Phase 9 host storage record contracts shared by SqliteScopedStore and
 * external storage drivers (such as Team Edition MysqlScopedStore).
 */
import type {
  UiSurfaceSpec,
  VerifierIssue,
} from '../scenario/pack.js';

export type CredentialOwnerScope = 'tenant' | 'user';

export interface PackCredentialRecord {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly sourceId: string;
  readonly authKind: string;
  readonly cipherText: string;
  readonly iv: string;
  readonly authTag: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface PendingReconciliationRecord {
  readonly id: string;
  readonly chatId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly argsPreview: string;
  readonly errorDetail: string;
  readonly status: 'pending' | 'confirmed_executed' | 'confirmed_not_executed';
  readonly resolutionNote: string | null;
  readonly resolvedBy: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface ChatUiSurfaceRecord {
  readonly chatId: string;
  readonly surfaceId: string;
  readonly revision: number;
  readonly title: Record<string, string>;
  readonly spec: UiSurfaceSpec;
  readonly state: Record<string, unknown>;
  readonly status: 'active' | 'submitted' | 'archived';
  readonly updatedAt: string;
}

export interface ChatUiReceiptRecord {
  readonly id: string;
  readonly chatId: string;
  readonly surfaceId: string;
  readonly revision: number;
  readonly actionId: string;
  readonly toolName: string;
  readonly payload: Record<string, unknown>;
  readonly sourceFingerprints: Record<string, string>;
  readonly result: Record<string, unknown>;
  readonly actorId: string;
  readonly createdAt: string;
}

export interface ChatDeliverableRecord {
  readonly id: string;
  readonly chatId: string;
  readonly messageId: string | null;
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly verificationStatus: 'verified' | 'warnings' | 'failed' | 'unverified';
  readonly verifierId: string | null;
  readonly issues: VerifierIssue[];
  readonly summary: string | null;
  readonly reportPath: string | null;
  readonly sourceRefs: string[];
  readonly toolCalls: Array<{ id?: string; tool: string; summary?: string }>;
  readonly createdAt: string;
}

export type MemoryScopeKind = 'user' | 'workspace' | 'tenant' | 'project' | 'agent';

export interface MemoryDocumentRecord {
  readonly scopeKind: MemoryScopeKind;
  readonly scopeId: string;
  readonly contentMarkdown: string;
  readonly contentSha256: string;
  readonly updatedBy: string;
  readonly sourceChatId: string | null;
  readonly updatedAt: string;
}

export interface MemoryEntryRecord {
  readonly id: string;
  readonly scopeKind: MemoryScopeKind;
  readonly scopeId: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly sourceChatId: string | null;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryRefinementMetaRecord {
  readonly scopeKind: MemoryScopeKind;
  readonly scopeId: string;
  readonly refinedSessionCount: number;
  readonly lastRefinedAt: string | null;
  readonly lastStatus: string | null;
}

/**
 * First-class persistence operations implemented by all production
 * StorageDrivers (SQLite and MySQL).
 */
export interface Phase9ScopedStore {
  getCustomSetting(key: string): Promise<string | null>;
  setCustomSetting(key: string, value: string | null): Promise<void>;

  upsertPackCredential(input: {
    ownerUserId: string;
    sourceId: string;
    authKind: string;
    cipherText: string;
    iv: string;
    authTag: string;
    updatedBy: string;
  }): Promise<PackCredentialRecord>;
  getPackCredential(ownerUserId: string, sourceId: string): Promise<PackCredentialRecord | null>;
  listPackCredentials(ownerUserIds?: readonly string[]): Promise<PackCredentialRecord[]>;
  deletePackCredential(ownerUserId: string, sourceId: string): Promise<boolean>;

  createPendingReconciliation(input: {
    id?: string;
    chatId: string;
    toolName: string;
    argsDigest: string;
    argsPreview: string;
    errorDetail: string;
  }): Promise<PendingReconciliationRecord>;
  listPendingReconciliations(
    chatId: string,
    options?: { includeResolved?: boolean },
  ): Promise<PendingReconciliationRecord[]>;
  resolvePendingReconciliation(input: {
    chatId: string;
    reconciliationId: string;
    status: 'confirmed_executed' | 'confirmed_not_executed';
    resolutionNote?: string | null;
    resolvedBy: string;
  }): Promise<PendingReconciliationRecord | null>;

  upsertChatUiSurface(input: {
    chatId: string;
    spec: UiSurfaceSpec;
    state?: Record<string, unknown>;
    status?: 'active' | 'submitted' | 'archived';
  }): Promise<ChatUiSurfaceRecord>;
  getChatUiSurface(chatId: string, surfaceId: string): Promise<ChatUiSurfaceRecord | null>;
  listChatUiSurfaces(chatId: string): Promise<ChatUiSurfaceRecord[]>;
  recordChatUiReceipt(input: {
    chatId: string;
    surfaceId: string;
    revision: number;
    actionId: string;
    toolName: string;
    payload: Record<string, unknown>;
    sourceFingerprints: Record<string, string>;
    result: Record<string, unknown>;
    actorId: string;
  }): Promise<ChatUiReceiptRecord>;
  listChatUiReceipts(chatId: string, surfaceId?: string): Promise<ChatUiReceiptRecord[]>;

  saveChatDeliverable(input: {
    id?: string;
    chatId: string;
    messageId?: string | null;
    filePath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    verificationStatus: 'verified' | 'warnings' | 'failed' | 'unverified';
    verifierId?: string | null;
    issues?: readonly VerifierIssue[];
    summary?: string | null;
    reportPath?: string | null;
    sourceRefs?: readonly string[];
    toolCalls?: ReadonlyArray<{ id?: string; tool: string; summary?: string }>;
  }): Promise<ChatDeliverableRecord>;
  listChatDeliverables(chatId: string): Promise<ChatDeliverableRecord[]>;

  getMemoryDocument(scopeKind: MemoryScopeKind, scopeId: string): Promise<MemoryDocumentRecord | null>;
  putMemoryDocument(input: {
    scopeKind: MemoryScopeKind;
    scopeId: string;
    contentMarkdown: string;
    contentSha256: string;
    updatedBy: string;
    sourceChatId?: string | null;
  }): Promise<MemoryDocumentRecord>;
  listMemoryEntries(
    scopeKind?: MemoryScopeKind,
    scopeId?: string,
    includeRevoked?: boolean,
  ): Promise<MemoryEntryRecord[]>;
  upsertMemoryEntry(input: {
    id?: string;
    scopeKind: MemoryScopeKind;
    scopeId: string;
    content: string;
    contentSha256: string;
    sourceChatId?: string | null;
  }): Promise<{ entry: MemoryEntryRecord; skippedRevoked: boolean }>;
  revokeMemoryEntry(entryId: string): Promise<MemoryEntryRecord | null>;
  isMemoryHashRevoked(
    scopeKind: MemoryScopeKind,
    scopeId: string,
    contentSha256: string,
  ): Promise<boolean>;
  clearMemoryScope(scopeKind?: MemoryScopeKind, scopeId?: string): Promise<number>;
  getMemoryRefinementMeta(
    scopeKind: MemoryScopeKind,
    scopeId: string,
  ): Promise<MemoryRefinementMetaRecord>;
  setMemoryRefinementMeta(input: {
    scopeKind: MemoryScopeKind;
    scopeId: string;
    refinedSessionCount: number;
    lastRefinedAt?: string | null;
    lastStatus?: string | null;
  }): Promise<MemoryRefinementMetaRecord>;
}
