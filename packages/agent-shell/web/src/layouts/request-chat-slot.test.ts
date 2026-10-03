import { describe, expect, it } from 'vitest';
import {
  followChatSlot,
  parseLegacyChatSlotTabId,
  requestChatSlot,
  subscribeChatSlotFollows,
  subscribeChatSlotRequests,
} from './request-chat-slot';

describe('requestChatSlot', () => {
  it('通知当前订阅者，取消后不再收到', () => {
    const seen: object[] = [];
    const unsubscribe = subscribeChatSlotRequests((request) => {
      seen.push(request);
    });
    requestChatSlot('ppt');
    requestChatSlot('word');
    unsubscribe();
    requestChatSlot('ppt');
    expect(seen).toEqual([{ kind: 'ppt' }, { kind: 'word' }]);
  });

  it('跟随请求和点击请求互不影响', () => {
    const opened: object[] = [];
    const followed: object[] = [];
    const stopOpen = subscribeChatSlotRequests((request) => opened.push(request));
    const stopFollow = subscribeChatSlotFollows((request) => followed.push(request));
    followChatSlot('ppt');
    requestChatSlot('word');
    stopFollow();
    followChatSlot('markdown');
    expect(opened).toEqual([{ kind: 'word' }]);
    expect(followed).toEqual([{ kind: 'ppt' }]);
    stopOpen();
  });

  it('同一槽位里的不同资源保留显式内容身份', () => {
    const opened: object[] = [];
    const stop = subscribeChatSlotRequests((request) => opened.push(request));
    requestChatSlot('ppt', { contentId: '/work/a.pptx', title: 'a.pptx' });
    requestChatSlot('ppt', { contentId: '/work/b.pptx', title: 'b.pptx' });
    expect(opened).toEqual([
      { kind: 'ppt', contentId: '/work/a.pptx', title: 'a.pptx' },
      { kind: 'ppt', contentId: '/work/b.pptx', title: 'b.pptx' },
    ]);
    expect(parseLegacyChatSlotTabId(`ppt:resource:${encodeURIComponent('/work/a.pptx')}`)).toEqual({
      kind: 'ppt',
      contentId: '/work/a.pptx',
    });
    stop();
  });
});
