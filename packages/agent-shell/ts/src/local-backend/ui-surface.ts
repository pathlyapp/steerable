/**
 * Declarative `UiSurface` v1 host runtime, `$source` read-only data binding,
 * canonical SHA-256 drift check (`409 UI_STALE`), and idempotent action dispatch (R4).
 */
import { createHash } from 'node:crypto';
import type { UiSurfacePayload } from '@steerable/agent-protocol';
import {
  LOCAL_DEFAULT_PRINCIPAL,
  isRestrictedOriginChannel,
  type OriginChannel,
  type Principal,
} from '../auth/index.js';
import { getRegisteredDataSource } from '../scenario/applications.js';
import { RejectedBeforeEffectError } from '../sidecar/rejected-before-effect.js';
import { ensurePhase9Store } from '../storage/fde-fallback.js';
import type { ScopedStore } from '../storage/scoped-store.js';
import type { ToolRouter } from '../tool-router.js';

export const UI_SURFACE_RENDER_TOOL_NAME = 'ui_surface_render';
export const MAX_UI_SURFACE_BYTES = 64 * 1024;
export const MAX_UI_SURFACE_TABLE_ROWS = 500;

export const ALLOWED_UI_SURFACE_COMPONENT_KINDS = new Set([
  'table',
  'detail-card',
  'form',
  'steps',
  'kv-diff',
  'artifact-card',
]);

export const UI_SURFACE_RENDER_SCHEMA = {
  name: UI_SURFACE_RENDER_TOOL_NAME,
  description:
    'Render or update a structured business workbench surface (table, detail-card, form, steps, kv-diff, artifact-card) bounded to 64 KiB and 500 rows per table. Supports server-evaluated read-only `$source` bindings.',
  mode: 'ui' as const,
  inputSchema: {
    type: 'object',
    required: ['surfaceId', 'title', 'components'],
    properties: {
      surfaceId: { type: 'string' },
      title: { type: 'string' },
      subtitle: { type: 'string' },
      placement: { type: 'string', enum: ['inline', 'workbench'] },
      data: { type: 'object' },
      components: { type: 'array', minItems: 1 },
      actions: { type: 'array' },
    },
  },
};

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (v !== undefined) {
        out[k] = canonicalizeValue(v);
      }
    }
    return out;
  }
  return value;
}

export function canonicalJsonSha256(value: unknown): string {
  const serialized = JSON.stringify(canonicalizeValue(value));
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

interface SourceDescriptor {
  readonly $source: string;
  readonly params?: Record<string, unknown>;
}

function isSourceDescriptor(value: unknown): value is SourceDescriptor {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { $source?: unknown }).$source === 'string' &&
      (value as { $source: string }).$source.trim().length > 0,
  );
}

export async function evaluateUiSurfaceDataBindings(
  data: Record<string, unknown> | undefined,
  ctx: { readonly principal: Principal; readonly chatId: string },
): Promise<{
  resolvedData: Record<string, unknown>;
  sourceHashes: Record<string, string>;
}> {
  const resolvedData: Record<string, unknown> = {};
  const sourceHashes: Record<string, string> = {};
  if (!data || typeof data !== 'object') {
    return { resolvedData, sourceHashes };
  }
  for (const [key, rawVal] of Object.entries(data)) {
    if (isSourceDescriptor(rawVal)) {
      const sourceId = rawVal.$source.trim();
      const source = getRegisteredDataSource(sourceId);
      if (!source || typeof source.query !== 'function') {
        throw RejectedBeforeEffectError.create(
          'unknown_data_source',
          `UiSurface references unregistered read-only data source "${sourceId}"`,
        );
      }
      const queried = await source.query(rawVal.params ?? {}, {
        principal: ctx.principal,
        chatId: ctx.chatId,
      });
      if (Array.isArray(queried) && queried.length > MAX_UI_SURFACE_TABLE_ROWS) {
        throw RejectedBeforeEffectError.create(
          'ui_surface_row_cap_exceeded',
          `Data source "${sourceId}" returned ${queried.length} rows (max ${MAX_UI_SURFACE_TABLE_ROWS}). Apply server-side filtering first.`,
        );
      }
      resolvedData[key] = queried;
      sourceHashes[key] = canonicalJsonSha256(queried);
    } else {
      resolvedData[key] = rawVal;
    }
  }
  return { resolvedData, sourceHashes };
}

