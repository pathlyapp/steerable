/**
 * 右侧栏位的多标签状态。
 *
 * 同一会话可以同时打开终端和若干包槽位。`activeTabId` 是当前看见的那一个。
 * `collapsed` 表示整栏收起：标签还留着，右侧不显示，再打开时恢复。
 * 标签实例 id、内容身份和显示标题分开保存；持久化兼容旧字符串格式。
 */

export type RightPanelTabRecord = {
  id: string;
  kind: string;
  contentId: string;
  title: string;
};

export type RightPanelTabs = {
  tabs: RightPanelTabRecord[];
  activeTabId: string;
  collapsed?: boolean;
};

/** 每个会话各自的标签：chatId → 打开的标签（没有标签时不落盘）。 */
export type RightPanelMap = Record<string, RightPanelTabs>;

export type RightPanelTabTarget = Omit<RightPanelTabRecord, 'id'>;

export const RIGHT_PANEL_PERSISTENCE_VERSION = 2;

let fallbackTabSequence = 0;

/** 新建一次标签实例。内容相同的标签是否复用由打开策略决定。 */
export function createRightPanelTab(
  target: RightPanelTabTarget,
  id?: string,
): RightPanelTabRecord {
  const generated = globalThis.crypto?.randomUUID?.()
    ?? `tab-${Date.now().toString(36)}-${(++fallbackTabSequence).toString(36)}`;
  return { id: id ?? generated, ...target };
}

function contentKey(tab: Pick<RightPanelTabRecord, 'kind' | 'contentId'>): string {
  return `${tab.kind}\0${tab.contentId}`;
}

/** 查找已打开的同一内容。 */
export function findRightPanelContentTab(
  current: RightPanelTabs | null,
  target: Pick<RightPanelTabRecord, 'kind' | 'contentId'>,
): RightPanelTabRecord | null {
  return current?.tabs.find((tab) =>
    tab.kind === target.kind && tab.contentId === target.contentId) ?? null;
}

/** 非当前标签只在类型声明需要保活时继续挂载。 */
export function shouldMountRightPanelTab(
  tabId: string,
  activeTabId: string,
  keepMounted: boolean,
): boolean {
  return tabId === activeTabId || keepMounted;
}

function normalizeTabRecord(
  value: unknown,
  isValidKind: (kind: string) => boolean,
): RightPanelTabRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<Record<keyof RightPanelTabRecord, unknown>>;
  if (
    typeof record.id !== 'string'
    || !record.id
    || typeof record.kind !== 'string'
    || !isValidKind(record.kind)
    || typeof record.contentId !== 'string'
    || !record.contentId
    || typeof record.title !== 'string'
    || !record.title
  ) {
    return null;
  }
  return {
    id: record.id,
    kind: record.kind,
    contentId: record.contentId,
    title: record.title,
  };
}

export function normalizeRightPanelEntry(
  value: unknown,
  isValidKind: (kind: string) => boolean,
  resolveLegacyTab: (value: string) => RightPanelTabTarget | null,
): RightPanelTabs | null {
  if (typeof value === 'string') {
    const target = resolveLegacyTab(value);
    if (!target || !isValidKind(target.kind)) return null;
    const tab = createRightPanelTab(target, `legacy:${encodeURIComponent(value)}`);
    return { tabs: [tab], activeTabId: tab.id };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as {
    tabs?: unknown;
    active?: unknown;
    activeTabId?: unknown;
    collapsed?: unknown;
  };
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const tabs: RightPanelTabRecord[] = [];
  if (Array.isArray(record.tabs)) {
    for (const item of record.tabs) {
      const tab = typeof item === 'string'
        ? (() => {
          const target = resolveLegacyTab(item);
          return target && isValidKind(target.kind)
            ? createRightPanelTab(target, `legacy:${encodeURIComponent(item)}`)
            : null;
        })()
        : normalizeTabRecord(item, isValidKind);
      if (!tab || seenIds.has(tab.id) || seenContent.has(contentKey(tab))) continue;
      seenIds.add(tab.id);
      seenContent.add(contentKey(tab));
      tabs.push(tab);
    }
  }
  if (tabs.length === 0) return null;
  const requestedActive = typeof record.activeTabId === 'string'
    ? record.activeTabId
    : typeof record.active === 'string'
      ? record.active
      : '';
  const activeTabId = tabs.some((tab) => tab.id === requestedActive)
    ? requestedActive
    : tabs.find((tab) => tab.id === `legacy:${encodeURIComponent(requestedActive)}`)?.id
      ?? tabs[0]!.id;
  return record.collapsed === true
    ? { tabs, activeTabId, collapsed: true }
    : { tabs, activeTabId };
}

/**
 * 解析持久化的「会话 → 右侧标签」映射。
 *
 * 兼容这些历史格式：
 *   - v2：{"version":2,"sessions":{"<chatId>":{"tabs":[...],"activeTabId":"..."}}}；
 *   - 旧多标签：{"<chatId>": { "tabs": ["ppt", "terminal"], "active": "ppt" }}；
 *   - 单值映射：{"<chatId>": "terminal" | "<slotId>"} → 一个标签；
 *   - 整个值就是单个字符串 → 迁到当前会话；
 *   - 更老：只记录终端是否打开过的布尔 key。
 * 无效的会话 / 栏位值会被丢弃。
 */
export function parseRightPanelMap(options: {
  raw: string | null;
  legacyTerminalOpen: string | null;
  chatId: string | null;
  isValidKind: (kind: string) => boolean;
  resolveLegacyTab: (value: string) => RightPanelTabTarget | null;
}): RightPanelMap {
  const { raw, legacyTerminalOpen, chatId, isValidKind, resolveLegacyTab } = options;
  if (raw !== null) {
    if (raw === '') return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const root = parsed as { version?: unknown; sessions?: unknown };
        const source = root.version === RIGHT_PANEL_PERSISTENCE_VERSION
          && root.sessions
          && typeof root.sessions === 'object'
          && !Array.isArray(root.sessions)
          ? root.sessions as Record<string, unknown>
          : parsed as Record<string, unknown>;
        const map: RightPanelMap = {};
        for (const [key, value] of Object.entries(source)) {
          const entry = normalizeRightPanelEntry(value, isValidKind, resolveLegacyTab);
          if (entry) map[key] = entry;
        }
        return map;
      }
    } catch {
      const entry = normalizeRightPanelEntry(raw, isValidKind, resolveLegacyTab);
      if (entry && chatId) return { [chatId]: entry };
    }
    return {};
  }
  if (legacyTerminalOpen === '1' && chatId && isValidKind('terminal')) {
    const tab = createRightPanelTab(
      { kind: 'terminal', contentId: 'terminal', title: 'Terminal' },
      'legacy:terminal',
    );
    return { [chatId]: { tabs: [tab], activeTabId: tab.id } };
  }
  return {};
}

