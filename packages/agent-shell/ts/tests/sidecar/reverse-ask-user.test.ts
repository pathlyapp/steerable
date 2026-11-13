import { describe, expect, it } from 'vitest';
import {
  createAskUserBridge,
  type AskUserPromptRequest,
} from '../../src/sidecar/reverse-ask-user.js';

describe('createAskUserBridge', () => {
  it('exposes a prompt until the renderer answers it', async () => {
    const sent: AskUserPromptRequest[] = [];
    const bridge = createAskUserBridge({
      hasWindow: () => true,
      broadcast: (_channel, prompt) => sent.push(prompt),
    });

    const result = bridge.handler({
      intro: '确认信息',
      questions: [{ id: 'env', text: '目标环境？', options: ['prod'] }],
    });

    expect(bridge.pending()).toEqual(sent);
    expect(
      bridge.answer({
        requestId: sent[0].requestId,
        answers: { env: 'prod' },
      }),
    ).toEqual({ ok: true });
    expect(bridge.pending()).toEqual([]);
    await expect(result).resolves.toEqual({ answers: { env: 'prod' } });
  });

  it('keeps the owning chat id on the broadcast prompt', () => {
    const sent: AskUserPromptRequest[] = [];
    const bridge = createAskUserBridge({
      hasWindow: () => true,
      broadcast: (_channel, prompt) => sent.push(prompt),
    });

    void bridge.handler({
      intro: '确认信息',
      chatId: 'chat-a',
      questions: [{ id: 'env', text: '目标环境？', options: ['prod'] }],
    });

    expect(sent[0]?.chatId).toBe('chat-a');
    expect(bridge.pending()[0]?.chatId).toBe('chat-a');
  });

  it('keeps the full answered ask for the tool row', async () => {
    const sent: AskUserPromptRequest[] = [];
    const bridge = createAskUserBridge({
      hasWindow: () => true,
      broadcast: (_channel, prompt) => sent.push(prompt),
    });
    const pending = bridge.handler({
      intro: '继续吗',
      chatId: 'chat-1',
      questions: [{ id: 'q1', text: '要不要同时改重试次数？' }],
    });
    expect(bridge.answer({
      requestId: sent[0]?.requestId,
      answers: { q1: '无人可答，请按最合理的默认继续。' },
      unattended: true,
    })).toEqual({ ok: true });
    await pending;
    expect(bridge.takeResolved('chat-1')).toEqual({
      intro: '继续吗',
      questions: [{ id: 'q1', text: '要不要同时改重试次数？' }],
      answers: { q1: '无人可答，请按最合理的默认继续。' },
      unattended: true,
    });
    expect(bridge.takeResolved('chat-1')).toBeUndefined();
  });
});
