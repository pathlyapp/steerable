/**
 * Model-facing memory tools (`memory_search`, `memory_read`, `memory_propose`)
 * with hard Subagent / Fork write prohibition (Phase 9 R8-2 & R8-3).
 */
import { LOCAL_DEFAULT_PRINCIPAL, type Principal } from '../auth/index.js';
import type { MemoryScopeKind } from '../storage/fde-types.js';
import type { ScopedStore } from '../storage/scoped-store.js';
import { recordMidSessionMemoryDelta } from './injector.js';
import { MemoryStore } from './store.js';

export const MEMORY_SEARCH_TOOL_NAME = 'memory_search';
export const MEMORY_READ_TOOL_NAME = 'memory_read';
export const MEMORY_PROPOSE_TOOL_NAME = 'memory_propose';

export const MEMORY_TOOL_SCHEMAS = [
  {
    name: MEMORY_SEARCH_TOOL_NAME,
    description: 'Search user, workspace, and tenant memory notes by keyword.',
    mode: 'read' as const,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
      },
    },
  },
  {
    name: MEMORY_READ_TOOL_NAME,
    description: 'Read MEMORY.md or a specific topic note (`topics/<name>.md`) from memory.',
    mode: 'read' as const,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['user', 'workspace', 'tenant'] },
        topic: { type: 'string' },
      },
    },
  },
  {
    name: MEMORY_PROPOSE_TOOL_NAME,
    description: 'Propose saving a durable preference or refinement paragraph into memory.',
    mode: 'local' as const,
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        scope: { type: 'string', enum: ['user', 'workspace', 'tenant'] },
        content: { type: 'string' },
        turnId: { type: 'string' },
        toolCallId: { type: 'string' },
      },
    },
  },
];

export interface MemoryToolExecContext {
  readonly store: ScopedStore;
  readonly chatId?: string;
  readonly workspaceId?: string;
  readonly principal?: Principal;
  readonly isSubagent?: boolean;
  readonly isFork?: boolean;
}

export async function executeMemoryTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MemoryToolExecContext,
): Promise<unknown> {
  const memoryStore = new MemoryStore(ctx.store);
  const principal = ctx.principal ?? LOCAL_DEFAULT_PRINCIPAL;

  if (toolName === MEMORY_SEARCH_TOOL_NAME) {
    const hits = await memoryStore.search({
      query: String(args.query ?? ''),
      workspaceId: ctx.workspaceId,
      principal,
    });
    return { success: true, hits };
  }

  if (toolName === MEMORY_READ_TOOL_NAME) {
    const scope: MemoryScopeKind =
      args.scope === 'tenant' || args.scope === 'workspace' ? args.scope : 'user';
    const scopeId =
      scope === 'workspace'
        ? ctx.workspaceId || 'default'
        : scope === 'tenant'
          ? principal.tenantId
          : principal.id;
    if (typeof args.topic === 'string' && args.topic.trim()) {
      const content = await memoryStore.readTopic({
        scope,
        scopeId,
        principal,
        topicName: args.topic.trim(),
      });
      return content !== null
        ? { success: true, scope, topic: args.topic.trim(), content }
        : { success: false, error: `Topic "${args.topic.trim()}" not found.` };
    }
    const doc = await memoryStore.readDocument({ scope, scopeId, principal });
    return {
      success: true,
      scope,
      contentMarkdown: doc.contentMarkdown,
      topics: doc.topics,
    };
  }

  if (toolName === MEMORY_PROPOSE_TOOL_NAME) {
    // Hard invariant (T-MEM-08): subagents & forked chats may read inherited snapshots, never write!
    if (ctx.isSubagent || ctx.isFork) {
      return {
        success: false,
        error: 'subagent_memory_write_forbidden',
        effect: 'none',
      };
    }
    const mode = await memoryStore.getPermissionMode();
    if (mode === 'off') {
      return {
        success: false,
        error: 'memory_disabled',
        effect: 'none',
      };
    }

    const scope: MemoryScopeKind =
      args.scope === 'tenant' || args.scope === 'workspace' ? args.scope : 'user';
    const scopeId =
      scope === 'workspace'
        ? ctx.workspaceId || 'default'
        : scope === 'tenant'
          ? principal.tenantId
          : principal.id;
    const content = String(args.content ?? '').trim();
    if (!content) {
      return { success: false, error: 'content is required', effect: 'none' };
    }

    const res = await memoryStore.proposeRefinement({
      scope,
      scopeId,
      principal,
      content,
      evidence: {
        chatId: ctx.chatId || 'local',
        turnId: typeof args.turnId === 'string' && args.turnId ? args.turnId : 'turn_current',
        ...(typeof args.toolCallId === 'string' ? { toolCallId: args.toolCallId } : {}),
      },
    });
    if (!res.accepted) {
      return {
        success: false,
        reason: res.reason,
        effect: 'none',
        ...(res.conflictDraft ? { conflictDraft: res.conflictDraft } : {}),
      };
    }
    recordMidSessionMemoryDelta(
      ctx.chatId,
      `saved ${scope} paragraph ${res.meta.id}`,
    );
    return {
      success: true,
      event: mode === 'ask' ? 'memory_approval_requested' : 'memory_saved',
      refinement: res.meta,
    };
  }

  return { success: false, error: `Unknown memory tool: ${toolName}` };
}
