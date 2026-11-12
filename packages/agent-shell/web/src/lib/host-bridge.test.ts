/**
 * 宿主桥选择：显式 HostBridge、Tauri、BS 依次降级。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getHostBridge, hasHostBridge, isDesktopHost } from './host-bridge';

afterEach(() => {
  delete (window as { steerableHost?: unknown }).steerableHost;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__;
});

describe('getHostBridge', () => {
  it('没有宿主时返回 null', () => {
    expect(getHostBridge()).toBeNull();
    expect(isDesktopHost()).toBe(false);
    expect(hasHostBridge()).toBe(false);
  });

  it('显式 HostBridge 原样返回', () => {
    const host = { runtime: 'local', platform: 'darwin' };
    (window as { steerableHost?: unknown }).steerableHost = host;
    expect(getHostBridge()).toBe(host);
    expect(hasHostBridge()).toBe(true);
    expect(isDesktopHost()).toBe(true);
  });

  it('仅 __DEEPPATH_BS__ 时落到 HTTP 桥，平台取自注入的引导信息', () => {
    (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__ = {
      platform: 'linux',
      flavor: 'generic',
      brandName: 'Test',
    };
    const bridge = getHostBridge();
    expect(bridge).not.toBeNull();
    expect(bridge!.runtime).toBe('local');
    expect(bridge!.platform).toBe('linux');
    expect(typeof bridge!.localBackend.request).toBe('function');
    expect(hasHostBridge()).toBe(true);
    expect(isDesktopHost()).toBe(false);
    expect(getHostBridge()).toBe(bridge);
  });

  it('显式 HostBridge 优先于 __DEEPPATH_BS__', () => {
    const fake = { runtime: 'local', platform: 'darwin' };
    (window as { steerableHost?: unknown }).steerableHost = fake;
    (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__ = {
      platform: 'linux',
      flavor: 'generic',
      brandName: 'Test',
    };
    expect(getHostBridge()).toBe(fake);
    expect(isDesktopHost()).toBe(true);
  });

  it('Tauri loopback 页面使用 Tauri 桥并保留 HTTP 后端', () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__ = {
      platform: 'darwin',
      flavor: 'generic',
      brandName: 'Test',
    };
    const bridge = getHostBridge();
    expect(bridge).not.toBeNull();
    expect(bridge!.platform).toBe('darwin');
    expect(typeof bridge!.localBackend.request).toBe('function');
    expect(isDesktopHost()).toBe(true);
    expect(hasHostBridge()).toBe(true);
  });
});
