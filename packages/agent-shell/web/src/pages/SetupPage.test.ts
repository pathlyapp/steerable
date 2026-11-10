/**
 * The first-run decision is the only logic on that page; the form itself is
 * the settings panel and is covered by its own tests.
 */
import { describe, expect, it } from 'vitest';
import { setupDecision } from './SetupPage';

describe('setupDecision', () => {
  it('shows the chat when a credential is already usable', () => {
    expect(setupDecision({ ok: true })).toBe('chat');
  });

  it('shows the form when no credential resolves', () => {
    expect(setupDecision({ ok: false })).toBe('form');
  });

  it('falls through to the chat when the status could not be read', () => {
    // Trapping the user behind a form because one endpoint failed is worse
    // than the turn reporting its own failure.
    expect(setupDecision(null)).toBe('chat');
  });
});
