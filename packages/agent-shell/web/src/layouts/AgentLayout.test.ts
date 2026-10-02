/**
 * 右侧栏位按会话隔离，并且一个会话可以同时打开多个标签。
 *
 * 以前 `deeppath.agent.rightPanel` 存的是单个全局值，会话 1 打开文档预览会让
 * 会话 2 也跟着打开。现在存 chatId → 标签列表，并兼容旧的单值格式。
 */
import { describe, expect, it } from 'vitest';
import {
  closeRightPanelTab,
  parseRightPanelMap,
  revealRightPanelTab,
  toggleRightPanelEntry,
} from './right-panel-tabs';

const isValidValue = (value: string) =>
  value === 'terminal' || value === 'ppt' || value === 'word';

describe('parseRightPanelMap', () => {
  it('解析多标签，并保留各会话各自的状态', () => {
    const map = parseRightPanelMap({
      raw: JSON.stringify({
        'chat-1': { tabs: ['word', 'terminal'], active: 'word' },
        'chat-2': { tabs: ['terminal'], active: 'terminal' },
      }),
      legacyTerminalOpen: null,
      chatId: 'chat-1',
      isValidValue,
    });
    expect(map).toEqual({
      'chat-1': { tabs: ['word', 'terminal'], active: 'word' },
      'chat-2': { tabs: ['terminal'], active: 'terminal' },
    });
  });

  it('把旧的单值映射迁成一个标签', () => {
    const map = parseRightPanelMap({
      raw: JSON.stringify({ 'chat-1': 'word', 'chat-2': 'terminal' }),
      legacyTerminalOpen: null,
      chatId: 'chat-1',
      isValidValue,
    });
    expect(map).toEqual({
      'chat-1': { tabs: ['word'], active: 'word' },
      'chat-2': { tabs: ['terminal'], active: 'terminal' },
    });
  });

  it('丢弃无效栏位值，保证脏数据不会卡住面板', () => {
    const map = parseRightPanelMap({
      raw: JSON.stringify({
        'chat-1': { tabs: ['word', 'gone-slot'], active: 'gone-slot' },
        'chat-2': 'gone-slot',
        'chat-3': 42,
      }),
      legacyTerminalOpen: null,
      chatId: 'chat-1',
      isValidValue,
    });
    expect(map).toEqual({
      'chat-1': { tabs: ['word'], active: 'word' },
    });
  });

  it('把旧版单值迁移到当前会话', () => {
    const map = parseRightPanelMap({
      raw: 'ppt',
      legacyTerminalOpen: null,
      chatId: 'chat-1',
      isValidValue,
    });
    expect(map).toEqual({ 'chat-1': { tabs: ['ppt'], active: 'ppt' } });
  });

  it('空字符串按"都关着"处理', () => {
    expect(
      parseRightPanelMap({
        raw: '',
        legacyTerminalOpen: null,
        chatId: 'chat-1',
        isValidValue,
      }),
    ).toEqual({});
  });

  it('更老的终端布尔 key 迁移到当前会话；没有会话时不迁', () => {
    expect(
      parseRightPanelMap({
        raw: null,
        legacyTerminalOpen: '1',
        chatId: 'chat-1',
        isValidValue,
      }),
    ).toEqual({ 'chat-1': { tabs: ['terminal'], active: 'terminal' } });
    expect(
      parseRightPanelMap({
        raw: null,
        legacyTerminalOpen: '1',
        chatId: null,
        isValidValue,
      }),
    ).toEqual({});
  });

  it('新会话不在映射里 → 查不到即视为关闭', () => {
    const map = parseRightPanelMap({
      raw: JSON.stringify({ 'chat-1': 'word' }),
      legacyTerminalOpen: null,
      chatId: 'chat-2',
      isValidValue,
    });
    expect(map['chat-2']).toBeUndefined();
  });
});

describe('右侧标签开关', () => {
  it('依次打开多个标签，点当前标签才关掉它', () => {
    const ppt = toggleRightPanelEntry(null, 'ppt');
    expect(ppt).toEqual({ tabs: ['ppt'], active: 'ppt' });
    const both = toggleRightPanelEntry(ppt, 'terminal');
    expect(both).toEqual({ tabs: ['ppt', 'terminal'], active: 'terminal' });
    const back = toggleRightPanelEntry(both, 'ppt');
    expect(back).toEqual({ tabs: ['ppt', 'terminal'], active: 'ppt' });
    const closed = toggleRightPanelEntry(back, 'ppt');
    expect(closed).toEqual({ tabs: ['terminal'], active: 'terminal' });
  });

  it('关掉当前标签后改看旁边那个', () => {
    expect(
      closeRightPanelTab({ tabs: ['ppt', 'word', 'terminal'], active: 'word' }, 'word'),
    ).toEqual({ tabs: ['ppt', 'terminal'], active: 'terminal' });
  });

  it('自动展开在已有标签时只追加，不抢走当前标签', () => {
    expect(revealRightPanelTab(null, 'ppt')).toEqual({ tabs: ['ppt'], active: 'ppt' });
    expect(
      revealRightPanelTab({ tabs: ['terminal'], active: 'terminal' }, 'word'),
    ).toEqual({ tabs: ['terminal', 'word'], active: 'terminal' });
    expect(
      revealRightPanelTab({ tabs: ['ppt'], active: 'ppt' }, 'ppt'),
    ).toEqual({ tabs: ['ppt'], active: 'ppt' });
  });
});
