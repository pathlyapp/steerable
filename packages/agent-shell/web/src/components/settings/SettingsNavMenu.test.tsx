import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LuMonitor, LuSettings } from 'react-icons/lu';
import { SettingsNavMenu, type SettingsNavItem } from './SettingsNavMenu';

afterEach(cleanup);

const ITEMS: SettingsNavItem[] = [
  { id: 'appearance', label: '界面', Icon: LuMonitor },
  { id: 'llm', label: '模型设置', Icon: LuSettings },
];

describe('SettingsNavMenu', () => {
  it('renders all navigation items', () => {
    render(<SettingsNavMenu items={ITEMS} activeId="appearance" onSelect={() => {}} />);
    expect(screen.getByText('Settings navigation')).toBeTruthy();
    expect(screen.getByText('界面')).toBeTruthy();
    expect(screen.getByText('模型设置')).toBeTruthy();
  });

  it('highlights the active item', () => {
    render(<SettingsNavMenu items={ITEMS} activeId="appearance" onSelect={() => {}} />);
    const activeBtn = screen.getByTestId('settings-nav-item-appearance');
    expect(activeBtn.className).toContain('font-semibold');
  });

  it('triggers onSelect when an item is clicked', () => {
    const onSelect = vi.fn();
    render(<SettingsNavMenu items={ITEMS} activeId="appearance" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('settings-nav-item-llm'));
    expect(onSelect).toHaveBeenCalledWith('llm');
  });

  it('renders nothing when items array is empty', () => {
    const { container } = render(<SettingsNavMenu items={[]} activeId={null} onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
