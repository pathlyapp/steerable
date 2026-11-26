/**
 * Three-layer capability decoupling registries (R3) & DeliverableVerifier /
 * PackDataSource registries (R1, R5):
 *   Layer 1 (Capability Pack): tools, dataSources, deliverableVerifiers
 *   Layer 2 (Agent Profile):   agentProfiles (role prompt, tool allowlist, skills)
 *   Layer 3 (Application):     applications (default profile, workbench tabs, nav visibility)
 *
 * Includes Safe Recovery Mode (`safeMode: true` via `/?safe=1`) and one-step
 * reset (`resetActiveApplication`) so a misconfigured ApplicationManifest can
 * never brick the host UI.
 */
import type {
  AgentProfileSpec,
  ApplicationManifest,
  DeliverableVerifier,
  PackDataSource,
} from '@steerable/pack-sdk';
import { getBrand } from '../brand.js';
import type { ScopedStore } from '../storage/scoped-store.js';
import { ensurePhase9Store } from '../storage/fde-fallback.js';

export const ACTIVE_APPLICATION_SETTING_KEY = 'active_application_id';
export const DEFAULT_APPLICATION_ID = 'default';

const dataSources = new Map<string, PackDataSource>();
const agentProfiles = new Map<string, AgentProfileSpec>();
const applications = new Map<string, ApplicationManifest>();
const deliverableVerifiers = new Map<string, DeliverableVerifier>();

export function registerPackDataSources(
  packId: string,
  items: readonly PackDataSource[],
): void {
  for (const item of items) {
    if (!item.id.trim()) {
      throw new Error(`[packs] dataSource in pack "${packId}" has empty id`);
    }
    if (dataSources.has(item.id)) {
      throw new Error(`[packs] duplicate dataSource id "${item.id}" from pack "${packId}"`);
    }
    dataSources.set(item.id, item);
  }
}

export function getRegisteredDataSource(sourceId: string): PackDataSource | null {
  return dataSources.get(sourceId) ?? null;
}

export function listRegisteredDataSources(): PackDataSource[] {
  return [...dataSources.values()];
}

export function registerAgentProfiles(
  packId: string,
  items: readonly AgentProfileSpec[],
): void {
  for (const item of items) {
    if (!item.id.trim()) {
      throw new Error(`[packs] agentProfile in pack "${packId}" has empty id`);
    }
    if (agentProfiles.has(item.id)) {
      throw new Error(`[packs] duplicate agentProfile id "${item.id}" from pack "${packId}"`);
    }
    agentProfiles.set(item.id, item);
  }
}

export function getRegisteredAgentProfile(profileId: string): AgentProfileSpec | null {
  return agentProfiles.get(profileId) ?? null;
}

export function listRegisteredAgentProfiles(): AgentProfileSpec[] {
  return [...agentProfiles.values()];
}

export function registerApplications(
  packId: string,
  items: readonly ApplicationManifest[],
): void {
  for (const item of items) {
    if (!item.id.trim() || item.id === DEFAULT_APPLICATION_ID) {
      throw new Error(
        `[packs] invalid application id "${item.id}" in pack "${packId}" ("default" is reserved)`,
      );
    }
    if (applications.has(item.id)) {
      throw new Error(`[packs] duplicate application id "${item.id}" from pack "${packId}"`);
    }
    applications.set(item.id, item);
  }
}

export function getRegisteredApplication(appId: string): ApplicationManifest | null {
  return applications.get(appId) ?? null;
}

export function listRegisteredApplications(): ApplicationManifest[] {
  return [...applications.values()];
}

export function registerDeliverableVerifiers(
  packId: string,
  items: readonly DeliverableVerifier[],
): void {
  for (const item of items) {
    if (!item.id.trim()) {
      throw new Error(`[packs] deliverableVerifier in pack "${packId}" has empty id`);
    }
    if (deliverableVerifiers.has(item.id)) {
      throw new Error(
        `[packs] duplicate deliverableVerifier id "${item.id}" from pack "${packId}"`,
      );
    }
    deliverableVerifiers.set(item.id, item);
  }
}

