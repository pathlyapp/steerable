/**
 * AgentSidebar 交互契约：
 *   - 新对话只开落地页不落库（既有用例，见第一个 describe）；
 *   - 会话列表：置顶优先 + 时间倒序、[自动化] 标题解析、
 *     日期分组、空态 / 加载态 / 错误横幅、底部分页提示；
 *   - 会话行：点击导航、删除弹窗确认（取消不删，确认才删）、
 *     删除当前会话回落地页、删除失败不导航；
 *   - 入口导航与高亮：插件页（含旧深链）与综合设置随路由各自高亮；
 *   - 右侧面板：终端按钮快捷键提示随平台变化，包槽位渲染分段控件；
 *   - 副作用：进入会话路由同步 selectedAgentId、菜单 Cmd+N / Cmd+T 订阅与
 *     退订、滚动接近底部自动加载下一页；
 *   - 项目模式（Electron）：项目分组与折叠、拖拽组头排序、孤儿会话回落日期分组、
 *     项目内超过 5 条先收起，每次再展开 5 条；
 *     新建（弹窗填名称 + 可选源文件夹）；组头 hover 为 ✎ 新建对话 / ·· 菜单
 *     （重命名 / 编辑项目多源文件夹 / 访达或文件管理器 / 弹窗确认删除）。
 * 智能体挑选列表已迁到 ChatInput（见组件头注释），侧栏只剩同步副作用可测。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@/lib/host-bridge';
import type { UseChatsAndAgentsResult } from '@/hooks/useChatsAndAgents';
import type { LocalChat, LocalChatAgent, LocalProject } from '@/lib/local-api';
import type { RightPanelState } from '@/layouts/AgentLayout';
import { resetProjectsStoreForTests } from '@/hooks/useProjects';

// 可控桥桩：bridgeStub 为 null 时 hasHostBridge() = false（纯浏览器预览路径），
// 项目模式用例经 enterElectron() 装上带 selectDirectory 的桥。
let bridgeStub: HostBridge | null = null;

vi.mock('@/lib/host-bridge', () => ({
  hasHostBridge: () => bridgeStub !== null,
  getHostBridge: () => bridgeStub,
}));

const listProjects = vi.fn();
const createProject = vi.fn();
const updateProject = vi.fn();
const reorderProjects = vi.fn();
const deleteProject = vi.fn();
const openLocalPath = vi.fn();
const setChatPinned = vi.fn();
const getChatLiveStream = vi.fn();

vi.mock('@/lib/local-api', () => ({
  LLM_SETTINGS_CHANGED_EVENT: 'steerable:llm-settings-changed',
  listProjects: (...args: unknown[]) => listProjects(...args),
  createProject: (...args: unknown[]) => createProject(...args),
  updateProject: (...args: unknown[]) => updateProject(...args),
  reorderProjects: (...args: unknown[]) => reorderProjects(...args),
  deleteProject: (...args: unknown[]) => deleteProject(...args),
  openLocalPath: (...args: unknown[]) => openLocalPath(...args),
  setChatPinned: (...args: unknown[]) => setChatPinned(...args),
  getChatLiveStream: (chatId: string) => getChatLiveStream(chatId),
  getLlmAccount: async () => ({
    status: 'unsupported',
    provider: null,
    label: '',
    available: null,
    currency: null,
    total: null,
    granted: null,
    toppedUp: null,
  }),
}));

vi.mock('@/brand', () => ({
  BRAND_NAME: '测试助手',
  BRAND_TITLE: '测试助手',
  getBrandLogoUrl: () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
}));

const { AgentSidebar } = await import('./AgentSidebar');

const originalPlatform = window.navigator.platform;

const SIDEBAR_SECTIONS_KEY = 'deeppath.agent.sidebarSections';

beforeEach(() => {
  resetProjectsStoreForTests();
  localStorage.removeItem(SIDEBAR_SECTIONS_KEY);
  bridgeStub = null;
  listProjects.mockReset();
  createProject.mockReset();
  updateProject.mockReset();
  reorderProjects.mockReset();
  deleteProject.mockReset();
  openLocalPath.mockReset();
  setChatPinned.mockReset();
  getChatLiveStream.mockReset();
  listProjects.mockResolvedValue({ projects: [] });
  getChatLiveStream.mockResolvedValue({ active: false });
  openLocalPath.mockResolvedValue({ success: true });
  setChatPinned.mockResolvedValue({ success: true, isPinned: true });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window.navigator, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
});

const agent: LocalChatAgent = {
  id: 'local-assistant',
  slug: 'local-assistant',
  name: '电脑操作员',
  icon: null,
  color: '#4f46e5',
  description: null,
  rolePrompt: null,
  isBuiltin: true,
};

const existingChat: LocalChat = {
  id: 'chat-with-content',
  projectId: null,
  userId: 'local',
  title: '已经聊过的对话',
  agentId: agent.id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  isPinned: false,
  systemPrompt: null,
  pinnedRefs: null,
};

function makeChat(overrides: Partial<LocalChat> = {}): LocalChat {
  return {
    id: 'chat-x',
    projectId: null,
    userId: 'local',
    title: '测试会话',
    agentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    isPinned: false,
    systemPrompt: null,
    pinnedRefs: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    id: 'proj-1',
    name: '项目甲',
    folderPath: '/tmp/proj-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 相对今天零点偏移 n 天的 ISO 时间（日期分组用例用）。 */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** 今天指定整点的 ISO 时间（同分组内排序用例用，避免跨组）。 */
function todayAt(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
}

function baseHostBridge(overrides: Partial<HostBridge> = {}): HostBridge {
  return {
    runtime: 'local',
    platform: 'darwin',
    local: {
      selectDirectory: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
      captureScreenshot: vi.fn(async () => ({ success: false as const, error: '未实现' })),
    },
    localBackend: {
      // 侧栏用例不对 request 做断言；vi.fn 保不住泛型签名，这里按接口收窄。
      request: vi.fn() as unknown as HostBridge['localBackend']['request'],
      startStream: vi.fn(async () => null),
      cancelStream: vi.fn(),
    },
    ...overrides,
  };
}

