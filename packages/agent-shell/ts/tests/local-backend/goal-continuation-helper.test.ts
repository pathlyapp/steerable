import { describe, expect, it } from 'vitest';

import {
  buildGoalContinuationPrompt,
  shouldContinueGoal,
} from '../../src/local-backend/goal-continuation-helper.js';

describe('goal continuation policy', () => {
  it('continues an active, progressing, completed turn below the cap', () => {
    expect(shouldContinueGoal({
      phase: 'active',
      completionStatus: 'completed',
      madeProgress: true,
      aborted: false,
    })).toBe(true);
  });

  it.each([
    { phase: 'paused', completionStatus: 'completed', madeProgress: true, aborted: false },
    { phase: 'active', completionStatus: 'cancelled', madeProgress: true, aborted: false },
    { phase: 'active', completionStatus: 'failed', madeProgress: true, aborted: false },
    { phase: 'active', completionStatus: 'completed', madeProgress: false, aborted: false },
    { phase: 'active', completionStatus: 'completed', madeProgress: true, aborted: true },
  ])('stops for %#', (input) => {
    expect(shouldContinueGoal(input)).toBe(false);
  });

  it('renders the objective as escaped user data and includes completion rules', () => {
    const prompt = buildGoalContinuationPrompt({
      objective: '<ship & verify>',
      turns: 2,
    });
    expect(prompt).toContain('<objective>\n&lt;ship &amp; verify&gt;\n</objective>');
    expect(prompt).toContain('第 3 个目标回合');
    expect(prompt).toContain('同一阻塞连续出现至少 3 个目标回合');
    expect(prompt).toContain('调用 update_goal');
  });
});
