/**
 * `GET /api/v2/children`：子代理索引的宿主出口。
 *
 * 池只活一个回合，所以「上次派的子代理还在不在」只能问 sidecar 的持久
 * 索引。这条路由负责把查询参数翻成 `agent.children.list` 的参数，并把
 * 「sidecar 不可用」与「这个会话没有子代理」区分开——两者对调用方的含义
 * 完全不同。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { h, makeSupervisor, makeToolRouter, resetRouterTestkit } from './router-testkit.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import type { ToolRouter } from '../../src/tool-router.js';

function makeRouter(): LocalBackendRouter {
  return new LocalBackendRouter(makeToolRouter({ schemas: [] }) as unknown as ToolRouter, {
    store: h.store,
  });
}

beforeEach(() => {
  resetRouterTestkit();
});

describe('GET /api/v2/children', () => {
  it('转发到 agent.children.list 并带回索引内容', async () => {
    const row = {
      recordId: 'chat-1:child:0.1',
      parentRecordId: 'chat-1',
      childId: '0.1',
      depth: 1,
      profile: 'explore',
      engine: 'coreloop',
      status: 'completed',
      resumable: true,
      live: false,
      promptTokens: 100,
      completionTokens: 20,
      usageKnown: true,
      createdAt: '2026-11-12T10:00:00Z',
      updatedAt: '2026-11-12T10:01:00Z',
    };
    const childrenList = makeSupervisor({
      childrenList: vi.fn(async () => ({ parentRecordId: 'chat-1', children: [row] })),
    });
    h.supervisor = childrenList;

    const response = await makeRouter().handle({ method: 'GET', path: '/api/v2/children?session=chat-1' });

    expect(response?.status).toBe(200);
    const data = response?.data as { children: Array<{ childId: string }> };
    expect(data.children.map((child) => child.childId)).toEqual(['0.1']);
    expect(childrenList.childrenList).toHaveBeenCalledWith({
      parentRecordId: 'chat-1',
      includeFinished: true,
    });
  });

  it('--active 翻成 includeFinished: false', async () => {
    const childrenList = makeSupervisor({
      childrenList: vi.fn(async () => ({ parentRecordId: null, children: [] })),
    });
    h.supervisor = childrenList;

    await makeRouter().handle({ method: 'GET', path: '/api/v2/children?active=1' });

    expect(childrenList.childrenList).toHaveBeenCalledWith({ includeFinished: false });
  });

  it('previewChars 只在为正数时下发', async () => {
    const childrenList = makeSupervisor({
      childrenList: vi.fn(async () => ({ parentRecordId: null, children: [] })),
    });
    h.supervisor = childrenList;

    await makeRouter().handle({ method: 'GET', path: '/api/v2/children?previewChars=80' });
    expect(childrenList.childrenList).toHaveBeenLastCalledWith({
      includeFinished: true,
      answerPreviewChars: 80,
    });

    await makeRouter().handle({ method: 'GET', path: '/api/v2/children?previewChars=0' });
    expect(childrenList.childrenList).toHaveBeenLastCalledWith({ includeFinished: true });
  });

  it('sidecar 不可用时 503，而不是返回空列表', async () => {
    h.supervisor = null;

    const response = await makeRouter().handle({ method: 'GET', path: '/api/v2/children' });

    expect(response?.status).toBe(503);
  });

  it('查询失败时 502', async () => {
    h.supervisor = makeSupervisor({ childrenList: vi.fn(async () => null) });

    const response = await makeRouter().handle({ method: 'GET', path: '/api/v2/children' });

    expect(response?.status).toBe(502);
  });
});

describe('POST /api/v2/children/:recordId/resume (R7-2)', () => {
  const interrupted = {
    recordId: 'chat-1:child:0.3',
    parentRecordId: 'chat-1',
    childId: '0.3',
    depth: 1,
    profile: 'coder',
    engine: 'coreloop',
    status: 'interrupted',
    resumable: true,
    live: false,
    promptTokens: 1800,
    completionTokens: 210,
    usageKnown: true,
    createdAt: '2026-11-12T11:02:31Z',
    updatedAt: '2026-11-12T11:02:35Z',
  };

  it('可续的子代理返回父代理要发的续跑指令', async () => {
    h.supervisor = makeSupervisor({
      childrenList: vi.fn(async () => ({ parentRecordId: 'chat-1', children: [interrupted] })),
    });

    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:0.3/resume?session=chat-1&child=0.3',
      body: { message: '跳过测试，先给出改动清单' },
    });

    expect(response?.status).toBe(200);
    expect(response?.data).toMatchObject({
      childId: '0.3',
      recordId: 'chat-1:child:0.3',
      depth: 1,
      profile: 'coder',
      message: '跳过测试，先给出改动清单',
    });
    // 续跑必须走父代理的 agent_send：直接起游离子代理会脱离父回合的预算。
    expect(String((response?.data as { instruction?: string }).instruction)).toContain(
      'agent_send',
    );
  });

  it('消息为空时用默认续跑提示', async () => {
    h.supervisor = makeSupervisor({
      childrenList: vi.fn(async () => ({ parentRecordId: 'chat-1', children: [interrupted] })),
    });

    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:0.3/resume?session=chat-1&child=0.3',
      body: {},
    });

    expect((response?.data as { message?: string }).message).toBe(
      'Continue the original task.',
    );
  });

  it('已关闭的子代理 409，并说清要重新派发', async () => {
    h.supervisor = makeSupervisor({
      childrenList: vi.fn(async () => ({
        parentRecordId: 'chat-1',
        children: [{ ...interrupted, status: 'closed', resumable: false }],
      })),
    });

    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:0.3/resume?session=chat-1&child=0.3',
      body: {},
    });

    expect(response?.status).toBe(409);
    expect(String((response?.data as { detail?: string }).detail)).toContain('closed');
  });

  it('运行中的子代理 409（等它结算，别并发续跑）', async () => {
    h.supervisor = makeSupervisor({
      childrenList: vi.fn(async () => ({
        parentRecordId: 'chat-1',
        children: [{ ...interrupted, status: 'running', resumable: false }],
      })),
    });

    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:0.3/resume?session=chat-1&child=0.3',
      body: {},
    });

    expect(response?.status).toBe(409);
  });

  it('未知子代理 404', async () => {
    h.supervisor = makeSupervisor({
      childrenList: vi.fn(async () => ({ parentRecordId: 'chat-1', children: [] })),
    });

    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:9.9/resume?session=chat-1&child=9.9',
      body: {},
    });

    expect(response?.status).toBe(404);
  });

  it('缺 session/child 参数时 400', async () => {
    h.supervisor = makeSupervisor({});
    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:0.3/resume',
      body: {},
    });
    expect(response?.status).toBe(400);
  });
});

describe('POST /api/v2/children/:recordId/stop (R7-2)', () => {
  it('转发到 agent.children.interrupt', async () => {
    const childrenInterrupt = vi.fn(async () => ({ interrupted: true }));
    h.supervisor = makeSupervisor({ childrenInterrupt });

    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:0.2/stop?session=chat-1&child=0.2',
      body: {},
    });

    expect(response?.status).toBe(200);
    expect(response?.data).toEqual({ interrupted: true });
    expect(childrenInterrupt).toHaveBeenCalledWith('chat-1', '0.2');
  });

  it('子代理已结算时如实返回 interrupted:false', async () => {
    h.supervisor = makeSupervisor({
      childrenInterrupt: vi.fn(async () => ({ interrupted: false, reason: 'not running' })),
    });

    const response = await makeRouter().handle({
      method: 'POST',
      path: '/api/v2/children/chat-1:child:0.2/stop?session=chat-1&child=0.2',
      body: {},
    });

    expect(response?.data).toMatchObject({ interrupted: false });
  });
});
