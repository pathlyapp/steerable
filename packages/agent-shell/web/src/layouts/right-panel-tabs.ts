/**
 * 右侧栏位的多标签状态。
 *
 * 同一会话可以同时打开终端和若干包槽位。`active` 是当前看见的那一个。
 * 持久化兼容以前每个会话只存一个字符串的格式。
 */

export type RightPanelTabs = {
  tabs: string[];
  active: string;
};

/** 每个会话各自的标签：chatId → 打开的标签（没有标签时不落盘）。 */
export type RightPanelMap = Record<string, RightPanelTabs>;

export function normalizeRightPanelEntry(
  value: unknown,
  isValidValue: (value: string) => boolean,
): RightPanelTabs | null {
  if (typeof value === 'string') {
    return isValidValue(value) ? { tabs: [value], active: value } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { tabs?: unknown; active?: unknown };
  const seen = new Set<string>();
  const tabs: string[] = [];
  if (Array.isArray(record.tabs)) {
    for (const item of record.tabs) {
      if (typeof item !== 'string' || !isValidValue(item) || seen.has(item)) continue;
      seen.add(item);
      tabs.push(item);
    }
  }
  if (tabs.length === 0) return null;
  const active =
    typeof record.active === 'string' && tabs.includes(record.active)
      ? record.active
      : tabs[0]!;
  return { tabs, active };
}

/**
 * 解析持久化的「会话 → 右侧标签」映射。
 *
 * 兼容这些历史格式：
 *   - 多标签：{"<chatId>": { "tabs": ["ppt", "terminal"], "active": "ppt" }}；
 *   - 单值映射：{"<chatId>": "terminal" | "<slotId>"} → 一个标签；
 *   - 整个值就是单个字符串 → 迁到当前会话；
 *   - 更老：只记录终端是否打开过的布尔 key。
 * 无效的会话 / 栏位值会被丢弃。
 */
export function parseRightPanelMap(options: {
  raw: string | null;
  legacyTerminalOpen: string | null;
  chatId: string | null;
  isValidValue: (value: string) => boolean;
}): RightPanelMap {
  const { raw, legacyTerminalOpen, chatId, isValidValue } = options;
  if (raw !== null) {
    if (raw === '') return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const map: RightPanelMap = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          const entry = normalizeRightPanelEntry(value, isValidValue);
          if (entry) map[key] = entry;
        }
        return map;
      }
    } catch {
      const entry = normalizeRightPanelEntry(raw, isValidValue);
      if (entry && chatId) return { [chatId]: entry };
    }
    return {};
  }
  if (legacyTerminalOpen === '1' && chatId && isValidValue('terminal')) {
    return { [chatId]: { tabs: ['terminal'], active: 'terminal' } };
  }
  return {};
}

/** 菜单点击：没开就追加并显示；已开但不是当前就切过去；当前这个就关掉。 */
export function toggleRightPanelEntry(
  current: RightPanelTabs | null,
  kind: string,
): RightPanelTabs | null {
  if (!current || !current.tabs.includes(kind)) {
    return { tabs: current ? [...current.tabs, kind] : [kind], active: kind };
  }
  if (current.active !== kind) return { tabs: current.tabs, active: kind };
  return closeRightPanelTab(current, kind);
}

/** 关掉一个标签。关掉的是当前标签时，改看相邻的那一个。 */
export function closeRightPanelTab(
  current: RightPanelTabs,
  kind: string,
): RightPanelTabs | null {
  const tabs = current.tabs.filter((id) => id !== kind);
  if (tabs.length === 0) return null;
  if (current.active !== kind) return { tabs, active: current.active };
  const index = current.tabs.indexOf(kind);
  const active = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0]!;
  return { tabs, active };
}

/**
 * 自动展开：栏位空着时打开并显示；已经有别的标签时只把这个加进去，不抢走当前标签。
 * 这个标签已经开着则保持原样。
 */
export function revealRightPanelTab(
  current: RightPanelTabs | null,
  kind: string,
): RightPanelTabs {
  if (!current) return { tabs: [kind], active: kind };
  if (current.tabs.includes(kind)) return current;
  return { tabs: [...current.tabs, kind], active: current.active };
}

/** 打开并显示。已经开着时只切换当前标签。 */
export function openRightPanelTab(
  current: RightPanelTabs | null,
  kind: string,
): RightPanelTabs {
  if (!current) return { tabs: [kind], active: kind };
  if (current.tabs.includes(kind)) return { tabs: current.tabs, active: kind };
  return { tabs: [...current.tabs, kind], active: kind };
}
