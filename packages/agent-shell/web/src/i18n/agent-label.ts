import { t } from './runtime';

/**
 * 内置智能体的界面名按 id 翻译。库里的 name 仍是种子原文，切换语言不改历史行。
 * 用户自建智能体用库里的名字。
 */
const BUILTIN_AGENT_LABELS: Record<string, string> = {
  'local-assistant': 'Computer operator',
  'all-round-assistant': 'Assistant',
};

export function agentLabel(agent: { id: string; name: string }): string {
  const source = BUILTIN_AGENT_LABELS[agent.id];
  return source ? t(source) : agent.name;
}
