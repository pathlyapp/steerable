import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackChatSlotContribution } from '@/packs/registry';
import { createRightPanelTab } from '@/layouts/right-panel-tabs';
import { RightPanelTabBar } from './RightPanelTabBar';

afterEach(() => {
  cleanup();
});

const ppt: PackChatSlotContribution = {
  slotId: 'ppt',
  title: 'PPT',
  Icon: ({ className }: { className?: string }) => <svg className={className} />,
  Component: () => null,
};

const word: PackChatSlotContribution = {
  slotId: 'word',
  title: 'Word',
  Icon: ({ className }: { className?: string }) => <svg className={className} />,
  Component: () => null,
};

const browser: PackChatSlotContribution = {
  slotId: 'browser',
  title: 'Browser',
  Icon: ({ className }: { className?: string }) => <svg className={className} />,
  Component: () => null,
  multiple: true,
};

function renderBar(overrides: Partial<Parameters<typeof RightPanelTabBar>[0]> = {}) {
  const onCollapse = vi.fn();
  const onOpen = vi.fn();
  render(
    <RightPanelTabBar
      tabs={[createRightPanelTab(
        { kind: 'ppt', contentId: 'ppt', title: 'PPT' },
        'ppt-tab',
      )]}
      activeTabId="ppt-tab"
      slots={[ppt, word]}
      showTerminal
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onOpen={onOpen}
      onCollapse={onCollapse}
      {...overrides}
    />,
  );
  return { onCollapse, onOpen };
}

describe('RightPanelTabBar', () => {
  it('开关在标签条右侧，点一下收起整栏', () => {
    const { onCollapse } = renderBar();
    const tabs = screen.getByTestId('right-panel-tabs');
    const toggle = screen.getByTestId('header-chat-panels');

    expect(tabs.contains(toggle)).toBe(false);
    expect(tabs.parentElement?.contains(toggle)).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('title')).toBe('Close Panels');

    fireEvent.click(toggle);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('还没打开的栏位从加号加进去', () => {
    const { onOpen } = renderBar();
    fireEvent.click(screen.getByTestId('right-panel-add'));
    expect(screen.queryByTestId('header-slot-ppt')).toBeNull();
    fireEvent.click(screen.getByTestId('header-terminal'));
    expect(onOpen).toHaveBeenCalledWith('terminal');
    expect(screen.queryByTestId('right-panel-add-menu')).toBeNull();
  });

  it('同一槽位的每个资源显示成独立文件标签', () => {
    const first = createRightPanelTab(
      { kind: 'ppt', contentId: '/work/季度汇报.pptx', title: '季度汇报.pptx' },
      'first',
    );
    const second = createRightPanelTab(
      { kind: 'ppt', contentId: '/work/年度计划.pptx', title: '年度计划.pptx' },
      'second',
    );
    renderBar({ tabs: [first, second], activeTabId: second.id });
    expect(screen.getByText('季度汇报.pptx')).toBeTruthy();
    expect(screen.getByText('年度计划.pptx')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('多实例类型已经打开后仍留在新建菜单', () => {
    const opened = createRightPanelTab(
      { kind: 'browser', contentId: 'browser-1', title: 'Example' },
      'browser-tab',
    );
    const { onOpen } = renderBar({
      tabs: [opened],
      activeTabId: opened.id,
      slots: [browser],
      showTerminal: false,
    });
    fireEvent.click(screen.getByTestId('right-panel-add'));
    fireEvent.click(screen.getByTestId('header-slot-browser'));
    expect(onOpen).toHaveBeenCalledWith('browser');
  });
});