export function validateUiSurfaceRawInput(raw: Record<string, unknown>): void {
  const byteLen = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (byteLen > MAX_UI_SURFACE_BYTES) {
    throw RejectedBeforeEffectError.create(
      'ui_surface_payload_too_large',
      `UiSurface payload is ${byteLen} bytes (limit ${MAX_UI_SURFACE_BYTES} bytes).`,
    );
  }
  const surfaceId = typeof raw.surfaceId === 'string' ? raw.surfaceId.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!surfaceId || !title) {
    throw RejectedBeforeEffectError.create(
      'schema_validation_failed',
      'UiSurface requires non-empty `surfaceId` and `title`.',
    );
  }
  const components = raw.components;
  if (!Array.isArray(components) || components.length === 0) {
    throw RejectedBeforeEffectError.create(
      'schema_validation_failed',
      'UiSurface requires a non-empty `components` array.',
    );
  }
  for (const comp of components) {
    if (!comp || typeof comp !== 'object') {
      throw RejectedBeforeEffectError.create('schema_validation_failed', 'Invalid UiSurface component entry.');
    }
    const c = comp as Record<string, unknown>;
    const kind = typeof c.kind === 'string' ? c.kind : '';
    if (!ALLOWED_UI_SURFACE_COMPONENT_KINDS.has(kind)) {
      throw RejectedBeforeEffectError.create(
        'schema_validation_failed',
        `Unsupported UiSurface component kind "${kind}". Allowed kinds: ${[...ALLOWED_UI_SURFACE_COMPONENT_KINDS].join(', ')}`,
      );
    }
    if (kind === 'table' && Array.isArray(c.rows) && c.rows.length > MAX_UI_SURFACE_TABLE_ROWS) {
      throw RejectedBeforeEffectError.create(
        'ui_surface_row_cap_exceeded',
        `Table "${String(c.id ?? '')}" has ${c.rows.length} rows (max ${MAX_UI_SURFACE_TABLE_ROWS}).`,
      );
    }
  }
}

export async function renderAndPersistUiSurface(options: {
  readonly store: ScopedStore;
  readonly chatId: string;
  readonly principal?: Principal;
  readonly raw: Record<string, unknown>;
}): Promise<UiSurfacePayload> {
  validateUiSurfaceRawInput(options.raw);
  const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
  const surfaceId = String(options.raw.surfaceId).trim();
  const title = String(options.raw.title).trim();
  const dataSpec =
    options.raw.data && typeof options.raw.data === 'object' && !Array.isArray(options.raw.data)
      ? (options.raw.data as Record<string, unknown>)
      : undefined;

  const { resolvedData, sourceHashes } = await evaluateUiSurfaceDataBindings(dataSpec, {
    principal,
    chatId: options.chatId,
  });

  const p9 = ensurePhase9Store(options.store);
  const stored = await p9.upsertChatUiSurface({
    chatId: options.chatId,
    spec: {
      surfaceId,
      title: { en: title, zh: title },
      nodes: [],
    },
    state: {
      rawPayload: {
        ...options.raw,
        surfaceId,
        title,
      },
      resolvedData,
      sourceHashes,
    },
    status: 'active',
  });

  const payload: UiSurfacePayload = {
    ...(options.raw as unknown as UiSurfacePayload),
    surfaceId,
    title,
    revision: stored.revision,
    resolvedData,
    sourceHashes,
  };
  const finalBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (finalBytes > MAX_UI_SURFACE_BYTES) {
    throw RejectedBeforeEffectError.create(
      'ui_surface_payload_too_large',
      `Resolved UiSurface payload is ${finalBytes} bytes (limit ${MAX_UI_SURFACE_BYTES} bytes).`,
    );
  }
  return payload;
}

