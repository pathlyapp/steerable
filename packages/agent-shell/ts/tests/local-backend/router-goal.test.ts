import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  h,
  makeBroadcast,
  makeEmitCapture,
  makeSupervisor,
  makeToolRouter,
  resetRouterTestkit,
} from './router-testkit.js';
import { GoalStore } from '../../src/goal-store.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import type { ToolRouter } from '../../src/tool-router.js';

const dirs: string[] = [];

function setup(toolOverrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steerable-router-goal-'));
  dirs.push(dir);
  const goals = new GoalStore(path.join(dir, 'goals.json'));
  const events = makeBroadcast();
  const toolRouter = makeToolRouter({
    goals: () => goals,
    ...toolOverrides,
  }) as unknown as ToolRouter;
  const router = new LocalBackendRouter(toolRouter, {
    store: h.store,
    broadcast: events.broadcast,
  });
  return { goals, events, router };
}

beforeEach(() => {
  resetRouterTestkit();
  h.supervisor = makeSupervisor();
  h.streamImpl = async () => ({ status: 'completed' });
});

describe('monitored loop routes', () => {
  it('lists and stops only loops from this chat', async () => {
    const loop = {
      id: 'loop-1',
      chatId: 'chat-1',
      terminalSessionId: 'terminal-1',
      prompt: 'check',
      intervalSeconds: 5,
    };
    const stop = vi.fn(() => true);
    const { router } = setup({
      listMonitoredLoops: (chatId: string) => chatId === 'chat-1' ? [loop] : [],
      stopMonitoredLoop: (chatId: string, id: string) => chatId === 'chat-1' && id === loop.id && stop(),
    });
    const chat = await h.store.createChat('Loop routes', 'agent-a', null);
    expect(await router.handle({
      method: 'GET',
      path: `/api/v2/chats/${chat.id}/loops`,
    })).toEqual({ status: 200, data: { loops: [loop] } });
    expect(await router.handle({
      method: 'DELETE',
      path: `/api/v2/chats/${chat.id}/loops/${loop.id}`,
    })).toEqual({ status: 200, data: { success: true } });
    expect(stop).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('goal routes', () => {
  it('sets, reads, edits, pauses, resumes, completes, and clears as the user', async () => {
    const { events, router } = setup();
    const chat = await h.store.createChat('Goal route', 'agent-a', null);

    expect(await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'set', objective: 'Ship it' },
    })).toMatchObject({ status: 200, data: { goal: { objective: 'Ship it', phase: 'active' } } });
    await vi.waitFor(() => {
      expect(events.calls.some((call) => call.event === 'chat-turn-finished')).toBe(true);
    });

    expect(await router.handle({
      method: 'GET',
      path: `/api/v2/chats/${chat.id}/goal`,
    })).toMatchObject({ status: 200, data: { goal: { objective: 'Ship it' } } });

    expect(await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'edit', objective: 'Ship and verify it' },
    })).toMatchObject({ status: 200, data: { goal: { objective: 'Ship and verify it' } } });

    expect((await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'pause' },
    })).status).toBe(200);
    const finishedBeforeResume =
      events.calls.filter((call) => call.event === 'chat-turn-finished').length;
    expect((await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'resume' },
    })).status).toBe(200);
    await vi.waitFor(() => {
      expect(events.calls.filter((call) => call.event === 'chat-turn-finished').length)
        .toBeGreaterThan(finishedBeforeResume);
    });
    for (const action of ['complete', 'clear']) {
      expect((await router.handle({
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/goal`,
        body: { action },
      })).status).toBe(200);
    }
    expect(await router.handle({
      method: 'GET',
      path: `/api/v2/chats/${chat.id}/goal`,
    })).toEqual({ status: 200, data: { goal: null } });
  });

  it('broadcasts every goal change', async () => {
    const { events, router } = setup();
    const chat = await h.store.createChat('Goal events', 'agent-a', null);
    await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'set', objective: 'Observe it' },
    });
    await vi.waitFor(() => {
      expect(events.calls.some((call) => call.event === 'chat-turn-finished')).toBe(true);
    });
    await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'pause' },
    });
    expect(events.calls.filter((call) => call.event === 'goal-changed').length).toBeGreaterThanOrEqual(2);
  });

  it('wakes the chat after the user sets or resumes a goal', async () => {
    const { events, router } = setup();
    const chat = await h.store.createChat('Goal wake', 'agent-a', null);
    await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'set', objective: 'Wake now' },
    });
    await vi.waitFor(() => {
      expect(events.calls.some((call) => call.event === 'chat-turn-finished')).toBe(true);
    });

    await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'pause' },
    });
    const beforeResume = events.calls.filter((call) => call.event === 'chat-turn-finished').length;
    await router.handle({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/goal`,
      body: { action: 'resume' },
    });
    await vi.waitFor(() => {
      expect(events.calls.filter((call) => call.event === 'chat-turn-finished').length)
        .toBeGreaterThan(beforeResume);
    });
  });
});

describe('goal continuation', () => {
  it('starts internal turns until the model completes the goal', async () => {
    const { events, goals, router } = setup();
    const chat = await h.store.createChat('Goal continuation', 'agent-a', null);
    const created = await goals.create(chat.id, 'Finish both passes');
    let passes = 0;
    const systemPrompts: string[] = [];
    h.streamImpl = async (options) => {
      passes += 1;
      systemPrompts.push(options.systemPrompt);
      options.onText?.(`pass-${passes}`);
      if (passes === 2) {
        const current = (await goals.get(chat.id)).goal!;
        await goals.update({
          chatId: chat.id,
          id: current.id,
          revision: current.revision,
          action: 'complete',
          actor: 'model',
        });
      }
      return { status: 'completed' };
    };

    const capture = makeEmitCapture();
    expect((await router.handleStream({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/send`,
      body: { message: 'start' },
    }, capture.emit)).status).toBe(200);

    expect(passes).toBe(2);
    expect(systemPrompts[0]).toContain('<active_goal>\nFinish both passes\n</active_goal>');
    expect((await goals.get(chat.id)).goal).toMatchObject({ phase: 'complete', turns: 2 });
    expect(events.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'chat-turn-started' }),
      expect.objectContaining({ event: 'chat-turn-finished' }),
    ]));
    const messages = await h.store.listMessages(chat.id, 20);
    const internal = messages.find((message) =>
      message.role === 'user' && message.content.includes('<objective>'));
    expect(JSON.parse(internal?.messageMetadata ?? '{}')).toMatchObject({
      internal: true,
      trigger: 'goal',
      sourceId: created.goal?.id,
    });
  });

  it.each([
    { status: 'cancelled', text: 'some progress' },
    { status: 'failed', text: 'some progress' },
    { status: 'completed', text: '' },
  ])('does not continue after $status with text "$text"', async ({ status, text }) => {
    const { goals, router } = setup();
    const chat = await h.store.createChat('Goal stop', 'agent-a', null);
    await goals.create(chat.id, 'Do not spin');
    let passes = 0;
    h.streamImpl = async (options) => {
      passes += 1;
      if (text) options.onText?.(text);
      return { status };
    };
    const capture = makeEmitCapture();
    await router.handleStream({
      method: 'POST',
      path: `/api/v2/chats/${chat.id}/send`,
      body: { message: 'start' },
    }, capture.emit);
    expect(passes).toBe(1);
  });
});