export function listDeliverableVerifiers(): DeliverableVerifier[] {
  return [...deliverableVerifiers.values()];
}

export function resetPhase9PackRegistries(): void {
  dataSources.clear();
  agentProfiles.clear();
  applications.clear();
  deliverableVerifiers.clear();
}

export interface ResolvedApplicationShell {
  readonly id: string;
  readonly title: Readonly<Record<string, string>>;
  readonly defaultAgentProfileId: string;
  readonly allowedPackIds: readonly string[];
  readonly defaultWorkbenchTabs: readonly ('preview' | 'workbench' | 'terminal' | 'fact_chain')[];
  readonly hiddenNavItems: readonly ('skills' | 'mcp' | 'agents' | 'terminal')[];
  readonly safeMode: boolean;
  readonly customApplicationBypassed: boolean;
}

export function buildDefaultApplicationShell(safeMode = false): ResolvedApplicationShell {
  const brand = getBrand();
  return {
    id: DEFAULT_APPLICATION_ID,
    title: { en: brand.displayName, zh: brand.displayName },
    defaultAgentProfileId: brand.defaultAgentId,
    allowedPackIds: [],
    defaultWorkbenchTabs: ['preview', 'workbench', 'terminal', 'fact_chain'],
    hiddenNavItems: [],
    safeMode,
    customApplicationBypassed: false,
  };
}

/**
 * Resolves the active application shell for the current user/tenant.
 *
 * When `safeMode === true` (triggered by `/?safe=1`), any custom
 * ApplicationManifest navigation hiding or workbench restrictions are bypassed
 * so operators can always recover settings, skills, MCP, and agent management.
 */
export async function resolveActiveApplication(
  store: ScopedStore,
  options?: { safeMode?: boolean },
): Promise<ResolvedApplicationShell> {
  const safeMode = Boolean(options?.safeMode);
  const p9 = ensurePhase9Store(store);
  const savedId = await p9.getCustomSetting(ACTIVE_APPLICATION_SETTING_KEY);
  const envActiveId = process.env.STEERABLE_ACTIVE_APP?.trim() || null;
  const effectiveId = savedId ?? envActiveId;
  const selected =
    !effectiveId || effectiveId === DEFAULT_APPLICATION_ID
      ? null
      : applications.get(effectiveId) ?? null;

  if (!selected) {
    return buildDefaultApplicationShell(safeMode);
  }

  if (safeMode) {
    return {
      ...buildDefaultApplicationShell(true),
      customApplicationBypassed: true,
    };
  }

  return {
    id: selected.id,
    title: selected.title,
    defaultAgentProfileId: selected.defaultAgentProfileId,
    allowedPackIds: selected.allowedPackIds,
    defaultWorkbenchTabs: selected.defaultWorkbenchTabs ?? ['preview', 'workbench', 'terminal'],
    hiddenNavItems: selected.hiddenNavItems ?? [],
    safeMode: false,
    customApplicationBypassed: false,
  };
}

/** Switches the active application id (or `'default'`). */
export async function setActiveApplication(
  store: ScopedStore,
  applicationId: string,
): Promise<ResolvedApplicationShell> {
  if (applicationId !== DEFAULT_APPLICATION_ID && !applications.has(applicationId)) {
    throw new Error(`Unknown application id: ${applicationId}`);
  }
  const p9 = ensurePhase9Store(store);
  await p9.setCustomSetting(ACTIVE_APPLICATION_SETTING_KEY, applicationId);
  return resolveActiveApplication(store);
}

/** Resets the active application back to the built-in default shell (`steerable-cli app reset`). */
export async function resetActiveApplication(
  store: ScopedStore,
): Promise<ResolvedApplicationShell> {
  const p9 = ensurePhase9Store(store);
  await p9.setCustomSetting(ACTIVE_APPLICATION_SETTING_KEY, DEFAULT_APPLICATION_ID);
  return buildDefaultApplicationShell(false);
}