export async function refreshPersistedUiSurface(options: {
  readonly store: ScopedStore;
  readonly chatId: string;
  readonly surfaceId: string;
  readonly principal?: Principal;
}): Promise<UiSurfacePayload | null> {
  const p9 = ensurePhase9Store(options.store);
  const existing = await p9.getChatUiSurface(options.chatId, options.surfaceId);
  if (!existing) return null;
  const rawPayload =
    existing.state.rawPayload && typeof existing.state.rawPayload === 'object'
      ? (existing.state.rawPayload as Record<string, unknown>)
      : { surfaceId: existing.surfaceId, title: existing.title.en ?? existing.surfaceId, components: [] };
  const dataSpec =
    rawPayload.data && typeof rawPayload.data === 'object' && !Array.isArray(rawPayload.data)
      ? (rawPayload.data as Record<string, unknown>)
      : undefined;
  const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
  const { resolvedData, sourceHashes } = await evaluateUiSurfaceDataBindings(dataSpec, {
    principal,
    chatId: options.chatId,
  });

  const prevHashes = (existing.state.sourceHashes as Record<string, string> | undefined) ?? {};
  const changed = JSON.stringify(prevHashes) !== JSON.stringify(sourceHashes);
  const revision = changed
    ? (
        await p9.upsertChatUiSurface({
          chatId: options.chatId,
          spec: existing.spec,
          state: {
            ...existing.state,
            resolvedData,
            sourceHashes,
          },
          status: existing.status,
        })
      ).revision
    : existing.revision;

  return {
    ...(rawPayload as unknown as UiSurfacePayload),
    surfaceId: existing.surfaceId,
    revision,
    resolvedData,
    sourceHashes,
  };
}