/** 进入 Electron 模式：listProjects 应答给定项目列表，桥带可断言的目录选择器。 */
function enterElectron(projects: LocalProject[]) {
  listProjects.mockResolvedValue({ projects });
  const selectDirectory = vi.fn(async () => ({ canceled: true, filePaths: [] as string[] }));
  bridgeStub = baseHostBridge();
  bridgeStub.local!.selectDirectory = selectDirectory;
  return { selectDirectory };
}

function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="loc">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function makeData(overrides: Partial<UseChatsAndAgentsResult> = {}): UseChatsAndAgentsResult {
  return {
    chats: [existingChat],
    agents: [agent],
    isLoading: false,
    error: null,
    selectedAgentId: agent.id,
    setSelectedAgentId: vi.fn(),
    refreshChats: vi.fn(async () => {}),
    refreshAgents: vi.fn(async () => {}),
    createChat: vi.fn(),
    deleteChat: vi.fn(async () => true),
    patchChatTitle: vi.fn(),
    isLoadingMoreChats: false,
    hasMoreChats: false,
    loadMoreChats: vi.fn(async () => {}),
    ...overrides,
  };
}

interface RenderSidebarOptions {
  data?: Partial<UseChatsAndAgentsResult>;
  rightPanel?: RightPanelState;
  onToggleRightPanel?: (kind: string) => void;
  onCollapse?: () => void;
}

