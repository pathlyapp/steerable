/**
 * 把产品注入的 hostTools / approval 接到解析器。
 * host-tools.ts 保持无 node 依赖，供测试与渲染层复用解析规则。
 */
import os from 'node:os';
import path from 'node:path';
import { getProductConfig } from './product-config.js';
import {
  buildHostApproval,
  clampChatMode,
  isHostIpcAllowed,
  resolveChatModes,
  resolveHostTools,
  resolveSettingsChrome,
  type ChatModeId,
  type HostToolsConfig,
  type ResolvedHostTools,
} from './host-tools.js';
import {
  DEFAULT_LLM_SETTINGS,
  resolveLockedLlmSettings,
  type LlmSettings,
} from './storage/llm-settings.js';

export function getResolvedHostTools(): ResolvedHostTools {
  return resolveHostTools(getProductConfig().hostTools as HostToolsConfig | undefined);
}

export function isProductApprovalEnabled(): boolean {
  return (
    buildHostApproval({
      productApproval: getProductConfig().approval,
      envApproval: process.env.STEERABLE_APPROVAL,
      storePath: 'unused',
    }) !== undefined
  );
}

export function resolveTurnApproval(
  storePath = path.join(os.homedir(), '.steerable', 'approvals.json'),
): ReturnType<typeof buildHostApproval> {
  return buildHostApproval({
    productApproval: getProductConfig().approval,
    envApproval: process.env.STEERABLE_APPROVAL,
    storePath,
  });
}

export function assertHostIpcAllowed(channel: string): void {
  if (!isHostIpcAllowed(channel, getResolvedHostTools())) {
    throw new Error(`${channel} is disabled for this product`);
  }
}

export function resolveTurnChatMode(requested: unknown): ChatModeId {
  return clampChatMode(requested, resolveChatModes(getProductConfig().chatModes));
}

/**
 * 解析当前产品是否启用多智能体编排六件套（STEERABLE_ORCHESTRATION 环境变量与回合 payload 优先）。
 *
 * `orchestration` 既接受布尔（旧客户端）也接受对象 `{enabled, maxDepth,
 * maxParallel}`。对象形式是 R7 加上的：深度与并发是权限参数，用户在前端
 * 设置页改的值必须真的到达 sidecar，否则界面上的数字是假的。
 */
export function resolveTurnOrchestration(
  payload?: Record<string, unknown>,
): { enabled: boolean; maxDepth: number; maxParallel: number } | undefined {
  if (process.env.STEERABLE_ORCHESTRATION === '0') return undefined;
  if (process.env.STEERABLE_ORCHESTRATION === '1') {
    return { enabled: true, maxDepth: 1, maxParallel: 4 };
  }
  const readRequested = (value: unknown) => orchestrationFromValue(value);
  // 回合请求体优先（用户在前端设置中打开/关闭，随 metadata/payload 透传）
  if (payload) {
    if (payload.orchestration !== undefined) {
      return readRequested(payload.orchestration);
    }
    const meta = payload.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta === 'object' && meta.orchestration !== undefined) {
      return readRequested(meta.orchestration);
    }
  }
  const config = getProductConfig().orchestration;
  if (config === true) {
    return { enabled: true, maxDepth: 1, maxParallel: 4 };
  }
  if (typeof config === 'object' && config !== null && config.enabled !== false) {
    return {
      enabled: true,
      maxDepth: typeof config.maxDepth === 'number' ? config.maxDepth : 1,
      maxParallel: typeof config.maxParallel === 'number' ? config.maxParallel : 4,
    };
  }
  return undefined;
}

/**
 * One `orchestration` value → the turn's settings.
 *
 * A boolean is the pre-R7 form and still means 1 / 4. An object is clamped to
 * the ranges the settings page offers, because a value outside them would
 * either be rejected by the sidecar or silently allow more nesting than the UI
 * ever showed.
 *
 * @param value The payload's `orchestration` field.
 * @returns The turn's settings, or undefined when the turn must not orchestrate.
 */
function orchestrationFromValue(
  value: unknown,
): { enabled: boolean; maxDepth: number; maxParallel: number } | undefined {
  if (value === false) return undefined;
  if (value === true) return { enabled: true, maxDepth: 1, maxParallel: 4 };
  if (typeof value !== 'object' || value === null) return undefined;
  const config = value as Record<string, unknown>;
  if (config.enabled === false) return undefined;
  return {
    enabled: true,
    maxDepth: clampInt(config.maxDepth, 1, 1, 3),
    maxParallel: clampInt(config.maxParallel, 4, 1, 8),
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function isProductLlmLocked(): boolean {
  return !resolveSettingsChrome(getProductConfig().settings).llm;
}

/** 设置页开着走已存/出厂默认；关掉则钉死 product.json 的 llm。 */
export function resolveRuntimeLlmSettings(persisted: LlmSettings | null): LlmSettings {
  if (!isProductLlmLocked()) {
    return persisted ?? DEFAULT_LLM_SETTINGS;
  }
  return resolveLockedLlmSettings(getProductConfig().llm, process.env, persisted);
}
