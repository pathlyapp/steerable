/**
 * 右侧栏位按会话隔离，并用结构化记录分开标签实例和内容身份。
 */
import { describe, expect, it } from 'vitest';
import {
  closeRightPanelTab,
  collapseRightPanel,
  createRightPanelTab,
  expandRightPanel,
  followRightPanelTab,
  openRightPanelTab,
  parseRightPanelMap,
  revealRightPanelTab,
  serializeRightPanelMap,
  shouldMountRightPanelTab,
  toggleRightPanelEntry,
  type RightPanelTabRecord,
  type RightPanelTabTarget,
} from './right-panel-tabs';
import { parseLegacyChatSlotTabId } from './request-chat-slot';

const isValidKind = (kind: string) =>
  kind === 'terminal' || kind === 'ppt' || kind === 'word' || kind === 'markdown';

function title(kind: string, contentId: string): string {
  return contentId === kind ? kind : contentId.split('/').at(-1) || kind;
}

function resolveLegacyTab(value: string): RightPanelTabTarget | null {
  const request = parseLegacyChatSlotTabId(value);
  if (!isValidKind(request.kind)) return null;
  const contentId = request.contentId ?? request.kind;
  return { kind: request.kind, contentId, title: title(request.kind, contentId) };
}

function parse(raw: string | null, chatId = 'chat-1', legacyTerminalOpen: string | null = null) {
  return parseRightPanelMap({
    raw,
    legacyTerminalOpen,
    chatId,
    isValidKind,
    resolveLegacyTab,
  });
}

function tab(kind: string, contentId = kind, id = `${kind}-tab`): RightPanelTabRecord {
  return createRightPanelTab({ kind, contentId, title: title(kind, contentId) }, id);
}

describe('parseRightPanelMap', () => {
  it('解析 v2 记录，并保留各会话各自状态', () => {
    const word = tab('word');
    const terminal = tab('terminal');
    const raw = serializeRightPanelMap({
      'chat-1': { tabs: [word, terminal], activeTabId: word.id },
      'chat-2': { tabs: [terminal], activeTabId: terminal.id },
    });
    expect(parse(raw)).toEqual({
      'chat-1': { tabs: [word, terminal], activeTabId: word.id },
      'chat-2': { tabs: [terminal], activeTabId: terminal.id },
    });
  });

  it('迁移同一 kind 的多个旧资源标签', () => {
    const first = `ppt:resource:${encodeURIComponent('/work/a.pptx')}`;
    const second = `ppt:resource:${encodeURIComponent('/work/b.pptx')}`;
    const map = parse(JSON.stringify({
      'chat-1': { tabs: [first, second], active: second },
    }));
    expect(map['chat-1']?.tabs.map(({ kind, contentId, title: tabTitle }) => ({
      kind,
      contentId,
      title: tabTitle,
    }))).toEqual([
      { kind: 'ppt', contentId: '/work/a.pptx', title: 'a.pptx' },
      { kind: 'ppt', contentId: '/work/b.pptx', title: 'b.pptx' },
    ]);
    expect(map['chat-1']?.activeTabId).toBe(`legacy:${encodeURIComponent(second)}`);
  });

  it('迁移单值映射并丢弃无效类型', () => {
    const map = parse(JSON.stringify({
      'chat-1': 'word',
      'chat-2': 'terminal',
      'chat-3': 'gone-slot',
    }));
    expect(map['chat-1']?.tabs[0]).toMatchObject({ kind: 'word', contentId: 'word' });
    expect(map['chat-2']?.tabs[0]).toMatchObject({ kind: 'terminal', contentId: 'terminal' });
    expect(map['chat-3']).toBeUndefined();
  });

  it('拒绝 v2 脏记录和重复内容', () => {
    const first = tab('ppt', '/work/a.pptx', 'first');
    const duplicate = tab('ppt', '/work/a.pptx', 'duplicate');
    const map = parse(JSON.stringify({
      version: 2,
      sessions: {
        'chat-1': {
          tabs: [first, duplicate, { id: 'bad', kind: 'gone-slot', contentId: 'x', title: 'x' }],
          activeTabId: 'duplicate',
        },
      },
    }));
    expect(map['chat-1']).toEqual({ tabs: [first], activeTabId: first.id });
  });

  it('迁移旧版单值、终端布尔值和收起标记', () => {
    expect(parse('ppt')['chat-1']?.tabs[0]).toMatchObject({ kind: 'ppt' });
    expect(parse(null, 'chat-1', '1')['chat-1']?.tabs[0]).toMatchObject({ kind: 'terminal' });
    expect(parse(null, '', '1')).toEqual({});
    const hidden = parse(JSON.stringify({
      'chat-1': { tabs: ['ppt', 'terminal'], active: 'ppt', collapsed: true },
    }))['chat-1'];
    expect(hidden?.collapsed).toBe(true);
    expect(hidden?.tabs.map((item) => item.kind)).toEqual(['ppt', 'terminal']);
  });

  it('空字符串和不存在的新会话都保持关闭', () => {
    expect(parse('')).toEqual({});
    expect(parse(JSON.stringify({ 'chat-1': 'word' }), 'chat-2')['chat-2']).toBeUndefined();
  });
});