function renderSidebar(
  initialEntry: string,
  createChat = vi.fn(),
  options: RenderSidebarOptions = {},
) {
  const data = makeData({ createChat, ...options.data });
  const onToggleRightPanel = options.onToggleRightPanel ?? vi.fn();
  const onCollapse = options.onCollapse ?? vi.fn();

  const utils = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          element={
            <>
              <AgentSidebar
                data={data}
                rightPanel={options.rightPanel ?? null}
                onToggleRightPanel={onToggleRightPanel}
                onCollapse={onCollapse}
              />
              <LocationProbe />
              <Outlet />
            </>
          }
        >
          <Route path="/" element={<div />} />
          <Route path="/agent" element={<div />} />
          <Route path="/agent/:chatId" element={<div />} />
          <Route path="/settings" element={<div />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  return { createChat, data, onToggleRightPanel, onCollapse, ...utils };
}

function openProjectMenu() {
  fireEvent.click(screen.getByLabelText('Project menu'));
  expect(screen.getByTestId('project-overflow-menu')).toBeTruthy();
}

function projectIds(): string[] {
  return screen.getAllByTestId('sidebar-project').map((el) => el.getAttribute('data-project-id') ?? '');
}

function projectHandle(projectId: string): HTMLElement {
  const handle = document.querySelector(
    `[data-testid="sidebar-project-handle"][data-project-id="${projectId}"]`,
  );
  if (!(handle instanceof HTMLElement)) throw new Error(`项目拖拽把手不存在: ${projectId}`);
  return handle;
}

/**
 * happy-dom 的 DragEvent 不带 clientY，fireEvent.drop({ clientY }) 到不了
 * 处理函数。补一个可取消的原生事件，让上下半区的落点能测。
 */
function dispatchProjectPointer(
  element: HTMLElement,
  type: 'dragover' | 'drop',
  clientY: number,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientY', { value: clientY });
  act(() => {
    element.dispatchEvent(event);
  });
}

function projectBlock(projectId: string): HTMLElement {
  const block = document.querySelector(
    `[data-testid="sidebar-project"][data-project-id="${projectId}"]`,
  );
  if (!(block instanceof HTMLElement)) throw new Error(`项目块不存在: ${projectId}`);
  return block;
}

/** happy-dom 的 getBoundingClientRect 恒为 0。按 data-project-id 给项目块一个高度，落点才能分出上下半。 */
function installProjectRects(
  rects: Record<string, { top: number; height: number }>,
): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const id = this.getAttribute('data-project-id');
    const spec = id ? rects[id] : undefined;
    if (!spec) return original.call(this);
    const { top, height } = spec;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 160,
      width: 160,
      height,
      x: 0,
      y: top,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

/** 按 data-chat-id 取会话行容器。 */
function chatRow(chatId: string): HTMLElement {
  const row = document.querySelector(`[data-chat-id="${chatId}"]`);
  if (!row) throw new Error(`会话行不存在: ${chatId}`);
  return row as HTMLElement;
}

describe('AgentSidebar 新对话不落库', () => {
  it('打开落地页且不调用 createChat', () => {
    const { createChat } = renderSidebar('/agent/chat-with-content');
    fireEvent.click(screen.getByTestId('sidebar-new-chat'));
    expect(createChat).not.toHaveBeenCalled();
    expect(screen.getByTestId('loc').textContent).toBe('/agent');
  });

  it('连点两次也不会多出侧栏行', () => {
    renderSidebar('/agent');
    const before = screen.getAllByTestId('sidebar-chat-row').length;
    fireEvent.click(screen.getByTestId('sidebar-new-chat'));
    fireEvent.click(screen.getByTestId('sidebar-new-chat'));
    expect(screen.getAllByTestId('sidebar-chat-row')).toHaveLength(before);
  });

  it('打开插件页', () => {
    renderSidebar('/agent');
    fireEvent.click(screen.getByTestId('sidebar-plugins'));
    expect(screen.getByTestId('loc').textContent).toBe('/settings?section=plugins');
  });
});

describe('AgentSidebar 会话列表渲染', () => {
  it('渲染会话标题', () => {
    const noAgent = makeChat({ id: 'c-no-agent', title: '无智能体会话', agentId: null });
    renderSidebar('/agent', vi.fn(), { data: { chats: [existingChat, noAgent] } });

    expect(chatRow('chat-with-content').textContent).toContain('已经聊过的对话');
    expect(chatRow('c-no-agent').textContent).toContain('无智能体会话');
  });

  it('没有置顶会话时不显示置顶分组', () => {
    renderSidebar('/agent', vi.fn(), {
      data: { chats: [makeChat({ id: 'c-plain', title: '普通会话' })] },
    });
    expect(screen.queryByText('Pinned')).toBeNull();
    expect(screen.queryByText('暂无置顶会话')).toBeNull();
  });

  it('同一日期分组内置顶会话排在普通会话之前', () => {
    const pinnedEarly = makeChat({
      id: 'c-pinned',
      title: '置顶的较早会话',
      isPinned: true,
      updatedAt: todayAt(1),
    });
    const fresh = makeChat({ id: 'c-fresh', title: '较晚的普通会话', updatedAt: todayAt(23) });
    renderSidebar('/agent', vi.fn(), { data: { chats: [fresh, pinnedEarly] } });

    const ids = screen.getAllByTestId('sidebar-chat-row').map((r) => r.getAttribute('data-chat-id'));
    expect(ids).toEqual(['c-pinned', 'c-fresh']);
  });

  it('置顶会话跨日期分组也排在最前：独立「置顶」组优先于「今天」', () => {
    const pinnedOld = makeChat({
      id: 'c-pinned-old',
      title: '五天前置顶的会话',
      isPinned: true,
      updatedAt: daysAgo(5),
    });
    const fresh = makeChat({ id: 'c-fresh', title: '今天的普通会话', updatedAt: daysAgo(0) });
    renderSidebar('/agent', vi.fn(), { data: { chats: [fresh, pinnedOld] } });

    // 组头顺序：置顶组在「今天」之前
    expect(screen.getByText('Pinned')).toBeTruthy();
    const pinnedHeader = screen.getByText('Pinned');
    const todayHeader = screen.getByText('Today');
    expect(
      pinnedHeader.compareDocumentPosition(todayHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 行顺序：旧的置顶会话仍在今天的普通会话之前
    const ids = screen.getAllByTestId('sidebar-chat-row').map((r) => r.getAttribute('data-chat-id'));
    expect(ids).toEqual(['c-pinned-old', 'c-fresh']);
  });

  it('[自动化] 前缀被解析为图标与提示，不进入展示标题', () => {
    const auto = makeChat({ id: 'c-auto', title: '[自动化] 每小时巡检' });
    renderSidebar('/agent', vi.fn(), { data: { chats: [auto] } });

    const rowButton = screen.getByTitle('[Triggered by automation] 每小时巡检');
    expect(rowButton.textContent).toContain('每小时巡检');
    expect(rowButton.textContent).not.toContain('[自动化]');
    expect(screen.getByLabelText('Triggered by automation')).toBeTruthy();
  });

  it('无项目会话按今天 / 昨天日期分组且新组在前', () => {
    const todayChat = makeChat({ id: 'c-today', title: '今天的会话', updatedAt: daysAgo(0) });
    const yesterdayChat = makeChat({ id: 'c-yesterday', title: '昨天的会话', updatedAt: daysAgo(1) });
    renderSidebar('/agent', vi.fn(), { data: { chats: [yesterdayChat, todayChat] } });

    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
    const ids = screen.getAllByTestId('sidebar-chat-row').map((r) => r.getAttribute('data-chat-id'));
    expect(ids).toEqual(['c-today', 'c-yesterday']);
  });

  it('空列表展示空态，加载中展示 spinner，错误走 alert 横幅', () => {
    const { unmount } = renderSidebar('/agent', vi.fn(), { data: { chats: [] } });
    expect(screen.getByText('No chats yet')).toBeTruthy();
    unmount();

    const second = renderSidebar('/agent', vi.fn(), { data: { chats: [], isLoading: true } });
    expect(screen.getByText('Loading...')).toBeTruthy();
    second.unmount();

    renderSidebar('/agent', vi.fn(), { data: { error: '列表加载失败' } });
    expect(screen.getByRole('alert').textContent).toContain('列表加载失败');
  });

  it('底部汇总随会话数变化', () => {
    renderSidebar('/agent', vi.fn(), {
      data: { chats: [existingChat, makeChat({ id: 'c-2', title: '第二条' })] },
    });
    expect(screen.queryByText('· 2')).toBeNull();
    expect(screen.getByText('Total chats: 2')).toBeTruthy();
  });

  it('有更多页时底部提示继续下滑，加载中提示加载更多', () => {
    const { unmount } = renderSidebar('/agent', vi.fn(), { data: { hasMoreChats: true } });
    expect(screen.getByText('Scroll down to load more')).toBeTruthy();
    unmount();

    renderSidebar('/agent', vi.fn(), { data: { hasMoreChats: true, isLoadingMoreChats: true } });
    expect(screen.getByText('Loading more...')).toBeTruthy();
  });
});

describe('AgentSidebar 会话行交互', () => {
  it('点击会话行导航到对应会话', () => {
    renderSidebar('/agent');
    fireEvent.click(screen.getByText('已经聊过的对话'));
    expect(screen.getByTestId('loc').textContent).toBe('/agent/chat-with-content');
  });

  it('删除需弹窗确认：取消不删，确认才调 deleteChat', async () => {
    const deleteChat = vi.fn(async () => true);
    renderSidebar('/agent', vi.fn(), { data: { deleteChat } });

    fireEvent.click(screen.getByTestId('sidebar-chat-delete'));
    expect(deleteChat).not.toHaveBeenCalled();
    expect(screen.getByTestId('sidebar-delete-chat-dialog').textContent).toContain(
      '已经聊过的对话',
    );

    fireEvent.click(screen.getByTestId('sidebar-delete-chat-dialog-cancel'));
    expect(deleteChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sidebar-delete-chat-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('sidebar-chat-delete'));
    fireEvent.click(screen.getByTestId('sidebar-delete-chat-dialog-confirm'));
    await waitFor(() => expect(deleteChat).toHaveBeenCalledWith('chat-with-content'));
  });

  it('删除当前会话后回到落地页', async () => {
    const deleteChat = vi.fn(async () => true);
    renderSidebar('/agent/chat-with-content', vi.fn(), { data: { deleteChat } });

    fireEvent.click(screen.getByTestId('sidebar-chat-delete'));
    fireEvent.click(screen.getByTestId('sidebar-delete-chat-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/agent'));
  });

  it('deleteChat 返回 false 时不导航且保留确认弹窗', async () => {
    const deleteChat = vi.fn(async () => false);
    renderSidebar('/agent/chat-with-content', vi.fn(), { data: { deleteChat } });

    fireEvent.click(screen.getByTestId('sidebar-chat-delete'));
    fireEvent.click(screen.getByTestId('sidebar-delete-chat-dialog-confirm'));
    await waitFor(() => expect(deleteChat).toHaveBeenCalled());
    expect(screen.getByTestId('loc').textContent).toBe('/agent/chat-with-content');
    expect(screen.getByTestId('sidebar-delete-chat-dialog')).toBeTruthy();
  });

  it('取消删除后点击会话行正常导航', () => {
    renderSidebar('/agent');
    fireEvent.click(screen.getByTestId('sidebar-chat-delete'));
    fireEvent.click(screen.getByTestId('sidebar-delete-chat-dialog-cancel'));

    fireEvent.click(screen.getByText('已经聊过的对话'));
    expect(screen.getByTestId('loc').textContent).toBe('/agent/chat-with-content');
    expect(screen.getByTestId('sidebar-chat-delete').getAttribute('aria-label')).toBe('Delete chat');
  });

  it('会话区（最近）可折叠再展开', () => {
    renderSidebar('/agent');
    fireEvent.click(screen.getByRole('button', { name: /^Recent$/ }));
    expect(screen.queryByTestId('sidebar-chat-row')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Recent$/ }));
    expect(screen.getByTestId('sidebar-chat-row')).toBeTruthy();
  });

  it('置顶、项目、最近的折叠在重新挂载后保持', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    const chats = [
      makeChat({ id: 'c-pinned', title: '置顶会话', isPinned: true }),
      existingChat,
      makeChat({ id: 'c-in', title: '项目内会话', projectId: 'proj-1' }),
    ];
    const { unmount } = renderSidebar('/agent', vi.fn(), { data: { chats } });
    await screen.findByText('项目甲');

    fireEvent.click(screen.getByRole('button', { name: /^Pinned$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Projects$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Recent$/ }));
    expect(screen.queryByText('置顶会话')).toBeNull();
    expect(screen.queryByText('项目甲')).toBeNull();
    expect(screen.queryByText('已经聊过的对话')).toBeNull();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_KEY) ?? '{}')).toEqual({
      pinned: false,
      projects: false,
      recents: false,
    });

    unmount();
    renderSidebar('/agent', vi.fn(), { data: { chats } });
    expect(screen.getByRole('button', { name: /^Pinned$/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: /^Projects$/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: /^Recent$/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByText('置顶会话')).toBeNull();
    expect(screen.queryByText('已经聊过的对话')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Pinned$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Projects$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Recent$/ }));
    expect(screen.getByText('置顶会话')).toBeTruthy();
    await screen.findByText('项目甲');
    expect(screen.getByText('已经聊过的对话')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_KEY) ?? '{}')).toEqual({
      pinned: true,
      projects: true,
      recents: true,
    });
  });

  it('折叠记录损坏时按默认展开', () => {
    localStorage.setItem(SIDEBAR_SECTIONS_KEY, '{');
    renderSidebar('/agent');
    expect(screen.getByText('已经聊过的对话')).toBeTruthy();
  });

  it('置顶区可折叠再展开', () => {
    const pinnedChat = makeChat({ id: 'c-pinned', title: '置顶会话', isPinned: true });
    renderSidebar('/agent', vi.fn(), { data: { chats: [pinnedChat] } });
    expect(screen.getByTestId('sidebar-chat-row')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Pinned$/ }));
    expect(screen.queryByTestId('sidebar-chat-row')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Pinned$/ }));
    expect(screen.getByTestId('sidebar-chat-row')).toBeTruthy();
  });

  it('点击置顶按钮切换会话置顶状态并刷新列表', async () => {
    setChatPinned.mockResolvedValue({ success: true, isPinned: true });
    const { data } = renderSidebar('/agent', vi.fn(), {
      data: { chats: [existingChat] },
    });

    const pinBtn = screen.getByTestId('sidebar-chat-pin');
    expect(pinBtn.getAttribute('aria-label')).toBe('Pin chat');

    fireEvent.click(pinBtn);
    await waitFor(() =>
      expect(setChatPinned).toHaveBeenCalledWith('chat-with-content', true),
    );
    await waitFor(() => expect(data.refreshChats).toHaveBeenCalled());
  });

  it('已置顶会话显示取消置顶按钮，点击调用取消置顶', async () => {
    setChatPinned.mockResolvedValue({ success: true, isPinned: false });
    const pinnedChat = makeChat({
      id: 'chat-pinned',
      title: '已置顶会话',
      isPinned: true,
    });
    const { data } = renderSidebar('/agent', vi.fn(), {
      data: { chats: [pinnedChat] },
    });

    const pinBtn = screen.getByTestId('sidebar-chat-pin');
    expect(pinBtn.getAttribute('aria-label')).toBe('Unpin');

    fireEvent.click(pinBtn);
    await waitFor(() =>
      expect(setChatPinned).toHaveBeenCalledWith('chat-pinned', false),
    );
    await waitFor(() => expect(data.refreshChats).toHaveBeenCalled());
  });

  it('会话正在对话中时渲染正在生成图标指示器', () => {
    const streamingChat = makeChat({
      id: 'c-streaming',
      title: '正在流式的对话',
      isStreaming: true,
    });
    renderSidebar('/agent', vi.fn(), { data: { chats: [streamingChat] } });

    expect(screen.getByLabelText('Generating')).toBeTruthy();
  });

  it('切到别的会话后，后台仍在生成的会话保留正在生成指示，结束后摘掉', async () => {
    enterElectron([]);
    getChatLiveStream.mockResolvedValue({ active: true });
    const background = makeChat({ id: 'c-bg', title: '做一个自我介绍' });
    renderSidebar('/agent/c-other', vi.fn(), { data: { chats: [background] } });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('chat:streaming-change', {
          detail: { chatId: 'c-bg', isStreaming: true },
        }),
      );
    });
    expect(screen.getByLabelText('Generating')).toBeTruthy();

    await waitFor(() => expect(getChatLiveStream).toHaveBeenCalledWith('c-bg'));
    expect(screen.getByLabelText('Generating')).toBeTruthy();

    getChatLiveStream.mockResolvedValue({ active: false });
    await waitFor(() => expect(screen.queryByLabelText('Generating')).toBeNull(), {
      timeout: 2500,
    });
  });

  it('后台会话的快照还没注册时，不立刻摘掉正在生成指示', async () => {
    enterElectron([]);
    getChatLiveStream.mockResolvedValue({ active: false });
    const background = makeChat({ id: 'c-bg', title: '刚发送' });
    renderSidebar('/agent/c-other', vi.fn(), { data: { chats: [background] } });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('chat:streaming-change', {
          detail: { chatId: 'c-bg', isStreaming: true },
        }),
      );
    });

    await waitFor(() => expect(getChatLiveStream).toHaveBeenCalledWith('c-bg'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByLabelText('Generating')).toBeTruthy();
  });

  it('当前打开的会话不因 live-stream 暂时 inactive 丢掉正在生成指示', async () => {
    enterElectron([]);
    getChatLiveStream.mockResolvedValue({ active: false });
    const current = makeChat({ id: 'c-current', title: '当前会话' });
    renderSidebar('/agent/c-current', vi.fn(), { data: { chats: [current] } });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('chat:streaming-change', {
          detail: { chatId: 'c-current', isStreaming: true },
        }),
      );
    });
    expect(screen.getByLabelText('Generating')).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(getChatLiveStream).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Generating')).toBeTruthy();
  });

  it('会话有问题需要用户输入时渲染待输入指示器', () => {
    const inputChat = makeChat({
      id: 'c-needs-input',
      title: '等待回复的对话',
      needsUserInput: true,
    });
    renderSidebar('/agent', vi.fn(), { data: { chats: [inputChat] } });

    expect(screen.getByLabelText('Waiting for user input')).toBeTruthy();
  });
});

