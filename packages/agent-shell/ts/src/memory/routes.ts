/**
 * HTTP route handlers for `/api/v2/memory*` (Phase 9 R8-4).
 */
import { LOCAL_DEFAULT_PRINCIPAL, type Principal } from '../auth/index.js';
import type { MemoryScopeKind } from '../storage/fde-types.js';
import type { ScopedStore } from '../storage/scoped-store.js';
import { recordMidSessionMemoryDelta } from './injector.js';
import {
  MemoryAccessDeniedError,
  MemoryBaseHashConflictError,
  MemoryStore,
  type MemoryPermissionMode,
} from './store.js';

function parseScope(raw: unknown): MemoryScopeKind {
  if (raw === 'workspace' || raw === 'tenant') return raw;
  return 'user';
}

export async function handleMemoryHttpRoute(options: {
  readonly method: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly body: Record<string, unknown>;
  readonly store: ScopedStore;
  readonly principal?: Principal;
}): Promise<{ status: number; data: unknown } | null> {
  const { method, pathname, searchParams, body } = options;
  if (!pathname.startsWith('/api/v2/memory')) return null;

  const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
  const memoryStore = new MemoryStore(options.store);

  try {
    if (pathname === '/api/v2/memory' && method === 'GET') {
      const scope = parseScope(searchParams.get('scope'));
      const scopeId = searchParams.get('scopeId') ?? undefined;
      const permissionMode = await memoryStore.getPermissionMode();
      const doc = await memoryStore.readDocument({ scope, scopeId, principal });
      return {
        status: 200,
        data: {
          permissionMode,
          ...doc,
        },
      };
    }

    if (pathname === '/api/v2/memory' && method === 'PUT') {
      if (
        body.permissionMode === 'off' ||
        body.permissionMode === 'ask' ||
        body.permissionMode === 'auto'
      ) {
        await memoryStore.setPermissionMode(body.permissionMode as MemoryPermissionMode);
        if (body.contentMarkdown === undefined) {
          return {
            status: 200,
            data: { permissionMode: body.permissionMode },
          };
        }
      }
      const scope = parseScope(body.scope ?? searchParams.get('scope'));
      const scopeId =
        typeof body.scopeId === 'string'
          ? body.scopeId
          : searchParams.get('scopeId') ?? undefined;
      const contentMarkdown = String(body.contentMarkdown ?? '');
      const baseHash = typeof body.baseHash === 'string' ? body.baseHash : undefined;
      const chatId = typeof body.chatId === 'string' ? body.chatId : undefined;

      const saved = await memoryStore.writeDocument({
        scope,
        scopeId,
        principal,
        contentMarkdown,
        baseHash,
        sourceChatId: chatId ?? null,
        isHumanEdit: true,
      });
      if (chatId) {
        recordMidSessionMemoryDelta(chatId, `updated ${scope} MEMORY.md`);
      }
      return {
        status: 200,
        data: saved,
      };
    }

    if (pathname === '/api/v2/memory/propose' && method === 'POST') {
      const scope = parseScope(body.scope);
      const scopeId = typeof body.scopeId === 'string' ? body.scopeId : undefined;
      const chatId = typeof body.chatId === 'string' ? body.chatId : 'local';
      const turnId = typeof body.turnId === 'string' ? body.turnId : 'manual_turn';
      const content = String(body.content ?? '').trim();
      const res = await memoryStore.proposeRefinement({
        scope,
        scopeId,
        principal,
        content,
        evidence: {
          chatId,
          turnId,
          ...(typeof body.toolCallId === 'string' ? { toolCallId: body.toolCallId } : {}),
        },
      });
      if (res.accepted) {
        recordMidSessionMemoryDelta(chatId, `saved ${scope} paragraph ${res.meta.id}`);
      }
      return {
        status: 200,
        data: res,
      };
    }

    const refActionMatch = pathname.match(
      /^\/api\/v2\/memory\/refinements\/([^/]+)\/(renew|convert|withdraw)$/,
    );
    if (refActionMatch && method === 'POST') {
      const refinementId = decodeURIComponent(refActionMatch[1]);
      const action = refActionMatch[2];
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
      const chatId = typeof body.chatId === 'string' ? body.chatId : undefined;

      let updated = null;
      if (action === 'renew') {
        updated = await memoryStore.renewRefinement({ refinementId, principal, workspaceId });
      } else if (action === 'convert') {
        updated = await memoryStore.convertRefinementToOrdinary({
          refinementId,
          principal,
          workspaceId,
        });
      } else {
        updated = await memoryStore.withdrawRefinement({
          refinementId,
          principal,
          workspaceId,
        });
        if (updated && chatId) {
          recordMidSessionMemoryDelta(chatId, `withdrawn paragraph ${refinementId}`);
        }
      }
      if (!updated) return { status: 404, data: { detail: 'refinement not found' } };
      return { status: 200, data: { refinement: updated } };
    }

    const revokedMatch = pathname.match(/^\/api\/v2\/memory\/revoked\/([^/]+)$/);
    if (revokedMatch && method === 'DELETE') {
      const hash = decodeURIComponent(revokedMatch[1]);
      const scope = parseScope(searchParams.get('scope'));
      const scopeId = searchParams.get('scopeId') ?? undefined;
      const removed = await memoryStore.unrevokeHash({ scope, scopeId, hash, principal });
      return { status: 200, data: { removed } };
    }

    return null;
  } catch (err) {
    if (err instanceof MemoryAccessDeniedError) {
      return { status: 403, data: { code: err.code, detail: err.message } };
    }
    if (err instanceof MemoryBaseHashConflictError) {
      return {
        status: 409,
        data: { code: err.code, currentHash: err.currentHash, detail: err.message },
      };
    }
    throw err;
  }
}