describe('右侧标签开关', () => {
  const ppt = tab('ppt');
  const word = tab('word');
  const terminal = tab('terminal');
  const markdown = tab('markdown');

  it('依次打开多个标签，点当前标签才关掉它', () => {
    const first = toggleRightPanelEntry(null, ppt);
    expect(first).toEqual({ tabs: [ppt], activeTabId: ppt.id });
    const both = toggleRightPanelEntry(first, terminal);
    expect(both).toEqual({ tabs: [ppt, terminal], activeTabId: terminal.id });
    const back = toggleRightPanelEntry(both, ppt);
    expect(back).toEqual({ tabs: [ppt, terminal], activeTabId: ppt.id });
    expect(toggleRightPanelEntry(back, ppt)).toEqual({
      tabs: [terminal],
      activeTabId: terminal.id,
    });
  });

  it('相同 kind/contentId 聚焦已有实例，不追加重复标签', () => {
    const duplicate = tab('ppt', 'ppt', 'another-id');
    expect(openRightPanelTab({ tabs: [ppt], activeTabId: ppt.id }, duplicate)).toEqual({
      tabs: [ppt],
      activeTabId: ppt.id,
    });
  });

  it('关掉当前标签后改看旁边那个', () => {
    expect(
      closeRightPanelTab(
        { tabs: [ppt, word, terminal], activeTabId: word.id },
        word.id,
      ),
    ).toEqual({ tabs: [ppt, terminal], activeTabId: terminal.id });
  });

  it('收起后再打开，标签还是原来那些', () => {
    const open = { tabs: [ppt, terminal], activeTabId: terminal.id };
    const hidden = collapseRightPanel(open);
    expect(hidden.collapsed).toBe(true);
    expect(expandRightPanel(hidden)).toEqual(open);
  });

  it('整栏收着时快捷键和自动展开显示目标标签', () => {
    const hidden = collapseRightPanel({ tabs: [ppt], activeTabId: ppt.id });
    expect(toggleRightPanelEntry(hidden, terminal)).toEqual({
      tabs: [ppt, terminal],
      activeTabId: terminal.id,
    });
    expect(revealRightPanelTab(hidden, word)).toEqual({
      tabs: [ppt, word],
      activeTabId: word.id,
    });
  });

  it('对话跟随不打开已关闭的栏，也不抢走终端', () => {
    expect(followRightPanelTab(null, ppt)).toBeNull();
    expect(followRightPanelTab(
      { tabs: [markdown], activeTabId: markdown.id },
      ppt,
    )).toEqual({ tabs: [markdown, ppt], activeTabId: ppt.id });
    expect(followRightPanelTab(
      { tabs: [terminal], activeTabId: terminal.id },
      ppt,
    )).toEqual({ tabs: [terminal, ppt], activeTabId: terminal.id });
    const open = { tabs: [ppt], activeTabId: ppt.id };
    expect(followRightPanelTab(open, ppt)).toBe(open);
  });

  it('自动展开在已有标签时只追加，不抢走当前标签', () => {
    expect(revealRightPanelTab(null, ppt)).toEqual({ tabs: [ppt], activeTabId: ppt.id });
    expect(revealRightPanelTab(
      { tabs: [terminal], activeTabId: terminal.id },
      word,
    )).toEqual({ tabs: [terminal, word], activeTabId: terminal.id });
  });

  it('只保留当前标签或显式 keepMounted 的隐藏标签', () => {
    expect(shouldMountRightPanelTab('active', 'active', false)).toBe(true);
    expect(shouldMountRightPanelTab('hidden', 'active', false)).toBe(false);
    expect(shouldMountRightPanelTab('hidden', 'active', true)).toBe(true);
  });
});
