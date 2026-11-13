import { describe, expect, it } from 'vitest';
import {
  chatIdFromHash,
  peekConversationPreview,
  pinConversationPreview,
  publishConversationPreview,
  resetConversationPreviewForTests,
  subscribeConversationPreview,
} from './conversation-preview';

describe('conversation preview', () => {
  it('按会话记住预览，点开的文件钉住，直到翻到别的回合', () => {
    resetConversationPreviewForTests();
    const seen: string[] = [];
    const stop = subscribeConversationPreview((target) => {
      seen.push(`${target.chatId}:${target.path}`);
    });
    publishConversationPreview({ chatId: 'a', messageId: 'm1', path: '/work/deck.pptx' });
    publishConversationPreview({ chatId: 'b', messageId: 'm9', path: '/work/other.md' });
    pinConversationPreview('a', '/work/notes.md', 'm1');
    publishConversationPreview({ chatId: 'a', messageId: 'm1', path: '/work/deck.pptx' });
    publishConversationPreview({ chatId: 'a', messageId: 'm2', path: '/work/next.docx' });
    expect(peekConversationPreview('a')).toEqual({
      chatId: 'a',
      messageId: 'm2',
      path: '/work/next.docx',
    });
    expect(peekConversationPreview('b')?.path).toBe('/work/other.md');
    expect(seen).toEqual([
      'a:/work/deck.pptx',
      'b:/work/other.md',
      'a:/work/notes.md',
      'a:/work/next.docx',
    ]);
    stop();
    resetConversationPreviewForTests();
  });

  it('从地址里取出会话 id', () => {
    expect(chatIdFromHash('#/agent/abc-1')).toBe('abc-1');
    expect(chatIdFromHash('#/settings')).toBeNull();
  });
});
