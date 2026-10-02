import { describe, expect, it } from 'vitest';
import {
  followChatSlot,
  requestChatSlot,
  subscribeChatSlotFollows,
  subscribeChatSlotRequests,
} from './request-chat-slot';

describe('requestChatSlot', () => {
  it('通知当前订阅者，取消后不再收到', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeChatSlotRequests((slotId) => {
      seen.push(slotId);
    });
    requestChatSlot('ppt');
    requestChatSlot('word');
    unsubscribe();
    requestChatSlot('ppt');
    expect(seen).toEqual(['ppt', 'word']);
  });

  it('跟随请求和点击请求互不影响', () => {
    const opened: string[] = [];
    const followed: string[] = [];
    const stopOpen = subscribeChatSlotRequests((slotId) => opened.push(slotId));
    const stopFollow = subscribeChatSlotFollows((slotId) => followed.push(slotId));
    followChatSlot('ppt');
    requestChatSlot('word');
    stopFollow();
    followChatSlot('markdown');
    expect(opened).toEqual(['word']);
    expect(followed).toEqual(['ppt']);
    stopOpen();
  });
});
