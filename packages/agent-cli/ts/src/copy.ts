/**
 * Command-line copy. Product packs do not override these strings.
 */
export const cliCopy = {
  'ask.unattended': '无人可答，请按最合理的默认继续。',
  'cli.approveAllWarning': '警告：--approve allow-all 会放行本次运行中的全部审批',
  'tui.approvalClosed': '审批已关闭',
  'tui.approvalRead': '只读自动放行',
  'tui.toolAuto': '自动',
  'tui.toolAutoAnswer': '自动回答',
  'tui.toolSessionAllow': '本会话已允许',
} as const;

export type CliCopyKey = keyof typeof cliCopy;

/** @param key Dictionary key. @returns The command-line string for that key. */
export function cliText(key: CliCopyKey): string {
  return cliCopy[key];
}
