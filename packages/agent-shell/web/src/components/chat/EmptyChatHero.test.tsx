import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const homeHint = vi.hoisted(() => ({ value: '输入消息，直接开始一段新对话。' }));

vi.mock('@/brand', () => ({
  BRAND_NAME: 'Aroli',
  get BRAND_HOME_HINT() {
    return homeHint.value;
  },
  getBrandLogoUrl: () => 'logo://mark',
}));

import { EmptyChatHero } from './EmptyChatHero';

afterEach(() => {
  cleanup();
  homeHint.value = '输入消息，直接开始一段新对话。';
});

describe('EmptyChatHero', () => {
  it('用品牌 logo 代替产品名，并显示产品配置的副文案', () => {
    render(<EmptyChatHero />);
    const logo = screen.getByRole('img', { name: 'Aroli' });
    expect(logo.getAttribute('src')).toBe('logo://mark');
    expect(screen.queryByText('Aroli')).toBeNull();
    expect(screen.getByText('输入消息，直接开始一段新对话。')).toBeTruthy();
  });

  it('homeHint 为空时不显示副文案', () => {
    homeHint.value = '   ';
    render(<EmptyChatHero />);
    expect(screen.getByRole('img', { name: 'Aroli' })).toBeTruthy();
    expect(screen.queryByText('输入消息，直接开始一段新对话。')).toBeNull();
  });
});
