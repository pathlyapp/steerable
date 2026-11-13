/**
 * Chat title parser — mirrors `deeppath/apps/web/src/types/chat.ts`'s
 * `parseChatTitle`. The local-backend re-uses the same `[自动化] ` prefix
 * convention as the cloud backend (deeppath-api/app/services/cron/executors/
 * automation.py:_AUTOMATION_TITLE_PREFIX), so the same parser works for both.
 */

// 与后端 automation.py 的标题前缀是同一条持久化约定，不能按界面语言改写。
export const AUTOMATION_TITLE_PREFIX = '[自动化] '; // i18n:allow
const BARE_BRACKET_PREFIX = '[自动化]'; // i18n:allow

export interface ParsedChatTitle {
  displayTitle: string;
  isAutomation: boolean;
}

export function parseChatTitle(
  rawTitle: string | null | undefined,
): ParsedChatTitle {
  const title = rawTitle ?? '';
  if (title.startsWith(AUTOMATION_TITLE_PREFIX)) {
    return {
      displayTitle: title.slice(AUTOMATION_TITLE_PREFIX.length),
      isAutomation: true,
    };
  }
  if (title.startsWith(BARE_BRACKET_PREFIX)) {
    return {
      displayTitle: title.slice(BARE_BRACKET_PREFIX.length).trimStart(),
      isAutomation: true,
    };
  }
  return { displayTitle: title, isAutomation: false };
}
