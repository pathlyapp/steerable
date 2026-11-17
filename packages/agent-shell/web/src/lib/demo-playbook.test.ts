import { describe, expect, it } from 'vitest';
import {
  buildPlaybookScript,
  DEMO_SAMPLE_FILES,
  DEMO_STARTER_PROMPTS_EN,
  DEMO_STARTER_PROMPTS_ZH,
  matchPlaybookScenario,
} from './demo-playbook';

describe('demo-playbook', () => {
  it('routes starter prompts to their intended scenario', () => {
    for (const starter of [...DEMO_STARTER_PROMPTS_EN, ...DEMO_STARTER_PROMPTS_ZH]) {
      expect(matchPlaybookScenario(starter.prompt, { mode: starter.mode })).toBe(starter.id);
    }
  });

  it('produces multi-round recovery script for malformed tool call prompts', () => {
    const script = buildPlaybookScript({
      message: '请修复失败的 parser 单测（畸形工具调用）',
      model: 'glm-5.3-flash',
      reasoningEffort: 'high',
    });
    expect(script.id).toBe('malformed-tool');
    expect(script.rounds.length).toBe(2);
    expect(script.reply).toContain('glm-5.3-flash @high');
    expect(script.usage.totalTokens).toBeGreaterThan(0);
  });

  it('provides downloadable deliverable content for the audit report', () => {
    const script = buildPlaybookScript({
      message: 'Audit this sandbox workspace and generate audit-report.md.',
      model: 'glm-5.3-flash',
      mode: 'plan',
    });
    expect(script.id).toBe('deliverable-audit');
    expect(script.turnFiles).toHaveLength(1);
    const path = script.turnFiles![0].path;
    expect(DEMO_SAMPLE_FILES[path]).toBeDefined();
    expect(DEMO_SAMPLE_FILES[path].fileName).toBe('audit-report.md');
  });
});
