import { describe, expect, it } from 'vitest';
import { requestChatSlot, subscribeChatSlotRequests } from './request-chat-slot';

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
});
