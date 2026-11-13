/**
 * 产品注入的 hostTools / approval 是服务端真源。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isShellBuiltinAgentEnabled,
  isShellBuiltinSkillEnabled,
  resetProductConfigForTests,
  setProductConfig,
} from '../src/product-config.js';
import {
  getResolvedHostTools,
  isProductApprovalEnabled,
  isProductLlmLocked,
  resolveRuntimeLlmSettings,
  resolveTurnApproval,
  resolveTurnChatMode,
  resolveTurnOrchestration,
} from '../src/host-tools-runtime.js';
import { DEFAULT_LLM_SETTINGS } from '../src/storage/llm-settings.js';

afterEach(() => {
  resetProductConfigForTests();
  delete process.env.STEERABLE_APPROVAL;
  delete process.env.DEEPSEEK_API_KEY;
});

describe('getResolvedHostTools', () => {
  it('未注入产品时缺省全开', () => {
    expect(getResolvedHostTools().terminal.chrome).toBe(true);
    expect(getResolvedHostTools()['local-fs'].chrome).toBe(true);
  });

  it('读 product.json 注入的 hostTools', () => {
    setProductConfig({
      hostTools: { terminal: false, 'local-fs': { chrome: false } },
    });
    const tools = getResolvedHostTools();
    expect(tools.terminal).toEqual({ capability: false, chrome: false });
    expect(tools['local-fs']).toEqual({ capability: true, chrome: false });
  });
});

describe('isProductApprovalEnabled / resolveTurnApproval', () => {
  it('缺省挂 host 审批', () => {
    expect(isProductApprovalEnabled()).toBe(true);
    expect(resolveTurnApproval('/tmp/approvals.json')).toMatchObject({
      mode: 'host',
      storePath: '/tmp/approvals.json',
    });
  });

  it('产品 approval:off 取消安全询问', () => {
    setProductConfig({ approval: 'off' });
    expect(isProductApprovalEnabled()).toBe(false);
    expect(resolveTurnApproval('/tmp/approvals.json')).toBeUndefined();
  });

  it('STEERABLE_APPROVAL=0 覆盖产品 host', () => {
    setProductConfig({ approval: 'host' });
    process.env.STEERABLE_APPROVAL = '0';
    expect(isProductApprovalEnabled()).toBe(false);
  });
});

describe('resolveTurnChatMode', () => {
  it('缺省放行 plan', () => {
    expect(resolveTurnChatMode('plan')).toBe('plan');
  });

  it('产品只留 agent 时客户端 plan 被钳死', () => {
    setProductConfig({ chatModes: ['agent'] });
    expect(resolveTurnChatMode('plan')).toBe('agent');
  });
});

describe('isShellBuiltinAgentEnabled', () => {
  it('未声明或缺省全关', () => {
    expect(isShellBuiltinAgentEnabled('local-assistant')).toBe(false);
    expect(isShellBuiltinAgentEnabled('all-round-assistant')).toBe(false);
  });

  it('产品显式 true 才引入', () => {
    setProductConfig({ builtinAgents: { 'local-assistant': true } });
    expect(isShellBuiltinAgentEnabled('local-assistant')).toBe(true);
    expect(isShellBuiltinAgentEnabled('all-round-assistant')).toBe(false);
  });
});

describe('isShellBuiltinSkillEnabled', () => {
  it('未声明或缺省全关', () => {
    expect(isShellBuiltinSkillEnabled('00-identity')).toBe(false);
  });

  it('true 引入全部；对象只开点名的目录', () => {
    setProductConfig({ builtinSkills: true });
    expect(isShellBuiltinSkillEnabled('00-identity')).toBe(true);
    resetProductConfigForTests();
    setProductConfig({ builtinSkills: { '80-tool-usage': true } });
    expect(isShellBuiltinSkillEnabled('80-tool-usage')).toBe(true);
    expect(isShellBuiltinSkillEnabled('00-identity')).toBe(false);
  });
});

describe('resolveRuntimeLlmSettings', () => {
  it('设置页开着时用已存/出厂默认', () => {
    expect(isProductLlmLocked()).toBe(false);
    expect(resolveRuntimeLlmSettings(null)).toEqual(DEFAULT_LLM_SETTINGS);
  });

  it('settings.llm 关掉后钉死 product.llm', () => {
    setProductConfig({
      settings: { llm: false },
      llm: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    });
    process.env.DEEPSEEK_API_KEY = 'sk-product';
    expect(isProductLlmLocked()).toBe(true);
    expect(resolveRuntimeLlmSettings(null)).toMatchObject({
      model: 'deepseek-chat',
      apiKey: 'sk-product',
    });
  });
});

describe('resolveTurnOrchestration', () => {
  it('未配置时缺省为 undefined', () => {
    expect(resolveTurnOrchestration()).toBeUndefined();
  });

  it('产品配置 orchestration: true 时开启', () => {
    setProductConfig({ orchestration: true });
    expect(resolveTurnOrchestration()).toEqual({
      enabled: true,
      maxDepth: 1,
      maxParallel: 4,
    });
  });

  it('STEERABLE_ORCHESTRATION 环境变量覆盖产品配置', () => {
    setProductConfig({ orchestration: true });
    process.env.STEERABLE_ORCHESTRATION = '0';
    expect(resolveTurnOrchestration()).toBeUndefined();

    resetProductConfigForTests();
    delete process.env.STEERABLE_ORCHESTRATION;
    process.env.STEERABLE_ORCHESTRATION = '1';
    expect(resolveTurnOrchestration()).toEqual({
      enabled: true,
      maxDepth: 1,
      maxParallel: 4,
    });
    delete process.env.STEERABLE_ORCHESTRATION;
  });

  it('对象形式带上用户调的深度与并发 (R7)', () => {
    // 界面上的数字必须真的到达 sidecar，否则它们只是装饰。
    expect(
      resolveTurnOrchestration({
        metadata: { orchestration: { enabled: true, maxDepth: 2, maxParallel: 6 } },
      }),
    ).toEqual({ enabled: true, maxDepth: 2, maxParallel: 6 });
  });

  it('布尔形式仍然只给 1 / 4（旧客户端）', () => {
    expect(resolveTurnOrchestration({ metadata: { orchestration: true } })).toEqual({
      enabled: true,
      maxDepth: 1,
      maxParallel: 4,
    });
    expect(resolveTurnOrchestration({ metadata: { orchestration: false } })).toBeUndefined();
  });

  it('对象里 enabled:false 等于关闭', () => {
    expect(
      resolveTurnOrchestration({ metadata: { orchestration: { enabled: false } } }),
    ).toBeUndefined();
  });

  it('超出界面范围的值被夹紧，不让界面藏起更大的权限', () => {
    expect(
      resolveTurnOrchestration({
        metadata: { orchestration: { enabled: true, maxDepth: 9, maxParallel: 99 } },
      }),
    ).toEqual({ enabled: true, maxDepth: 3, maxParallel: 8 });
    expect(
      resolveTurnOrchestration({
        metadata: { orchestration: { enabled: true, maxDepth: 0, maxParallel: 0 } },
      }),
    ).toEqual({ enabled: true, maxDepth: 1, maxParallel: 1 });
  });

  it('对象里缺字段时回落到缺省值', () => {
    expect(
      resolveTurnOrchestration({ metadata: { orchestration: { enabled: true } } }),
    ).toEqual({ enabled: true, maxDepth: 1, maxParallel: 4 });
  });

  it('回合请求体优先于产品配置', () => {
    setProductConfig({ orchestration: true });
    expect(
      resolveTurnOrchestration({ orchestration: { enabled: true, maxParallel: 2 } }),
    ).toEqual({ enabled: true, maxDepth: 1, maxParallel: 2 });
  });
});
