import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SafeRecoveryBanner } from './SafeRecoveryBanner';
import { isSafeRecoveryMode, stripSafeQueryParam } from '@/lib/safe-mode';

describe('SafeRecoveryBanner & safe-mode URL helpers', () => {
  it('detects ?safe=1 in both window.location.search and hash query', () => {
    expect(isSafeRecoveryMode({ search: '?safe=1', hash: '#/agent' })).toBe(true);
    expect(isSafeRecoveryMode({ search: '', hash: '#/agent?safe=1' })).toBe(true);
    expect(isSafeRecoveryMode({ search: '?safe=0', hash: '#/agent' })).toBe(false);
    expect(isSafeRecoveryMode({ search: '', hash: '#/agent' })).toBe(false);
  });

  it('strips safe=1 cleanly while preserving route and unrelated params', () => {
    expect(stripSafeQueryParam('http://127.0.0.1:4319/?safe=1&foo=bar#/agent')).toBe(
      '/?foo=bar#/agent',
    );
    expect(stripSafeQueryParam('http://127.0.0.1:4319/#/settings?safe=1&section=llm')).toBe(
      '/#/settings?section=llm',
    );
  });

  it('renders banner copy, Settings link, and Reset action button', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SafeRecoveryBanner onResetComplete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(html).toContain('Safe recovery mode');
    expect(html).toContain('Reset to default application');
    expect(html).toContain('Settings');
  });
});
