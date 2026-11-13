export interface RuleContext {
  ruleFileCount?: number;
  rulesActive?: boolean;
  files?: string[];
  project?: unknown;
}

/** Status line for loaded or unloaded project rule files. */
export function ruleStatusLine(context: RuleContext, surface: 'cli' | 'tui'): string | null {
  const count = context.ruleFileCount ?? 0;
  if (count <= 0) return null;
  if (!context.rulesActive) return `有 ${count} 个规则文件未加载（--trust 加载）`;
  if (surface === 'tui') return `已加载 ${count} 个规则文件`;
  const names = (context.files ?? []).map((file) => file.split(/[/\\]/).pop() || file).filter((name) => name.length > 0);
  return names.length > 0 ? `已加载 ${count} 个规则文件：${names.join('、')}` : `已加载 ${count} 个规则文件`;
}
