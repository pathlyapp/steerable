import { describe, expect, it } from 'vitest';
import { chatRowKeys, chatWindowTitle } from './chat-row-keys';

describe('chat row keys', () => {
  it('重命名默认绑在 F2，窗口标题带上当前会话名', () => {
    expect(chatRowKeys.rename).toBe('F2');
    expect(chatWindowTitle('周报', 'Aroli')).toBe('周报 — Aroli');
    expect(chatWindowTitle('  ', 'Aroli')).toBe('Aroli');
    expect(chatWindowTitle(undefined, 'Aroli')).toBe('Aroli');
  });
});
