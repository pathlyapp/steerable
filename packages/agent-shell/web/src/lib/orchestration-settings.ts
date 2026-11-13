import { useEffect, useState } from 'react';

/** 开关：true / false。保留旧键，旧客户端写过的值继续生效。 */
export const ORCHESTRATION_SETTING_STORAGE_KEY = 'steerable.orchestration.enabled';
/** 深度上限（1–3）。与开关分开存，关掉开关时值保留。 */
export const ORCHESTRATION_MAX_DEPTH_KEY = 'steerable.orchestration.maxDepth';
/** 并发上限（1–8）。同上。 */
export const ORCHESTRATION_MAX_PARALLEL_KEY = 'steerable.orchestration.maxParallel';

const CHANGE_EVENT = 'steerable:orchestration-setting-changed';

/** 设置页给出的范围。超出范围的值由 `resolveTurnOrchestration` 夹紧。 */
export const ORCHESTRATION_MAX_DEPTH_RANGE = { min: 1, max: 3 } as const;
export const ORCHESTRATION_MAX_PARALLEL_RANGE = { min: 1, max: 8 } as const;

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_PARALLEL = 4;

/** 下发给回合的编排参数（`metadata.orchestration` 的对象形式）。 */
export interface OrchestrationTurnSetting {
  enabled: boolean;
  maxDepth: number;
  maxParallel: number;
}

/**
 * 读取多智能体协同编排功能开关，默认开启 (true)。
 */
export function isOrchestrationSettingEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const stored = localStorage.getItem(ORCHESTRATION_SETTING_STORAGE_KEY);
  if (stored === null) return true; // 默认开启
  return stored !== 'false' && stored !== '0';
}

/**
 * 读取编排参数（开关 + 深度 + 并发）。
 *
 * 三个键分开存，因为关掉开关时两个数字要保留：用户下次打开还是他调过的
 * 值，而不是悄悄回到 1 / 4。
 */
export function readOrchestrationSetting(): OrchestrationTurnSetting {
  return {
    enabled: isOrchestrationSettingEnabled(),
    maxDepth: readInt(
      ORCHESTRATION_MAX_DEPTH_KEY,
      DEFAULT_MAX_DEPTH,
      ORCHESTRATION_MAX_DEPTH_RANGE,
    ),
    maxParallel: readInt(
      ORCHESTRATION_MAX_PARALLEL_KEY,
      DEFAULT_MAX_PARALLEL,
      ORCHESTRATION_MAX_PARALLEL_RANGE,
    ),
  };
}

/**
 * 持久化多智能体协同编排开关到 localStorage 并广播变更。
 */
export function persistOrchestrationSetting(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(ORCHESTRATION_SETTING_STORAGE_KEY, enabled ? 'true' : 'false');
  broadcast(enabled);
}

/**
 * 持久化深度 / 并发上限并广播变更。
 *
 * @param limits Partial of the two numbers; omitted keys keep their value.
 */
export function persistOrchestrationLimits(
  limits: Partial<Pick<OrchestrationTurnSetting, 'maxDepth' | 'maxParallel'>>,
): void {
  if (typeof localStorage === 'undefined') return;
  if (limits.maxDepth !== undefined) {
    localStorage.setItem(
      ORCHESTRATION_MAX_DEPTH_KEY,
      String(clamp(limits.maxDepth, ORCHESTRATION_MAX_DEPTH_RANGE)),
    );
  }
  if (limits.maxParallel !== undefined) {
    localStorage.setItem(
      ORCHESTRATION_MAX_PARALLEL_KEY,
      String(clamp(limits.maxParallel, ORCHESTRATION_MAX_PARALLEL_RANGE)),
    );
  }
  broadcast(isOrchestrationSettingEnabled());
}

function broadcast(enabled: boolean): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }));
  }
}

function readInt(
  key: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, range);
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.trunc(value)));
}

/**
 * 响应式 hook：订阅并切换编排功能开关。
 */
export function useOrchestrationSetting(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => isOrchestrationSettingEnabled());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const custom = e as CustomEvent<boolean>;
      if (typeof custom.detail === 'boolean') {
        setEnabled(custom.detail);
      } else {
        setEnabled(isOrchestrationSettingEnabled());
      }
    };
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const update = (next: boolean) => {
    setEnabled(next);
    persistOrchestrationSetting(next);
  };

  return [enabled, update];
}

/**
 * 响应式 hook：订阅并修改编排参数（开关 + 两个上限）。
 */
export function useOrchestrationLimits(): [
  OrchestrationTurnSetting,
  (next: Partial<OrchestrationTurnSetting>) => void,
] {
  const [setting, setSetting] = useState<OrchestrationTurnSetting>(() =>
    readOrchestrationSetting(),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setSetting(readOrchestrationSetting());
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const update = (next: Partial<OrchestrationTurnSetting>) => {
    if (next.enabled !== undefined) persistOrchestrationSetting(next.enabled);
    if (next.maxDepth !== undefined || next.maxParallel !== undefined) {
      persistOrchestrationLimits({
        ...(next.maxDepth !== undefined ? { maxDepth: next.maxDepth } : {}),
        ...(next.maxParallel !== undefined ? { maxParallel: next.maxParallel } : {}),
      });
    }
    setSetting(readOrchestrationSetting());
  };

  return [setting, update];
}