describe('AgentSidebar 入口导航与高亮', () => {
  it('设置按钮右侧显示当前版本，侧栏没有检查更新', async () => {
    bridgeStub = baseHostBridge({
      app: {
        snapshot: async () => ({ version: '0.2.2', enabled: true, phase: 'idle' }),
        check: vi.fn(),
        install: vi.fn(),
        onState: () => () => {},
      },
    });
    renderSidebar('/agent');
    const version = await screen.findByTestId('sidebar-app-version');
    expect(version.textContent).toBe('v0.2.2');
    expect(screen.getByTestId('sidebar-llm-settings').contains(version)).toBe(true);
    expect(screen.queryByTestId('sidebar-app-update')).toBeNull();
    expect(screen.queryByTestId('settings-app-update')).toBeNull();
  });

  it('插件入口打开插件页，综合设置仍走 /settings', () => {
    renderSidebar('/agent');
    fireEvent.click(screen.getByTestId('sidebar-plugins'));
    expect(screen.getByTestId('loc').textContent).toBe('/settings?section=plugins');
    fireEvent.click(screen.getByTestId('sidebar-llm-settings'));
    expect(screen.getByTestId('loc').textContent).toBe('/settings');
  });

  it('插件页和旧深链都只高亮插件入口', () => {
    renderSidebar('/settings?section=plugins&tab=skills');
    expect(screen.getByTestId('sidebar-plugins').className).toContain('bg-agent-foreground/10');
    expect(screen.getByTestId('sidebar-llm-settings').className).not.toContain(
      'bg-agent-foreground/10',
    );
    cleanup();
    renderSidebar('/settings?section=skills');
    expect(screen.getByTestId('sidebar-plugins').className).toContain('bg-agent-foreground/10');
    expect(screen.getByTestId('sidebar-llm-settings').className).not.toContain(
      'bg-agent-foreground/10',
    );
  });

  it('/settings 无 section 时高亮底部综合设置', () => {
    renderSidebar('/settings');
    expect(screen.getByTestId('sidebar-llm-settings').className).toContain('bg-agent-foreground/10');
    expect(screen.getByTestId('sidebar-plugins').className).not.toContain(
      'bg-agent-foreground/10',
    );
  });

  it('当前会话行高亮，其余行不高亮', () => {
    const other = makeChat({ id: 'c-other', title: '另一条会话' });
    renderSidebar('/agent/chat-with-content', vi.fn(), {
      data: { chats: [existingChat, other] },
    });
    expect(chatRow('chat-with-content').querySelector('button')!.className).toContain(
      'bg-agent-foreground/10',
    );
    expect(chatRow('c-other').querySelector('button')!.className).not.toContain(
      'bg-agent-foreground/10',
    );
  });

  it('收起按钮回调 onCollapse', () => {
    const onCollapse = vi.fn();
    renderSidebar('/agent', vi.fn(), { onCollapse });
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe('AgentSidebar 右侧面板切换', () => {
  it('终端与包槽位入口均移至聊天标题栏，侧栏不再渲染终端按钮', () => {
    renderSidebar('/agent', vi.fn(), { rightPanel: 'terminal' });
    expect(screen.queryByTestId('sidebar-terminal')).toBeNull();
    expect(screen.queryByTestId('sidebar-slot-preview')).toBeNull();
  });
});

describe('AgentSidebar 副作用', () => {
  it('进入会话路由时把 selectedAgentId 同步为该会话绑定的智能体', () => {
    const setSelectedAgentId = vi.fn();
    renderSidebar('/agent/chat-with-content', vi.fn(), { data: { setSelectedAgentId } });
    expect(setSelectedAgentId).toHaveBeenCalledWith('local-assistant');
  });

  it('落地页没有当前会话，不同步 selectedAgentId', () => {
    const setSelectedAgentId = vi.fn();
    renderSidebar('/agent', vi.fn(), { data: { setSelectedAgentId } });
    expect(setSelectedAgentId).not.toHaveBeenCalled();
  });

  it('订阅菜单新建对话事件：回调导航落地页，卸载时退订', () => {
    let menuCb: (() => void) | null = null;
    const offMenuNewChat = vi.fn();
    bridgeStub = baseHostBridge({
      onMenuNewChat: (cb) => {
        menuCb = cb;
      },
      offMenuNewChat,
    });
    const { unmount } = renderSidebar('/agent/chat-with-content');

    expect(menuCb).not.toBeNull();
    act(() => {
      menuCb!();
    });
    expect(screen.getByTestId('loc').textContent).toBe('/agent');

    unmount();
    // 导航后 useNavigate 返回值的 identity 会变，handleOpenNewChat 随之变化
    // 导致订阅 effect 重跑（先退订再订阅），所以这里不断言精确次数——
    // 精确退订契约由下一个用例锁定。
    expect(offMenuNewChat).toHaveBeenCalled();
  });

  it('未触发导航直接卸载时，菜单订阅恰好退订一次', () => {
    const offMenuNewChat = vi.fn();
    bridgeStub = baseHostBridge({
      onMenuNewChat: () => {},
      offMenuNewChat,
    });
    const { unmount } = renderSidebar('/agent');

    unmount();
    expect(offMenuNewChat).toHaveBeenCalledTimes(1);
  });

  it('滚动容器接近底部时自动加载下一页（测试环境零高度即触底）', async () => {
    const loadMoreChats = vi.fn(async () => {});
    renderSidebar('/agent', vi.fn(), { data: { hasMoreChats: true, loadMoreChats } });
    await waitFor(() => expect(loadMoreChats).toHaveBeenCalled());
  });

  it('没有更多会话时不触发加载', async () => {
    const loadMoreChats = vi.fn(async () => {});
    renderSidebar('/agent', vi.fn(), { data: { hasMoreChats: false, loadMoreChats } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(loadMoreChats).not.toHaveBeenCalled();
  });

  it('正在加载更多时不重复触发', async () => {
    const loadMoreChats = vi.fn(async () => {});
    renderSidebar('/agent', vi.fn(), {
      data: { hasMoreChats: true, isLoadingMoreChats: true, loadMoreChats },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(loadMoreChats).not.toHaveBeenCalled();
  });
});

describe('AgentSidebar 项目模式（Electron）', () => {
  it('项目分组主动加载后续页，避免较旧会话被误报为空', async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    const clientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1_000,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 100,
    });

    try {
      enterElectron([makeProject({ id: 'proj-old', name: '旧项目' })]);
      const loadMoreChats = vi.fn(async () => {});
      renderSidebar('/agent', vi.fn(), {
        data: { hasMoreChats: true, loadMoreChats },
      });

      await screen.findByText('旧项目');
      await waitFor(() => expect(loadMoreChats).toHaveBeenCalled());
    } finally {
      Object.defineProperty(
        HTMLElement.prototype,
        'scrollHeight',
        scrollHeight ?? { configurable: true, get: () => 0 },
      );
      Object.defineProperty(
        HTMLElement.prototype,
        'clientHeight',
        clientHeight ?? { configurable: true, get: () => 0 },
      );
    }
  });

  it('项目分组渲染在前，孤儿会话回落到无项目日期分组', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    const inProject = makeChat({ id: 'c-in', title: '项目内会话', projectId: 'proj-1' });
    const orphan = makeChat({
      id: 'c-orphan',
      title: '孤儿会话',
      projectId: 'proj-gone',
      updatedAt: daysAgo(0),
    });
    renderSidebar('/agent', vi.fn(), { data: { chats: [inProject, orphan] } });

    await screen.findByText('项目甲');
    expect(screen.queryByText('· 1')).toBeNull();
    expect(chatRow('c-in')).toBeTruthy();
    // 孤儿会话按无项目处理，进入日期分组。
    expect(chatRow('c-orphan')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
  });

  it('项目内超过 5 条先收起，每次再展开 5 条，收起项目后回到最初 5 条', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    const chats = Array.from({ length: 12 }, (_, index) =>
      makeChat({
        id: `c-${index + 1}`,
        title: `会话 ${index + 1}`,
        projectId: 'proj-1',
        updatedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 12 - index)).toISOString(),
      }),
    );
    renderSidebar('/agent', vi.fn(), { data: { chats } });

    await screen.findByText('项目甲');
    for (let index = 1; index <= 5; index += 1) {
      expect(screen.getByText(`会话 ${index}`)).toBeTruthy();
    }
    expect(screen.queryByText('会话 6')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 7 more' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show 7 more' }));
    expect(screen.getByText('会话 10')).toBeTruthy();
    expect(screen.queryByText('会话 11')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getByText('会话 12')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('会话 6')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 7 more' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show 7 more' }));
    fireEvent.click(screen.getByText('项目甲').closest('button')!);
    fireEvent.click(screen.getByText('项目甲').closest('button')!);
    expect(screen.queryByText('会话 6')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 7 more' })).toBeTruthy();
  });

  it('正好 5 条不显示更多；进行中的会话和当前会话不占这 5 条名额', async () => {
    enterElectron([
      makeProject({ id: 'proj-1', name: '项目甲' }),
      makeProject({ id: 'proj-2', name: '项目乙' }),
      makeProject({ id: 'proj-3', name: '项目丙' }),
    ]);
    const streamingTail = Array.from({ length: 7 }, (_, index) =>
      makeChat({
        id: `c-${index + 1}`,
        title: `甲 ${index + 1}`,
        projectId: 'proj-1',
        updatedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 7 - index)).toISOString(),
        isStreaming: index === 6,
      }),
    );
    const currentTail = Array.from({ length: 7 }, (_, index) =>
      makeChat({
        id: `b-${index + 1}`,
        title: `乙 ${index + 1}`,
        projectId: 'proj-2',
        updatedAt: new Date(Date.UTC(2026, 0, 2, 12, 0, 7 - index)).toISOString(),
      }),
    );
    const exactFive = Array.from({ length: 5 }, (_, index) =>
      makeChat({
        id: `fit-${index + 1}`,
        title: `丙 ${index + 1}`,
        projectId: 'proj-3',
        updatedAt: new Date(Date.UTC(2026, 0, 3, 12, 0, 5 - index)).toISOString(),
      }),
    );
    renderSidebar('/agent/b-7', vi.fn(), {
      data: { chats: [...streamingTail, ...currentTail, ...exactFive] },
    });

    await screen.findByText('项目甲');
    expect(screen.getByText('甲 7')).toBeTruthy();
    expect(screen.queryByText('甲 6')).toBeNull();
    expect(screen.getByText('甲 5')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Show 1 more' })).toHaveLength(2);

    expect(screen.getByText('乙 7')).toBeTruthy();
    expect(screen.queryByText('乙 6')).toBeNull();
    expect(screen.getByText('乙 5')).toBeTruthy();

    for (let index = 1; index <= 5; index += 1) {
      expect(screen.getByText(`丙 ${index}`)).toBeTruthy();
    }
    expect(
      document.querySelector('[data-testid="sidebar-project-show-more"][data-project-id="proj-3"]'),
    ).toBeNull();
  });

  it('项目组头可折叠再展开', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    renderSidebar('/agent', vi.fn(), {
      data: { chats: [makeChat({ id: 'c-in', title: '项目内会话', projectId: 'proj-1' })] },
    });

    await screen.findByText('项目甲');
    fireEvent.click(screen.getByText('项目甲').closest('button')!);
    expect(screen.queryByText('项目内会话')).toBeNull();

    fireEvent.click(screen.getByText('项目甲').closest('button')!);
    expect(screen.getByText('项目内会话')).toBeTruthy();
  });

  it('项目组头的 + 导航到带 projectId 的落地页', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    renderSidebar('/agent');

    await screen.findByText('项目甲');
    fireEvent.click(screen.getByTitle('New chat in this project'));
    expect(screen.getByTestId('loc').textContent).toBe('/agent?projectId=proj-1');
  });

  it('项目组头 hover 只有新建对话和菜单，管理动作在菜单里', async () => {
    setPlatform('MacIntel');
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    renderSidebar('/agent');

    await screen.findByText('项目甲');
    expect(screen.getByTitle('New chat in this project')).toBeTruthy();
    expect(screen.getByLabelText('Project menu')).toBeTruthy();
    expect(screen.queryByTitle('Rename project')).toBeNull();
    expect(screen.queryByTitle('Edit project')).toBeNull();

    openProjectMenu();
    expect(screen.getByText('Chats: 0')).toBeTruthy();
    expect(screen.getByTitle('Rename project')).toBeTruthy();
    expect(screen.getByTitle('Edit project')).toBeTruthy();
    expect(screen.getByTitle('Show in Finder')).toBeTruthy();
    expect(screen.getByTitle('Delete project (its chats stay as chats without a project)')).toBeTruthy();
  });

  it('项目菜单：在访达中显示会打开项目文件夹', async () => {
    setPlatform('MacIntel');
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲', folderPath: '/tmp/proj-a' })]);
    renderSidebar('/agent');

    await screen.findByText('项目甲');
    openProjectMenu();
    fireEvent.click(screen.getByTitle('Show in Finder'));
    await waitFor(() => expect(openLocalPath).toHaveBeenCalledWith('/tmp/proj-a'));
  });

  it('新建项目：打开弹窗填名称后创建并刷新列表', async () => {
    enterElectron([]);
    createProject.mockResolvedValue({ success: true, project: makeProject() });
    renderSidebar('/agent');

    fireEvent.click(screen.getByLabelText('New project'));
    expect(screen.getByTestId('create-project-dialog')).toBeTruthy();
    fireEvent.change(screen.getByTestId('create-project-name'), { target: { value: '演示项目' } });
    fireEvent.click(screen.getByTestId('create-project-submit'));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: '演示项目' }));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
  });

  it('新建项目：取消弹窗则不建项目', async () => {
    enterElectron([]);
    renderSidebar('/agent');

    fireEvent.click(screen.getByLabelText('New project'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('create-project-dialog')).toBeNull();
    expect(createProject).not.toHaveBeenCalled();
  });

  it('内联重命名：提交新名后调 updateProject 并刷新', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    updateProject.mockResolvedValue({ success: true, project: makeProject() });
    renderSidebar('/agent');

    await screen.findByText('项目甲');
    openProjectMenu();
    fireEvent.click(screen.getByTitle('Rename project'));
    const input = screen.getByDisplayValue('项目甲');
    fireEvent.change(input, { target: { value: '项目甲改' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(updateProject).toHaveBeenCalledWith('proj-1', { name: '项目甲改' }));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
  });

  it('内联重命名：Escape 取消，不调 updateProject', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    renderSidebar('/agent');

    await screen.findByText('项目甲');
    openProjectMenu();
    fireEvent.click(screen.getByTitle('Rename project'));
    const input = screen.getByDisplayValue('项目甲');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByDisplayValue('项目甲')).toBeNull();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('内联重命名：空白名直接丢弃，不调 updateProject', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    renderSidebar('/agent');

    await screen.findByText('项目甲');
    openProjectMenu();
    fireEvent.click(screen.getByTitle('Rename project'));
    const input = screen.getByDisplayValue('项目甲');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);

    expect(screen.queryByDisplayValue('项目甲')).toBeNull();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('编辑项目：保存名称与多个源文件夹', async () => {
    enterElectron([
      makeProject({ id: 'proj-1', name: '项目甲', sourceFolders: ['/tmp/old'] }),
    ]);
    updateProject.mockResolvedValue({ success: true, project: makeProject() });
    renderSidebar('/agent');

    await screen.findByText('项目甲');
    openProjectMenu();
    fireEvent.click(screen.getByTitle('Edit project'));
    expect(screen.getByTestId('edit-project-dialog')).toBeTruthy();
    expect(screen.getByText('/tmp/old')).toBeTruthy();

    fireEvent.change(screen.getByTestId('edit-project-folder-path'), {
      target: { value: '/tmp/new' },
    });
    fireEvent.click(screen.getByTestId('edit-project-add-folder'));
    fireEvent.change(screen.getByTestId('edit-project-name'), { target: { value: '项目甲改' } });
    fireEvent.click(screen.getByTestId('edit-project-submit'));

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith('proj-1', {
        name: '项目甲改',
        sourceFolders: ['/tmp/old', '/tmp/new'],
      }),
    );
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
  });

  it('删除项目需弹窗确认：确认后删除并刷新会话列表', async () => {
    enterElectron([makeProject({ id: 'proj-1', name: '项目甲' })]);
    deleteProject.mockResolvedValue({ success: true, detachedChats: 2 });
    const { data } = renderSidebar('/agent');

    await screen.findByText('项目甲');
    openProjectMenu();
    fireEvent.click(screen.getByTitle('Delete project (its chats stay as chats without a project)'));
    expect(deleteProject).not.toHaveBeenCalled();
    expect(screen.queryByTestId('project-overflow-menu')).toBeNull();
    expect(screen.getByTestId('sidebar-delete-project-dialog').textContent).toContain('项目甲');

    fireEvent.click(screen.getByTestId('sidebar-delete-project-dialog-cancel'));
    expect(deleteProject).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sidebar-delete-project-dialog')).toBeNull();

    openProjectMenu();
    fireEvent.click(screen.getByTitle('Delete project (its chats stay as chats without a project)'));
    fireEvent.click(screen.getByTestId('sidebar-delete-project-dialog-confirm'));
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('proj-1'));
    await waitFor(() => expect(data.refreshChats).toHaveBeenCalled());
  });

  it('拖拽项目组头到另一项目上半段时按新顺序保存', async () => {
    const first = makeProject({ id: 'proj-1', name: '项目甲' });
    const second = makeProject({ id: 'proj-2', name: '项目乙' });
    enterElectron([first, second]);
    reorderProjects.mockImplementation(async (ids: string[]) => ({
      success: true,
      projects: ids.map((id) => (id === first.id ? first : second)),
    }));
    renderSidebar('/agent');

    await screen.findByText('项目乙');
    expect(projectIds()).toEqual(['proj-1', 'proj-2']);

    const restoreRects = installProjectRects({
      'proj-1': { top: 0, height: 80 },
      'proj-2': { top: 100, height: 80 },
    });
    try {
      const target = projectBlock('proj-1');
      fireEvent.dragStart(projectHandle('proj-2'));
      dispatchProjectPointer(target, 'dragover', 10);
      expect(screen.getByTestId('sidebar-project-drop-indicator')).toBeTruthy();
      dispatchProjectPointer(target, 'drop', 10);
    } finally {
      restoreRects();
    }

    await waitFor(() => expect(reorderProjects).toHaveBeenCalledWith(['proj-2', 'proj-1']));
    expect(projectIds()).toEqual(['proj-2', 'proj-1']);
  });

  it('落点没有改变顺序时不请求保存', async () => {
    enterElectron([
      makeProject({ id: 'proj-1', name: '项目甲' }),
      makeProject({ id: 'proj-2', name: '项目乙' }),
    ]);
    renderSidebar('/agent');
    await screen.findByText('项目乙');

    const restoreRects = installProjectRects({
      'proj-1': { top: 0, height: 80 },
      'proj-2': { top: 100, height: 80 },
    });
    try {
      fireEvent.dragStart(projectHandle('proj-1'));
      dispatchProjectPointer(projectBlock('proj-2'), 'drop', 110);
      fireEvent.dragEnd(projectHandle('proj-1'));
    } finally {
      restoreRects();
    }

    expect(reorderProjects).not.toHaveBeenCalled();
    expect(projectIds()).toEqual(['proj-1', 'proj-2']);
  });

  it('排序保存失败时列表回到原来的顺序并显示错误', async () => {
    enterElectron([
      makeProject({ id: 'proj-1', name: '项目甲' }),
      makeProject({ id: 'proj-2', name: '项目乙' }),
    ]);
    reorderProjects.mockRejectedValue(new Error('排序失败'));
    renderSidebar('/agent');
    await screen.findByText('项目乙');

    const restoreRects = installProjectRects({
      'proj-1': { top: 0, height: 80 },
      'proj-2': { top: 100, height: 80 },
    });
    try {
      fireEvent.dragStart(projectHandle('proj-2'));
      dispatchProjectPointer(projectBlock('proj-1'), 'drop', 10);
    } finally {
      restoreRects();
    }

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('排序失败'));
    expect(projectIds()).toEqual(['proj-1', 'proj-2']);
  });

  it('项目列表拉取失败时错误进 alert 横幅', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    listProjects.mockReset();
    listProjects.mockRejectedValue(new Error('存储读取失败'));
    bridgeStub = baseHostBridge();
    renderSidebar('/agent');

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('存储读取失败'));
    consoleSpy.mockRestore();
  });
});
