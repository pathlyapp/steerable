import { useEffect, useState } from 'react';

export const ORCHESTRATION_SETTING_STORAGE_KEY = 'steerable.orchestration.enabled';

const CHANGE_EVENT = 'steerable:orchestration-setting-changed';

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
 * 持久化多智能体协同编排开关到 localStorage 并广播变更。
 */
export function persistOrchestrationSetting(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(ORCHESTRATION_SETTING_STORAGE_KEY, enabled ? 'true' : 'false');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }));
  }
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