/** 把运行时状态写成带版本的持久化载荷。 */
export function serializeRightPanelMap(map: RightPanelMap): string {
  return JSON.stringify({ version: RIGHT_PANEL_PERSISTENCE_VERSION, sessions: map });
}

/** 快捷键：整栏收着时打开并显示这一项；没开就追加并显示；已开但不是当前就切过去；当前这个就关掉。 */
export function toggleRightPanelEntry(
  current: RightPanelTabs | null,
  requested: RightPanelTabRecord,
): RightPanelTabs | null {
  const existing = findRightPanelContentTab(current, requested);
  const tab = existing ?? requested;
  if (current?.collapsed) {
    const tabs = existing ? current.tabs : [...current.tabs, tab];
    return { tabs, activeTabId: tab.id };
  }
  if (!current || !existing) {
    return {
      tabs: current ? [...current.tabs, tab] : [tab],
      activeTabId: tab.id,
    };
  }
  if (current.activeTabId !== tab.id) {
    return { tabs: current.tabs, activeTabId: tab.id };
  }
  return closeRightPanelTab(current, tab.id);
}

/** 收起整栏。标签保留，下次展开还是这些。 */
export function collapseRightPanel(current: RightPanelTabs): RightPanelTabs {
  return { tabs: current.tabs, activeTabId: current.activeTabId, collapsed: true };
}

/** 展开整栏，回到收起前正在看的标签。 */
export function expandRightPanel(current: RightPanelTabs): RightPanelTabs {
  return { tabs: current.tabs, activeTabId: current.activeTabId };
}

/** 关掉一个标签。关掉的是当前标签时，改看相邻的那一个。 */
export function closeRightPanelTab(
  current: RightPanelTabs,
  tabId: string,
): RightPanelTabs | null {
  const tabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) return null;
  if (current.activeTabId !== tabId) return { tabs, activeTabId: current.activeTabId };
  const index = current.tabs.findIndex((tab) => tab.id === tabId);
  const active = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0]!;
  return { tabs, activeTabId: active.id };
}

/**
 * 自动展开：栏位空着时打开并显示；已经有别的标签时只把这个加进去，不抢走当前标签。
 * 这个标签已经开着则保持原样。
 */
export function revealRightPanelTab(
  current: RightPanelTabs | null,
  requested: RightPanelTabRecord,
): RightPanelTabs {
  if (!current) return { tabs: [requested], activeTabId: requested.id };
  const existing = findRightPanelContentTab(current, requested);
  const tab = existing ?? requested;
  if (current.collapsed) {
    const tabs = existing ? current.tabs : [...current.tabs, tab];
    return { tabs, activeTabId: tab.id };
  }
  if (existing) return current;
  return { tabs: [...current.tabs, tab], activeTabId: current.activeTabId };
}

function sameRightPanelTabs(
  tabs: readonly RightPanelTabRecord[],
  next: readonly RightPanelTabRecord[],
): boolean {
  return tabs.length === next.length && tabs.every((tab, index) => tab.id === next[index]?.id);
}

/**
 * 对话里的预览跟着当前回合换文件。
 * 栏位关着时不重新打开。正在看终端时只把文档标签留在后面，不抢走终端。
 * 已经开着文档时，切到这一轮对应的标签。
 */
export function followRightPanelTab(
  current: RightPanelTabs | null,
  requested: RightPanelTabRecord,
): RightPanelTabs | null {
  if (!current) return null;
  const existing = findRightPanelContentTab(current, requested);
  const tab = existing ?? requested;
  const tabs = existing ? current.tabs : [...current.tabs, tab];
  const activeTab = current.tabs.find((item) => item.id === current.activeTabId);
  const activeTabId = activeTab?.kind === 'terminal' ? activeTab.id : tab.id;
  const next: RightPanelTabs = current.collapsed
    ? { tabs, activeTabId, collapsed: true }
    : { tabs, activeTabId };
  if (
    current.activeTabId === next.activeTabId
    && current.collapsed === next.collapsed
    && sameRightPanelTabs(current.tabs, next.tabs)
  ) {
    return current;
  }
  return next;
}

/** 打开并显示。已经开着时只切换当前标签。 */
export function openRightPanelTab(
  current: RightPanelTabs | null,
  requested: RightPanelTabRecord,
): RightPanelTabs {
  if (!current) return { tabs: [requested], activeTabId: requested.id };
  const existing = findRightPanelContentTab(current, requested);
  if (existing) return { tabs: current.tabs, activeTabId: existing.id };
  return { tabs: [...current.tabs, requested], activeTabId: requested.id };
}
