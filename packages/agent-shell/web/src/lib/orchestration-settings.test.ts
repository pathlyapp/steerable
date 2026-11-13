/**
 * R7 编排参数：开关、深度、并发三个键分开存，且下发时是对象形式。
 *
 * 这里锁住两件事：关掉开关时两个数字要保留（用户下次打开还是他调过的值），
 * 以及越界 / 坏值被夹紧到界面给出的范围内——界面藏不起比它显示的更大的权限。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ORCHESTRATION_MAX_DEPTH_KEY,
  ORCHESTRATION_MAX_PARALLEL_KEY,
  ORCHESTRATION_SETTING_STORAGE_KEY,
  isOrchestrationSettingEnabled,
  persistOrchestrationLimits,
  persistOrchestrationSetting,
  readOrchestrationSetting,
} from './orchestration-settings';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
});

describe('readOrchestrationSetting', () => {
  it('空存储时默认开启、深度 1、并发 4', () => {
    expect(readOrchestrationSetting()).toEqual({
      enabled: true,
      maxDepth: 1,
      maxParallel: 4,
    });
  });

  it('读出用户调过的深度与并发', () => {
    store.set(ORCHESTRATION_MAX_DEPTH_KEY, '2');
    store.set(ORCHESTRATION_MAX_PARALLEL_KEY, '6');
    expect(readOrchestrationSetting()).toMatchObject({ maxDepth: 2, maxParallel: 6 });
  });

  it('关掉开关时两个数字仍保留', () => {
    // 关闭不是「重置」：用户下次打开要看到他调过的值。
    store.set(ORCHESTRATION_SETTING_STORAGE_KEY, 'false');
    store.set(ORCHESTRATION_MAX_DEPTH_KEY, '3');
    store.set(ORCHESTRATION_MAX_PARALLEL_KEY, '8');
    expect(readOrchestrationSetting()).toEqual({
      enabled: false,
      maxDepth: 3,
      maxParallel: 8,
    });
  });

  it('越界的存量值被夹紧', () => {
    store.set(ORCHESTRATION_MAX_DEPTH_KEY, '99');
    store.set(ORCHESTRATION_MAX_PARALLEL_KEY, '0');
    expect(readOrchestrationSetting()).toMatchObject({ maxDepth: 3, maxParallel: 1 });
  });

  it('无法解析的值回落到缺省', () => {
    store.set(ORCHESTRATION_MAX_DEPTH_KEY, 'deep');
    store.set(ORCHESTRATION_MAX_PARALLEL_KEY, '');
    expect(readOrchestrationSetting()).toMatchObject({ maxDepth: 1, maxParallel: 4 });
  });
});

describe('persistOrchestrationLimits', () => {
  it('写入时夹紧到界面范围', () => {
    persistOrchestrationLimits({ maxDepth: 9, maxParallel: 0 });
    expect(store.get(ORCHESTRATION_MAX_DEPTH_KEY)).toBe('3');
    expect(store.get(ORCHESTRATION_MAX_PARALLEL_KEY)).toBe('1');
  });

  it('只改一项时另一项不动', () => {
    persistOrchestrationLimits({ maxDepth: 2, maxParallel: 6 });
    persistOrchestrationLimits({ maxDepth: 3 });
    expect(store.get(ORCHESTRATION_MAX_DEPTH_KEY)).toBe('3');
    expect(store.get(ORCHESTRATION_MAX_PARALLEL_KEY)).toBe('6');
  });

  it('调参数不动开关', () => {
    persistOrchestrationSetting(false);
    persistOrchestrationLimits({ maxParallel: 2 });
    expect(isOrchestrationSettingEnabled()).toBe(false);
  });
});
