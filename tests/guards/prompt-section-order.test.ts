import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../packages/agent-shell/ts/src/local-backend/prompt-builder.js';
import { setSidecarSupervisor } from '../../packages/agent-shell/ts/src/sidecar/handle.js';
import type { SidecarSupervisor } from '../../packages/agent-shell/ts/src/sidecar/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_BUILDER_PATH = path.resolve(
  HERE,
  '../../packages/agent-shell/ts/src/local-backend/prompt-builder.ts',
);

describe('AST Guard #4: prompt-section-order & static KV-cache prefix (T-ARC-04)', () => {
  afterEach(() => {
    setSidecarSupervisor(null);
  });

  it('locks exact assembly order: personaPreamble -> chatSystemPrompt -> skills -> forcedMcpTool -> realityCheckSuffix, with zero memory/RSI leakage in system', async () => {
    setSidecarSupervisor({
      listSkills: async () => [
        {
          name: 'core-skill',
          displayName: 'Core Skill',
          description: 'Core test skill',
          dirName: '10-core',
          skillsDir: '/tmp/skills',
          origin: 'builtin',
          layer: 'eager',
          priority: 100,
          conditions: [],
          content: '[SECTION_SKILL_BODY]',
        },
      ],
    } as unknown as SidecarSupervisor);

    const built = await buildSystemPrompt({
      ignoreConditions: true,
      personaPreamble: '[SECTION_PERSONA]',
      chatSystemPrompt: '[SECTION_CHAT_SYSTEM]',
      realityCheckSuffix: '[SECTION_REALITY_SUFFIX]',
      forcedMcpTool: {
        token: 'mcp__srv__ping',
        toolName: 'ping',
        serverName: 'srv',
        description: 'ping tool',
        available: true,
      },
    });

    const idxPersona = built.prompt.indexOf('[SECTION_PERSONA]');
    const idxChatSys = built.prompt.indexOf('[SECTION_CHAT_SYSTEM]');
    const idxSkill = built.prompt.indexOf('[SECTION_SKILL_BODY]');
    const idxForcedMcp = built.prompt.indexOf('mcp__srv__ping');
    const idxReality = built.prompt.indexOf('[SECTION_REALITY_SUFFIX]');

    expect(idxPersona).toBeGreaterThanOrEqual(0);
    expect(idxPersona).toBeLessThan(idxChatSys);
    expect(idxChatSys).toBeLessThan(idxSkill);
    expect(idxSkill).toBeLessThan(idxForcedMcp);
    expect(idxForcedMcp).toBeLessThan(idxReality);

    // Memory / RSI notes MUST NEVER be concatenated inside prompt-builder.ts
    const builderSource = fs.readFileSync(PROMPT_BUILDER_PATH, 'utf8');
    expect(builderSource).not.toContain('untrusted_memory_note');
    expect(builderSource).not.toContain('refinement:');
  });
});