export async function dispatchUiSurfaceAction(options: {
  readonly store: ScopedStore;
  readonly toolRouter: ToolRouter;
  readonly chatId: string;
  readonly surfaceId: string;
  readonly principal?: Principal;
  readonly originChannel?: OriginChannel;
  readonly body: Record<string, unknown>;
}): Promise<{ status: number; data: unknown }> {
  const principal = options.principal ?? LOCAL_DEFAULT_PRINCIPAL;
  const originChannel = options.originChannel ?? 'web';
  const p9 = ensurePhase9Store(options.store);

  const commandId = String(options.body.commandId ?? '').trim();
  const actionId = String(options.body.actionId ?? '').trim();
  if (!commandId || !actionId) {
    return {
      status: 400,
      data: { detail: 'commandId and actionId are required' },
    };
  }

  // 1. Idempotency check on (chatId, commandId) BEFORE revision/hash/tool checks
  const priorReceipts = await p9.listChatUiReceipts(options.chatId, options.surfaceId);
  const existingReceipt = priorReceipts.find(
    (r) => r.payload.__commandId === commandId,
  );
  if (existingReceipt) {
    return {
      status: 200,
      data: {
        ok: true,
        deduplicated: true,
        receipt: existingReceipt,
        result: existingReceipt.result,
      },
    };
  }

  const surface = await p9.getChatUiSurface(options.chatId, options.surfaceId);
  if (!surface) {
    return { status: 404, data: { detail: 'surface not found' } };
  }

  // 2. Verify expectedRevision
  const expectedRevision = Number(options.body.expectedRevision ?? 0);
  if (expectedRevision !== surface.revision) {
    return {
      status: 409,
      data: {
        code: 'UI_STALE',
        staleKeys: ['__revision__'],
        currentRevision: surface.revision,
      },
    };
  }

  const rawPayload =
    surface.state.rawPayload && typeof surface.state.rawPayload === 'object'
      ? (surface.state.rawPayload as unknown as UiSurfacePayload)
      : null;
  const actions = Array.isArray(rawPayload?.actions) ? rawPayload.actions : [];
  const actionSpec = actions.find((a) => a.id === actionId);
  if (!actionSpec) {
    return { status: 404, data: { detail: `action "${actionId}" not found on surface` } };
  }

  // 3. Real-time re-query of all $source bindings & SHA-256 drift verification
  const dataSpec =
    rawPayload?.data && typeof rawPayload.data === 'object'
      ? (rawPayload.data as Record<string, unknown>)
      : undefined;
  const { resolvedData: freshData, sourceHashes: freshHashes } =
    await evaluateUiSurfaceDataBindings(dataSpec, {
      principal,
      chatId: options.chatId,
    });

  const clientHashes =
    options.body.sourceHashes &&
    typeof options.body.sourceHashes === 'object' &&
    !Array.isArray(options.body.sourceHashes)
      ? (options.body.sourceHashes as Record<string, string>)
      : {};
  const staleKeys: string[] = [];
  for (const [sourceKey, freshHash] of Object.entries(freshHashes)) {
    if (clientHashes[sourceKey] !== freshHash) {
      staleKeys.push(sourceKey);
    }
  }
  if (staleKeys.length > 0) {
    return {
      status: 409,
      data: {
        code: 'UI_STALE',
        staleKeys,
      },
    };
  }

  // Restricted channel check for outward actions/tools
  const toolSchema = options.toolRouter.getSchemaByName(actionSpec.toolName);
  const isOutward =
    actionSpec.checkpoint === 'outward' || toolSchema?.checkpoint === 'outward';
  if (isRestrictedOriginChannel(originChannel) && isOutward) {
    return {
      status: 403,
      data: {
        code: 'outward_confirmation_required',
        workbenchHref: `/#/agent/${encodeURIComponent(options.chatId)}`,
      },
    };
  }

  // 4. Authoritative row lookup strictly from server-side `freshData` (ignore forged client row objects)
  const selectedRowIds = Array.isArray(options.body.selectedRowIds)
    ? options.body.selectedRowIds.filter((x): x is string => typeof x === 'string')
    : [];
  const selectedIdSet = new Set(selectedRowIds);

  const tableComp = (rawPayload?.components ?? []).find(
    (c) =>
      c.kind === 'table' &&
      (!actionSpec.dataKey || c.dataKey === actionSpec.dataKey),
  );
  const idField = tableComp?.rowIdField || 'id';
  let authoritativeRows: Record<string, unknown>[] = [];
  if (tableComp) {
    const tableRows =
      tableComp.dataKey && Array.isArray(freshData[tableComp.dataKey])
        ? (freshData[tableComp.dataKey] as Record<string, unknown>[])
        : Array.isArray(tableComp.rows)
          ? (tableComp.rows as Record<string, unknown>[])
          : [];
    authoritativeRows = tableRows.filter((row) =>
      selectedIdSet.has(String(row[idField] ?? '')),
    );
  }

  const formValues =
    options.body.formValues &&
    typeof options.body.formValues === 'object' &&
    !Array.isArray(options.body.formValues)
      ? (options.body.formValues as Record<string, unknown>)
      : {};
  const kvDiffOverrides =
    options.body.kvDiffOverrides &&
    typeof options.body.kvDiffOverrides === 'object' &&
    !Array.isArray(options.body.kvDiffOverrides)
      ? (options.body.kvDiffOverrides as Record<string, unknown>)
      : {};
  const note =
    typeof options.body.note === 'string' && options.body.note.trim()
      ? options.body.note.trim()
      : undefined;

  const toolArgs: Record<string, unknown> = {
    ...(actionSpec.staticArgs ?? {}),
    ...formValues,
    ...(Object.keys(kvDiffOverrides).length > 0 ? { kvDiffOverrides } : {}),
    ...(note ? { note } : {}),
    ...(selectedRowIds.length > 0
      ? { selectedRowIds, selectedRows: authoritativeRows }
      : {}),
  };

  const rawResult = await options.toolRouter.execute(
    { name: actionSpec.toolName, arguments: toolArgs },
    {
      chatId: options.chatId,
      principal,
      originChannel,
    },
  );
  const resultObj: Record<string, unknown> =
    rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
      ? (rawResult as Record<string, unknown>)
      : { value: rawResult };

  const receipt = await p9.recordChatUiReceipt({
    chatId: options.chatId,
    surfaceId: options.surfaceId,
    revision: surface.revision,
    actionId,
    toolName: actionSpec.toolName,
    payload: {
      __commandId: commandId,
      selectedRowIds,
      formValues,
      ...(note ? { note } : {}),
    },
    sourceFingerprints: freshHashes,
    result: resultObj,
    actorId: principal.id,
  });

  return {
    status: 200,
    data: {
      ok: true,
      deduplicated: false,
      receipt,
      result: resultObj,
    },
  };
}
