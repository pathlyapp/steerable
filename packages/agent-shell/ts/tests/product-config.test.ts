import { afterEach, describe, expect, it } from 'vitest';
import {
  productConfigDirectConnection,
  resetProductConfigForTests,
  setProductConfig,
} from '../src/product-config.js';

afterEach(() => {
  resetProductConfigForTests();
});

// 「模型服务直连」是产品级开关：Aroli 打开，要求流量必须经过公司代理的
// 企业产品不声明（保持跟随系统代理）。
describe('productConfigDirectConnection', () => {
  it('未声明的产品跟随系统代理——企业产品不必显式关闭', () => {
    expect(productConfigDirectConnection()).toBe(false);
  });

  it('显式 true 才直连', () => {
    setProductConfig({ directModelConnection: true });
    expect(productConfigDirectConnection()).toBe(true);
  });

  it('显式 false 与未声明等价', () => {
    setProductConfig({ directModelConnection: false });
    expect(productConfigDirectConnection()).toBe(false);
  });

  it('非布尔值不当作打开', () => {
    setProductConfig({ directModelConnection: 'yes' as unknown as boolean });
    expect(productConfigDirectConnection()).toBe(false);
  });

  it('可以只看传入的配置对象，不依赖全局注入', () => {
    expect(productConfigDirectConnection({ directModelConnection: true })).toBe(true);
    expect(productConfigDirectConnection({})).toBe(false);
  });
});
