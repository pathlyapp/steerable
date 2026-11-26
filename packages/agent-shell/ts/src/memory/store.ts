/**
 * Dual-Layer Memory (`MEMORY.md` + `topics/*.md`) & Zero-Trust RSI store (Phase 9 R8).
 *
 * Storage & security invariants:
 * 1. Never stored inside the workspace git tree: local desktop mirrors live under
 *    `<userDataDir>/memory/`, which is blocked from shell/file tools (`PRIVATE_DENY`).
 * 2. Multi-tenant `ScopedStore` isolation across `user | workspace | tenant`:
 *    - `user`: strictly scoped to `principal.id`;
 *    - `workspace`: scoped to canonical workspace/project identifier;
 *    - `tenant`: readable by all members of `principal.tenantId`, writable ONLY by `principal.isAdmin`.
 * 3. Capacity overflow throws `RejectedBeforeEffectError` (`MEMORY_CONSOLIDATION_REQUIRED`,
 *    `effect: 'none'`) — never silently truncates or FIFO-evicts user rules.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_DEFAULT_PRINCIPAL, type Principal } from '../auth/index.js';
import { getUserDataDir } from '../runtime.js';
import { RejectedBeforeEffectError } from '../sidecar/rejected-before-effect.js';
import { ensurePhase9Store } from '../storage/fde-fallback.js';
import type { MemoryScopeKind } from '../storage/fde-types.js';
import type { ScopedStore } from '../storage/scoped-store.js';

export const MAX_MEMORY_INDEX_BYTES = 16 * 1024;
export const MAX_MEMORY_INDEX_LINES = 200;
export const MAX_MEMORY_TOPIC_BYTES = 32 * 1024;
export const MAX_MEMORY_TOTAL_BYTES = 256 * 1024;

export const TENANT_INJECT_BUDGET_BYTES = 2 * 1024;
export const WORKSPACE_INJECT_BUDGET_BYTES = 6 * 1024;
export const USER_INJECT_BUDGET_BYTES = 2 * 1024;

export const RSI_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MEMORY_PERMISSION_SETTING_KEY = 'memory_permission_mode';
export type MemoryPermissionMode = 'off' | 'ask' | 'auto';

const META_SETTING_PREFIX = 'memory_rsi_meta:';
const REVOKED_SETTING_PREFIX = 'memory_revoked_set:';
const TOPICS_SETTING_PREFIX = 'memory_topics:';
const CONFLICTS_SETTING_PREFIX = 'memory_conflicts:';

export interface RefinementEvidence {
  readonly chatId: string;
  readonly turnId: string;
  readonly toolCallId?: string;
}

export interface RefinementParagraphMeta {
  readonly id: string;
  readonly normalizedHash: string;
  readonly scope: MemoryScopeKind;
  readonly scopeId: string;
  readonly content: string;
  readonly evidence: RefinementEvidence;
  readonly humanEdited: boolean;
  readonly status: 'active' | 'ordinary' | 'withdrawn';
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface MemoryConflictDraft {
  readonly id: string;
  readonly targetRefinementId: string;
  readonly proposedContent: string;
  readonly createdAt: string;
}

export class MemoryAccessDeniedError extends Error {
  readonly status = 403;
  readonly code = 'memory_access_denied';
  constructor(message: string) {
    super(message);
    this.name = 'MemoryAccessDeniedError';
  }
}

export class MemoryBaseHashConflictError extends Error {
  readonly status = 409;
  readonly code = 'MEMORY_BASE_HASH_CONFLICT';
  readonly currentHash: string;
  constructor(currentHash: string) {
    super('Memory document changed concurrently (baseHash mismatch). Reload before saving.');
    this.name = 'MemoryBaseHashConflictError';
    this.currentHash = currentHash;
  }
}

export function getHostMemoryRootDir(): string {
  return path.join(getUserDataDir(), 'memory');
}

export function hashWorkspaceScopeId(workspacePathOrId: string): string {
  const trimmed = workspacePathOrId.trim();
  if (!trimmed) return 'default';
  return createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 24);
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeMemoryParagraphHash(raw: string): string {
  const stripped = raw
    .replace(/<!--\s*\/?refinement:[a-zA-Z0-9_-]+\s*-->/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return sha256Text(stripped);
}

const REFINEMENT_BLOCK_RE =
  /<!--\s*refinement:([a-zA-Z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/refinement:\1\s*-->/g;

export function extractRefinementBlocks(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  REFINEMENT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFINEMENT_BLOCK_RE.exec(markdown)) !== null) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

function containsWorkspaceSpecificPath(text: string): boolean {
  return /(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\[A-Za-z0-9._\\-]+/.test(text);
}

function resolveAuthoritativeScopeId(
  scope: MemoryScopeKind,
  requestedScopeId: string | undefined,
  principal: Principal,
): string {
  if (scope === 'user') {
    if (
      requestedScopeId &&
      requestedScopeId !== principal.id &&
      requestedScopeId !== 'self'
    ) {
      throw new MemoryAccessDeniedError(
        `Principal "${principal.id}" cannot access user memory belonging to "${requestedScopeId}".`,
      );
    }
    return principal.id;
  }
  if (scope === 'tenant') {
    const targetTenant = requestedScopeId?.trim() || principal.tenantId;
    if (targetTenant !== principal.tenantId) {
      throw new MemoryAccessDeniedError(
        `Principal "${principal.id}" cannot access tenant memory "${targetTenant}".`,
      );
    }
    return principal.tenantId;
  }
  return requestedScopeId?.trim() || 'default';
}

function assertWritePermission(scope: MemoryScopeKind, principal: Principal): void {
  if (scope === 'tenant' && !principal.isAdmin) {
    throw new MemoryAccessDeniedError(
      'Only tenant administrators can modify tenant-wide shared memory.',
    );
  }
}

function enforceIndexCapacity(markdown: string): { bytes: number; lines: number } {
  const bytes = Buffer.byteLength(markdown, 'utf8');
  const lines = markdown.length === 0 ? 0 : markdown.split('\n').length;
  if (bytes > MAX_MEMORY_INDEX_BYTES || lines > MAX_MEMORY_INDEX_LINES) {
    throw RejectedBeforeEffectError.create(
      'MEMORY_CONSOLIDATION_REQUIRED',
      `MEMORY.md exceeds capacity (${bytes}/${MAX_MEMORY_INDEX_BYTES} bytes, ${lines}/${MAX_MEMORY_INDEX_LINES} lines). Consolidate or move detailed notes to topics/*.md instead of evicting existing rules.`,
      true,
    );
  }
  return { bytes, lines };
}

export class MemoryStore {
  constructor(private readonly store: ScopedStore) {}

  private get p9() {
    return ensurePhase9Store(this.store);
  }

  async getPermissionMode(): Promise<MemoryPermissionMode> {
    const raw = await this.p9.getCustomSetting(MEMORY_PERMISSION_SETTING_KEY);
    if (raw === 'off' || raw === 'ask' || raw === 'auto') return raw;
    return 'ask';
  }

  async setPermissionMode(mode: MemoryPermissionMode): Promise<void> {
    await this.p9.setCustomSetting(MEMORY_PERMISSION_SETTING_KEY, mode);
  }

  private metaKey(scope: MemoryScopeKind, scopeId: string): string {
    return `${META_SETTING_PREFIX}${scope}:${scopeId}`;
  }

  private revokedKey(scope: MemoryScopeKind, scopeId: string): string {
    return `${REVOKED_SETTING_PREFIX}${scope}:${scopeId}`;
  }

  private topicsKey(scope: MemoryScopeKind, scopeId: string): string {
    return `${TOPICS_SETTING_PREFIX}${scope}:${scopeId}`;
  }

  private conflictsKey(scope: MemoryScopeKind, scopeId: string): string {
    return `${CONFLICTS_SETTING_PREFIX}${scope}:${scopeId}`;
  }

  private async loadMetaList(
    scope: MemoryScopeKind,
    scopeId: string,
  ): Promise<RefinementParagraphMeta[]> {
    const raw = await this.p9.getCustomSetting(this.metaKey(scope, scopeId));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RefinementParagraphMeta[]) : [];
    } catch {
      return [];
    }
  }

  private async saveMetaList(
    scope: MemoryScopeKind,
    scopeId: string,
    items: readonly RefinementParagraphMeta[],
  ): Promise<void> {
    await this.p9.setCustomSetting(this.metaKey(scope, scopeId), JSON.stringify(items));
  }

  private async loadRevokedSet(scope: MemoryScopeKind, scopeId: string): Promise<Set<string>> {
    const raw = await this.p9.getCustomSetting(this.revokedKey(scope, scopeId));
    if (!raw) return new Set();
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
        : new Set();
    } catch {
      return new Set();
    }
  }

  private async saveRevokedSet(
    scope: MemoryScopeKind,
    scopeId: string,
    hashes: ReadonlySet<string>,
  ): Promise<void> {
    await this.p9.setCustomSetting(this.revokedKey(scope, scopeId), JSON.stringify([...hashes]));
  }

  private async loadTopicsMap(
    scope: MemoryScopeKind,
    scopeId: string,
  ): Promise<Record<string, string>> {
    const raw = await this.p9.getCustomSetting(this.topicsKey(scope, scopeId));
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  private async saveTopicsMap(
    scope: MemoryScopeKind,
    scopeId: string,
    topics: Record<string, string>,
  ): Promise<void> {
    await this.p9.setCustomSetting(this.topicsKey(scope, scopeId), JSON.stringify(topics));
  }

  async listConflicts(
    scope: MemoryScopeKind,
    requestedScopeId: string | undefined,
    principal: Principal = LOCAL_DEFAULT_PRINCIPAL,
  ): Promise<MemoryConflictDraft[]> {
    const scopeId = resolveAuthoritativeScopeId(scope, requestedScopeId, principal);
    const raw = await this.p9.getCustomSetting(this.conflictsKey(scope, scopeId));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MemoryConflictDraft[]) : [];
    } catch {
      return [];
    }
  }

  private async appendConflict(
    scope: MemoryScopeKind,
    scopeId: string,
    draft: MemoryConflictDraft,
  ): Promise<void> {
    const existing = await this.listConflicts(scope, scopeId, {
      ...LOCAL_DEFAULT_PRINCIPAL,
      id: scope === 'user' ? scopeId : LOCAL_DEFAULT_PRINCIPAL.id,
      tenantId: scope === 'tenant' ? scopeId : LOCAL_DEFAULT_PRINCIPAL.tenantId,
      isAdmin: true,
    });
    await this.p9.setCustomSetting(
      this.conflictsKey(scope, scopeId),
      JSON.stringify([...existing, draft]),
    );
  }

  private async mirrorToHostPrivateDisk(
    scope: MemoryScopeKind,
    scopeId: string,
    contentMarkdown: string,
  ): Promise<void> {
    const root = getHostMemoryRootDir();
    const dir =
      scope === 'workspace'
        ? path.join(root, 'workspaces', hashWorkspaceScopeId(scopeId))
        : path.join(root, scope, hashWorkspaceScopeId(scopeId));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, 'MEMORY.md'), contentMarkdown, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async readDocument(options: {
    readonly scope: MemoryScopeKind;
    readonly scopeId?: string;
    readonly principal?: Principal;
  }): Promise<{
    readonly scope: MemoryScopeKind;
    readonly scopeId: string;
    readonly contentMarkdown: string;
    readonly contentSha256: string;
    readonly bytesUsed: number;
    readonly maxBytes: number;
    readonly linesUsed: number;
    readonly maxLines: number;
    readonly refinements: RefinementParagraphMeta[];
    readonly revokedHashes: string[];
    readonly topics: string[];
    readonly conflicts: MemoryConflictDraft[];
  }> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const scopeId = resolveAuthoritativeScopeId(options.scope, options.scopeId, principal);
    const doc = await this.p9.getMemoryDocument(options.scope, scopeId);
    const contentMarkdown = doc?.contentMarkdown ?? '';
    const contentSha256 = doc?.contentSha256 ?? sha256Text('');
    const bytesUsed = Buffer.byteLength(contentMarkdown, 'utf8');
    const linesUsed = contentMarkdown.length === 0 ? 0 : contentMarkdown.split('\n').length;
    const refinements = await this.loadMetaList(options.scope, scopeId);
    const revoked = await this.loadRevokedSet(options.scope, scopeId);
    const topicsMap = await this.loadTopicsMap(options.scope, scopeId);
    const conflicts = await this.listConflicts(options.scope, scopeId, principal);
    return {
      scope: options.scope,
      scopeId,
      contentMarkdown,
      contentSha256,
      bytesUsed,
      maxBytes: MAX_MEMORY_INDEX_BYTES,
      linesUsed,
      maxLines: MAX_MEMORY_INDEX_LINES,
      refinements,
      revokedHashes: [...revoked],
      topics: Object.keys(topicsMap).sort(),
      conflicts,
    };
  }

  async writeDocument(options: {
    readonly scope: MemoryScopeKind;
    readonly scopeId?: string;
    readonly principal?: Principal;
    readonly contentMarkdown: string;
    readonly baseHash?: string;
    readonly sourceChatId?: string | null;
    readonly isHumanEdit?: boolean;
  }): Promise<{
    readonly contentMarkdown: string;
    readonly contentSha256: string;
    readonly bytesUsed: number;
    readonly linesUsed: number;
  }> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const scopeId = resolveAuthoritativeScopeId(options.scope, options.scopeId, principal);
    assertWritePermission(options.scope, principal);

    const current = await this.p9.getMemoryDocument(options.scope, scopeId);
    const currentHash = current?.contentSha256 ?? sha256Text('');
    if (
      options.baseHash !== undefined &&
      options.baseHash !== currentHash &&
      !(current === null && options.baseHash === '')
    ) {
      throw new MemoryBaseHashConflictError(currentHash);
    }

    const { bytes, lines } = enforceIndexCapacity(options.contentMarkdown);

    // Track human edits & manual deletions of <!-- refinement:<id> --> blocks
    if (options.isHumanEdit) {
      const metas = await this.loadMetaList(options.scope, scopeId);
      if (metas.length > 0) {
        const blocksAfter = extractRefinementBlocks(options.contentMarkdown);
        const revoked = await this.loadRevokedSet(options.scope, scopeId);
        const nextMetas: RefinementParagraphMeta[] = [];
        for (const meta of metas) {
          if (meta.status !== 'active') {
            nextMetas.push(meta);
            continue;
          }
          const updatedText = blocksAfter.get(meta.id);
          if (updatedText === undefined) {
            // Human manually deleted block -> mark withdrawn + permanently revoke hash
            revoked.add(meta.normalizedHash);
            nextMetas.push({ ...meta, status: 'withdrawn' });
          } else {
            const newNorm = normalizeMemoryParagraphHash(updatedText);
            if (newNorm !== meta.normalizedHash) {
              nextMetas.push({
                ...meta,
                content: updatedText,
                normalizedHash: newNorm,
                humanEdited: true,
              });
            } else {
              nextMetas.push(meta);
            }
          }
        }
        await this.saveMetaList(options.scope, scopeId, nextMetas);
        await this.saveRevokedSet(options.scope, scopeId, revoked);
      }
    }

    const contentSha256 = sha256Text(options.contentMarkdown);
    await this.p9.putMemoryDocument({
      scopeKind: options.scope,
      scopeId,
      contentMarkdown: options.contentMarkdown,
      contentSha256,
      updatedBy: principal.id,
      sourceChatId: options.sourceChatId ?? null,
    });
    await this.mirrorToHostPrivateDisk(options.scope, scopeId, options.contentMarkdown);

    return {
      contentMarkdown: options.contentMarkdown,
      contentSha256,
      bytesUsed: bytes,
      linesUsed: lines,
    };
  }

  async writeTopic(options: {
    readonly scope: MemoryScopeKind;
    readonly scopeId?: string;
    readonly principal?: Principal;
    readonly topicName: string;
    readonly contentMarkdown: string;
  }): Promise<void> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const scopeId = resolveAuthoritativeScopeId(options.scope, options.scopeId, principal);
    assertWritePermission(options.scope, principal);

    const cleanTopic = options.topicName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const topicBytes = Buffer.byteLength(options.contentMarkdown, 'utf8');
    if (topicBytes > MAX_MEMORY_TOPIC_BYTES) {
      throw RejectedBeforeEffectError.create(
        'MEMORY_CONSOLIDATION_REQUIRED',
        `Topic "${cleanTopic}" exceeds ${MAX_MEMORY_TOPIC_BYTES} bytes.`,
        true,
      );
    }
    const topics = await this.loadTopicsMap(options.scope, scopeId);
    const nextTopics = { ...topics, [cleanTopic]: options.contentMarkdown };
    const doc = await this.p9.getMemoryDocument(options.scope, scopeId);
    const totalBytes =
      Buffer.byteLength(doc?.contentMarkdown ?? '', 'utf8') +
      Object.values(nextTopics).reduce((acc, t) => acc + Buffer.byteLength(t, 'utf8'), 0);
    if (totalBytes > MAX_MEMORY_TOTAL_BYTES) {
      throw RejectedBeforeEffectError.create(
        'MEMORY_CONSOLIDATION_REQUIRED',
        `Total memory usage (${totalBytes} bytes) exceeds ${MAX_MEMORY_TOTAL_BYTES} bytes.`,
        true,
      );
    }
    await this.saveTopicsMap(options.scope, scopeId, nextTopics);
  }

  async readTopic(options: {
    readonly scope: MemoryScopeKind;
    readonly scopeId?: string;
    readonly principal?: Principal;
    readonly topicName: string;
  }): Promise<string | null> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const scopeId = resolveAuthoritativeScopeId(options.scope, options.scopeId, principal);
    const topics = await this.loadTopicsMap(options.scope, options.scopeId ? scopeId : scopeId);
    const cleanTopic = options.topicName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return topics[cleanTopic] ?? null;
  }

  async search(options: {
    readonly query: string;
    readonly workspaceId?: string;
    readonly principal?: Principal;
  }): Promise<Array<{ scope: MemoryScopeKind; source: string; snippet: string }>> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const q = options.query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const scopes: Array<{ scope: MemoryScopeKind; scopeId: string }> = [
      { scope: 'tenant', scopeId: principal.tenantId },
      { scope: 'workspace', scopeId: options.workspaceId || 'default' },
      { scope: 'user', scopeId: principal.id },
    ];
    const hits: Array<{ scope: MemoryScopeKind; source: string; snippet: string; score: number }> = [];
    for (const { scope, scopeId } of scopes) {
      const doc = await this.p9.getMemoryDocument(scope, scopeId);
      const sources: Array<[string, string]> = [['MEMORY.md', doc?.contentMarkdown ?? '']];
      const topics = await this.loadTopicsMap(scope, scopeId);
      for (const [k, v] of Object.entries(topics)) {
        sources.push([`topics/${k}.md`, v]);
      }
      for (const [sourceName, body] of sources) {
        if (!body) continue;
        for (const para of body.split(/\n{2,}/)) {
          const lower = para.toLowerCase();
          const score = terms.reduce((acc, term) => (lower.includes(term) ? acc + 1 : acc), 0);
          if (score > 0) {
            hits.push({
              scope,
              source: sourceName,
              snippet: para.trim().slice(0, 300),
              score,
            });
          }
        }
      }
    }
    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ scope, source, snippet }) => ({ scope, source, snippet }));
  }

  async proposeRefinement(options: {
    readonly id?: string;
    readonly scope: MemoryScopeKind;
    readonly scopeId?: string;
    readonly principal?: Principal;
    readonly content: string;
    readonly evidence: RefinementEvidence;
    readonly nowMs?: number;
  }): Promise<
    | { readonly accepted: true; readonly meta: RefinementParagraphMeta }
    | {
        readonly accepted: false;
        readonly reason: 'user_revoked' | 'human_edited_conflict';
        readonly conflictDraft?: MemoryConflictDraft;
      }
  > {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const scopeId = resolveAuthoritativeScopeId(options.scope, options.scopeId, principal);
    assertWritePermission(options.scope, principal);

    if (!options.evidence.chatId || (!options.evidence.turnId && !options.evidence.toolCallId)) {
      throw RejectedBeforeEffectError.create(
        'missing_refinement_evidence',
        'RSI refinement requires an authoritative chatId and turnId/toolCallId.',
        false,
      );
    }
    if (options.scope === 'user' && containsWorkspaceSpecificPath(options.content)) {
      throw RejectedBeforeEffectError.create(
        'cross_project_path_forbidden',
        'Workspace-specific file paths cannot be promoted into cross-project user memory.',
        false,
      );
    }

    const trimmed = options.content.trim();
    const normHash = normalizeMemoryParagraphHash(trimmed);
    const revoked = await this.loadRevokedSet(options.scope, scopeId);
    const dbRevoked = await this.p9.isMemoryHashRevoked(options.scope, scopeId, normHash);
    if (revoked.has(normHash) || dbRevoked) {
      return { accepted: false, reason: 'user_revoked' };
    }

    const metas = await this.loadMetaList(options.scope, scopeId);
    if (options.id) {
      const existingById = metas.find((m) => m.id === options.id);
      if (existingById?.humanEdited) {
        const draft: MemoryConflictDraft = {
          id: `conflict_${randomBytes(4).toString('hex')}`,
          targetRefinementId: existingById.id,
          proposedContent: trimmed,
          createdAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        };
        await this.appendConflict(options.scope, scopeId, draft);
        return {
          accepted: false,
          reason: 'human_edited_conflict',
          conflictDraft: draft,
        };
      }
    }

    const refId = options.id || `r${randomBytes(5).toString('hex')}`;
    const now = options.nowMs ?? Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + RSI_TTL_MS).toISOString();

    const currentDoc = await this.p9.getMemoryDocument(options.scope, scopeId);
    const prevMd = currentDoc?.contentMarkdown ?? '';
    const wrapped = `<!-- refinement:${refId} -->\n${trimmed}\n<!-- /refinement:${refId} -->`;
    const nextMd = prevMd.trim() ? `${prevMd.trimEnd()}\n\n${wrapped}\n` : `${wrapped}\n`;

    enforceIndexCapacity(nextMd);

    const meta: RefinementParagraphMeta = {
      id: refId,
      normalizedHash: normHash,
      scope: options.scope,
      scopeId,
      content: trimmed,
      evidence: options.evidence,
      humanEdited: false,
      status: 'active',
      createdAt,
      expiresAt,
    };

    const filteredMetas = metas.filter((m) => m.id !== refId);
    await this.saveMetaList(options.scope, scopeId, [...filteredMetas, meta]);
    await this.p9.putMemoryDocument({
      scopeKind: options.scope,
      scopeId,
      contentMarkdown: nextMd,
      contentSha256: sha256Text(nextMd),
      updatedBy: principal.id,
      sourceChatId: options.evidence.chatId,
    });
    await this.mirrorToHostPrivateDisk(options.scope, scopeId, nextMd);

    return { accepted: true, meta };
  }

  private async findRefinementAcrossScopes(
    refinementId: string,
    principal: Principal,
    hintWorkspaceId?: string,
  ): Promise<{
    scope: MemoryScopeKind;
    scopeId: string;
    metas: RefinementParagraphMeta[];
    index: number;
  } | null> {
    const candidates: Array<[MemoryScopeKind, string]> = [
      ['user', principal.id],
      ['workspace', hintWorkspaceId || 'default'],
      ['tenant', principal.tenantId],
    ];
    for (const [scope, scopeId] of candidates) {
      const metas = await this.loadMetaList(scope, scopeId);
      const index = metas.findIndex((m) => m.id === refinementId);
      if (index >= 0) {
        return { scope, scopeId, metas, index };
      }
    }
    return null;
  }

  async renewRefinement(options: {
    readonly refinementId: string;
    readonly principal?: Principal;
    readonly workspaceId?: string;
    readonly nowMs?: number;
  }): Promise<RefinementParagraphMeta | null> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const found = await this.findRefinementAcrossScopes(
      options.refinementId,
      principal,
      options.workspaceId,
    );
    if (!found) return null;
    assertWritePermission(found.scope, principal);

    const now = options.nowMs ?? Date.now();
    const updated: RefinementParagraphMeta = {
      ...found.metas[found.index],
      status: 'active',
      expiresAt: new Date(now + RSI_TTL_MS).toISOString(),
    };
    const next = [...found.metas];
    next[found.index] = updated;
    await this.saveMetaList(found.scope, found.scopeId, next);
    return updated;
  }

  async convertRefinementToOrdinary(options: {
    readonly refinementId: string;
    readonly principal?: Principal;
    readonly workspaceId?: string;
  }): Promise<RefinementParagraphMeta | null> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const found = await this.findRefinementAcrossScopes(
      options.refinementId,
      principal,
      options.workspaceId,
    );
    if (!found) return null;
    assertWritePermission(found.scope, principal);

    const target = found.metas[found.index];
    const updated: RefinementParagraphMeta = {
      ...target,
      status: 'ordinary',
      expiresAt: null,
    };
    const next = [...found.metas];
    next[found.index] = updated;
    await this.saveMetaList(found.scope, found.scopeId, next);

    const doc = await this.p9.getMemoryDocument(found.scope, found.scopeId);
    if (doc) {
      const blockRe = new RegExp(
        `<!--\\s*refinement:${target.id}\\s*-->([\\s\\S]*?)<!--\\s*\\/refinement:${target.id}\\s*-->`,
        'g',
      );
      const unwrapped = doc.contentMarkdown.replace(blockRe, (_m, inner: string) => inner.trim());
      await this.p9.putMemoryDocument({
        scopeKind: found.scope,
        scopeId: found.scopeId,
        contentMarkdown: unwrapped,
        contentSha256: sha256Text(unwrapped),
        updatedBy: principal.id,
      });
      await this.mirrorToHostPrivateDisk(found.scope, found.scopeId, unwrapped);
    }
    return updated;
  }

  async withdrawRefinement(options: {
    readonly refinementId: string;
    readonly principal?: Principal;
    readonly workspaceId?: string;
  }): Promise<RefinementParagraphMeta | null> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const found = await this.findRefinementAcrossScopes(
      options.refinementId,
      principal,
      options.workspaceId,
    );
    if (!found) return null;
    assertWritePermission(found.scope, principal);

    const target = found.metas[found.index];
    const updated: RefinementParagraphMeta = {
      ...target,
      status: 'withdrawn',
    };
    const next = [...found.metas];
    next[found.index] = updated;
    await this.saveMetaList(found.scope, found.scopeId, next);

    const revoked = await this.loadRevokedSet(found.scope, found.scopeId);
    revoked.add(target.normalizedHash);
    await this.saveRevokedSet(found.scope, found.scopeId, revoked);

    // Also record in DB entry table so SQLite/MySQL queries see the revoked hash
    const entryRes = await this.p9.upsertMemoryEntry({
      scopeKind: found.scope,
      scopeId: found.scopeId,
      content: target.content,
      contentSha256: target.normalizedHash,
    });
    if (!entryRes.skippedRevoked) {
      await this.p9.revokeMemoryEntry(entryRes.entry.id);
    }

    const doc = await this.p9.getMemoryDocument(found.scope, found.scopeId);
    if (doc) {
      const blockRe = new RegExp(
        `\\n*<!--\\s*refinement:${target.id}\\s*-->[\\s\\S]*?<!--\\s*\\/refinement:${target.id}\\s*-->\\n*`,
        'g',
      );
      const cleaned = doc.contentMarkdown.replace(blockRe, '\n').trim();
      const finalMd = cleaned ? `${cleaned}\n` : '';
      await this.p9.putMemoryDocument({
        scopeKind: found.scope,
        scopeId: found.scopeId,
        contentMarkdown: finalMd,
        contentSha256: sha256Text(finalMd),
        updatedBy: principal.id,
      });
      await this.mirrorToHostPrivateDisk(found.scope, found.scopeId, finalMd);
    }
    return updated;
  }

  async unrevokeHash(options: {
    readonly scope: MemoryScopeKind;
    readonly scopeId?: string;
    readonly hash: string;
    readonly principal?: Principal;
  }): Promise<boolean> {
    const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
    const scopeId = resolveAuthoritativeScopeId(options.scope, options.scopeId, principal);
    assertWritePermission(options.scope, principal);

    const revoked = await this.loadRevokedSet(options.scope, scopeId);
    const existed = revoked.delete(options.hash);
    if (existed) {
      await this.saveRevokedSet(options.scope, scopeId, revoked);
    }
    return existed;
  }

  /**
   * Renders active, non-expired, non-revoked markdown for a single scope within
   * `budgetBytes`, preserving original source text on disk even when expired.
   */
  async renderVisibleMarkdownForScope(options: {
    readonly scope: MemoryScopeKind;
    readonly scopeId: string;
    readonly principal: Principal;
    readonly budgetBytes: number;
    readonly nowMs?: number;
  }): Promise<string> {
    const doc = await this.p9.getMemoryDocument(options.scope, options.scopeId);
    if (!doc || !doc.contentMarkdown.trim()) return '';
    const metas = await this.loadMetaList(options.scope, options.scopeId);
    const metaById = new Map(metas.map((m) => [m.id, m]));
    const revoked = await this.loadRevokedSet(options.scope, options.scopeId);
    const now = options.nowMs ?? Date.now();

    const filtered = doc.contentMarkdown.replace(
      REFINEMENT_BLOCK_RE,
      (_full, id: string, inner: string) => {
        const meta = metaById.get(id);
        if (!meta) return inner.trim();
        if (meta.status === 'withdrawn') return '';
        if (revoked.has(meta.normalizedHash)) return '';
        if (meta.status === 'active' && meta.expiresAt !== null) {
          const exp = Date.parse(meta.expiresAt);
          if (!Number.isNaN(exp) && now >= exp) {
            return '';
          }
        }
        return inner.trim();
      },
    );

    const paragraphs = filtered
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !revoked.has(normalizeMemoryParagraphHash(p)));
    if (paragraphs.length === 0) return '';

    const kept: string[] = [];
    let usedBytes = 0;
    let omittedCount = 0;
    for (const para of paragraphs) {
      const candidateBytes = Buffer.byteLength(para, 'utf8') + (kept.length > 0 ? 2 : 0);
      if (usedBytes + candidateBytes <= options.budgetBytes) {
        kept.push(para);
        usedBytes += candidateBytes;
      } else {
        omittedCount += 1;
      }
    }
    if (omittedCount > 0) {
      kept.push(
        `[... ${omittedCount} additional paragraph(s) omitted by budget; call memory_read / memory_search for details]`,
      );
    }
    return kept.join('\n\n');
  }
}
