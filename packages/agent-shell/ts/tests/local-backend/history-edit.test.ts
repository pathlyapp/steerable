import { describe, expect, it } from 'vitest';

import { compactHistory, forkHistory, rewindFrom, type StoredTurn } from '../../src/local-backend/history-edit.js';

const turns: StoredTurn[] = [
  { id: 'm4', role: 'assistant', content: '最新回答' },
  { id: 'm3', role: 'user', content: '最新问题' },
  { id: 'm2', role: 'assistant', content: '较早回答' },
  { id: 'm1', role: 'user', content: '较早问题' },
];

describe('history edit', () => {
  it('folds older turns into one summary and keeps the newest pair', () => {
    expect(compactHistory(turns.slice(0, 2))).toBeNull();
    expect(compactHistory(turns)).toEqual({
      deleteFromId: 'm1',
      compacted: 2,
      writes: [
        { role: 'assistant', content: '已压缩 2 条\nuser: 较早问题\nassistant: 较早回答', messageMetadata: null },
        { role: 'user', content: '最新问题', messageMetadata: null },
        { role: 'assistant', content: '最新回答', messageMetadata: null },
      ],
    });
  });

  it('rewinds from the newest user message and copies a fork in time order', () => {
    expect(rewindFrom(turns)).toEqual({ deleteFromId: 'm3', removed: 2 });
    expect(rewindFrom([{ id: 'a', role: 'assistant', content: '只有回答' }])).toBeNull();
    expect(forkHistory(turns).map((message) => message.content)).toEqual([
      '较早问题',
      '较早回答',
      '最新问题',
      '最新回答',
    ]);
  });
});
