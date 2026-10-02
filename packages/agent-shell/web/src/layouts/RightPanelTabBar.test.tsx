import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackChatSlotContribution } from '@/packs/registry';
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

function renderBar(overrides: Partial<Parameters<typeof RightPanelTabBar>[0]> = {}) {
  const onCollapse = vi.fn();
  const onOpen = vi.fn();
  render(
    <RightPanelTabBar
      tabs={['ppt']}
      active="ppt"
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
});
