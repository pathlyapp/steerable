/**
 * ChatHeader 右侧三个入口：菜单（对话操作）、summary（项目、产出、后台任务）、tab（右侧栏位）。
 * 后台任务角标在资源按钮关着的时候看得见：
 *   - 无任务 → 资源按钮不显示计数，资源列表里也没有任务段；
 *   - 有任务 → 资源按钮带计数，状态按「该不该现在看一眼」取最高优先级
 *     （运行中 > 待合并 > 失败 > 全部跑完）；
 *   - 点任务名 → 在右侧打开该任务的推理过程，不经居中弹层；
 *   - 待合并的 worktree 行上直接给出合并/丢弃。
 * 列表本身的订阅与刷新归 useChatTasks，见 chat/useChatTasks.test.ts。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalChat, LocalProject, LocalTask } from '@/lib/local-api';
import type { TurnFile } from './chat/turn-files';
import { ChatHeader } from './ChatHeader';
import type { PackChatSlotContribution } from '@/packs/registry';

afterEach(() => {
  cleanup();
  delete (window as { steerableHost?: unknown }).steerableHost;
});

const CHAT: LocalChat = {
  id: 'chat_1',
  projectId: null,
  userId: 'u1',
  title: '循环任务',
  agentId: null,
  createdAt: '2026-09-13T01:00:00.000Z',
  updatedAt: '2026-09-13T01:00:00.000Z',
  isPinned: false,
  systemPrompt: null,
  pinnedRefs: null,
};

function makeTask(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    id: 'task-1',
    chatId: 'chat_1',
    task: '每 5 分钟问好',
    status: 'completed',
    answer: '你好',
    error: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeState: null,
    createdAt: '2026-09-13T01:00:00.000Z',
    updatedAt: '2026-09-13T01:01:00.000Z',
    ...overrides,
  };
}

function resourcesButton() {
  return screen.getByTestId('header-chat-summary');
}

function openResources() {
  fireEvent.click(resourcesButton());
}

function taskItem(name: string) {
  return screen.getByRole('button', { name });
}

function openPanels() {
  fireEvent.click(screen.getByTestId('header-chat-panels'));
}

describe('ChatHeader 后台任务角标', () => {
  it('没有任务时不显示计数', () => {
    render(<ChatHeader chat={CHAT} tasks={[]} />);

    expect(resourcesButton().getAttribute('data-task-state')).toBeNull();
    expect(resourcesButton().textContent).toBe('');
    openResources();
    expect(screen.queryByText('Background tasks')).toBeNull();
  });

  it('有运行中的任务时显示运行中计数并标成 running', () => {
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[
          makeTask({ id: 'a', status: 'running' }),
          makeTask({ id: 'b', status: 'running' }),
          makeTask({ id: 'c', status: 'completed' }),
        ]}
      />,
    );

    expect(resourcesButton().getAttribute('data-task-state')).toBe('running');
    expect(resourcesButton().textContent).toBe('2');
    expect(resourcesButton().getAttribute('title')).toBe('Background tasks: 3 (2 in progress)');
  });

  it('等依赖的任务也算在推进中', () => {
    render(
      <ChatHeader chat={CHAT} tasks={[makeTask({ id: 'a', status: 'blocked' })]} />,
    );

    expect(resourcesButton().getAttribute('data-task-state')).toBe('running');
    expect(resourcesButton().getAttribute('title')).toBe('Background tasks: 1 (1 waiting on dependencies)');
  });

  it('待合并的 worktree 任务优先于失败任务上色', () => {
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[
          makeTask({ id: 'a', status: 'completed', worktreeState: 'pending' }),
          makeTask({ id: 'b', status: 'failed', error: '炸了' }),
        ]}
      />,
    );

    expect(resourcesButton().getAttribute('data-task-state')).toBe('review');
    expect(resourcesButton().textContent).toBe('1');
    expect(resourcesButton().getAttribute('title')).toBe('Background tasks: 2 (1 awaiting merge, 1 failed)');
  });

  it('只有失败任务时标成 failed', () => {
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[makeTask({ id: 'a', status: 'failed', error: '炸了' })]}
      />,
    );

    expect(resourcesButton().getAttribute('data-task-state')).toBe('failed');
  });

  it('全部跑完时显示总数，不再抢注意力', () => {
    render(
      <ChatHeader chat={CHAT} tasks={[makeTask({ id: 'a' }), makeTask({ id: 'b' })]} />,
    );

    expect(resourcesButton().getAttribute('data-task-state')).toBe('idle');
    expect(resourcesButton().textContent).toBe('2');
  });
});

describe('ChatHeader 资源里的后台任务', () => {
  it('点任务名在右侧打开推理过程，不经居中弹层', () => {
    const onInspectTask = vi.fn();
    render(
      <ChatHeader
        chat={CHAT}
        onInspectTask={onInspectTask}
        tasks={[makeTask({ id: 'a', status: 'failed', task: '跑测试', error: '炸了' })]}
      />,
    );

    openResources();
    fireEvent.click(taskItem('跑测试'));

    expect(onInspectTask).toHaveBeenCalledWith({
      id: 'a',
      chatId: 'chat_1',
      title: '跑测试',
    });
    expect(document.querySelector('[data-task-panel-modal]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Background tasks' })).toBeNull();
  });

  it('运行中的任务带上 live，好让右侧继续跟过程', () => {
    const onInspectTask = vi.fn();
    render(
      <ChatHeader
        chat={CHAT}
        onInspectTask={onInspectTask}
        tasks={[makeTask({ id: 'b', status: 'running', task: '正在跑' })]}
      />,
    );

    openResources();
    fireEvent.click(taskItem('正在跑'));

    expect(onInspectTask).toHaveBeenCalledWith({
      id: 'b',
      chatId: 'chat_1',
      title: '正在跑',
      live: true,
    });
  });

  it('待合并任务在资源行上直接给出合并和丢弃', () => {
    const task = makeTask({
      id: 'a',
      task: '改样式',
      status: 'completed',
      worktreeState: 'pending',
      worktreePath: '/tmp/wt',
      worktreeBranch: 'steerable/a',
    });
    render(<ChatHeader chat={CHAT} onInspectTask={vi.fn()} tasks={[task]} />);

    openResources();
    expect(document.querySelector('[data-task-merge]')).not.toBeNull();
    expect(document.querySelector('[data-task-discard]')).not.toBeNull();
    expect(document.querySelector('[data-task-panel-modal]')).toBeNull();
  });

  it('多件任务都列在资源里，点哪条就打开哪条', () => {
    const onInspectTask = vi.fn();
    render(
      <ChatHeader
        chat={CHAT}
        onInspectTask={onInspectTask}
        tasks={[
          makeTask({ id: 'a', status: 'failed', task: '跑测试', error: '炸了' }),
          makeTask({ id: 'b', status: 'failed', task: '再跑一次', error: '也炸了' }),
        ]}
      />,
    );

    openResources();
    fireEvent.click(taskItem('再跑一次'));

    expect(onInspectTask).toHaveBeenCalledWith({
      id: 'b',
      chatId: 'chat_1',
      title: '再跑一次',
    });
    expect(document.querySelector('[data-task-panel-modal]')).toBeNull();
  });
});

describe('ChatHeader 包槽位入口', () => {
  const slot: PackChatSlotContribution = {
    slotId: 'ppt',
    title: '文档预览',
    Icon: ({ className }: { className?: string }) => <svg className={className} />,
    Component: () => null,
  };

  it('入口在面板菜单里，打开时高亮，点击切换', () => {
    const onToggleChatSlot = vi.fn();
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[]}
        chatSlots={[slot]}
        rightPanel="ppt"
        onToggleChatSlot={onToggleChatSlot}
      />,
    );

    expect(screen.getByTestId('header-chat-panels').getAttribute('aria-pressed')).toBe('true');
    openPanels();
    const slotButton = screen.getByTestId('header-slot-ppt');
    expect(slotButton.textContent).toContain('文档预览');
    expect(slotButton.getAttribute('aria-pressed')).toBe('true');
    expect(slotButton.className).toContain('bg-agent-foreground/10');
    expect(document.querySelector('[data-header-popover="panels"]')).toContain(slotButton);

    fireEvent.click(slotButton);
    expect(onToggleChatSlot).toHaveBeenCalledWith('ppt');
  });

  it('已经打开的多个栏位同时高亮，当前这个才提示关闭', () => {
    const word: PackChatSlotContribution = {
      slotId: 'word',
      title: 'Word',
      Icon: ({ className }: { className?: string }) => <svg className={className} />,
      Component: () => null,
    };
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[]}
        chatSlots={[slot, word]}
        rightPanel="word"
        openPanelIds={['ppt', 'word']}
        onToggleChatSlot={vi.fn()}
      />,
    );
    openPanels();
    expect(screen.getByTestId('header-slot-ppt').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('header-slot-word').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('header-slot-ppt').getAttribute('title')).toBe('Open 文档预览');
    expect(screen.getByTestId('header-slot-word').getAttribute('title')).toBe('Close Word');
  });

  it('栏位关闭时不显示高亮', () => {
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[]}
        chatSlots={[slot]}
        rightPanel={null}
        onToggleChatSlot={vi.fn()}
      />,
    );
    openPanels();
    expect(screen.getByTestId('header-slot-ppt').getAttribute('aria-pressed')).toBe('false');
  });
});

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
}

describe('ChatHeader 终端入口', () => {
  it('Mac 上面板菜单里的终端项 title 提示 ⌘T，点击切换终端面板', () => {
    setPlatform('MacIntel');
    const onToggleRightPanel = vi.fn();
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[]}
        onToggleRightPanel={onToggleRightPanel}
      />,
    );

    openPanels();
    const btn = screen.getByTestId('header-terminal');
    expect(btn.textContent).toContain('Terminal');
    expect(btn.getAttribute('title')).toBe('Open terminal panel (⌘T)');
    expect(btn.getAttribute('aria-label')).toBe('Terminal');
    fireEvent.click(btn);
    expect(onToggleRightPanel).toHaveBeenCalledWith('terminal');
  });

  it('非 Mac title 提示 Ctrl+T；面板已打开时 title 变为关闭且高亮', () => {
    setPlatform('Linux');
    const onToggleChatSlot = vi.fn();
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[]}
        rightPanel="terminal"
        onToggleChatSlot={onToggleChatSlot}
      />,
    );

    expect(screen.getByTestId('header-chat-panels').className).toContain('bg-agent-foreground/10');
    openPanels();
    const btn = screen.getByTestId('header-terminal');
    expect(btn.getAttribute('title')).toBe('Close terminal panel (Ctrl+T)');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toContain('bg-agent-foreground/10');

    fireEvent.click(btn);
    expect(onToggleChatSlot).toHaveBeenCalledWith('terminal');
  });

  it('没有选择对话时不渲染终端按钮', () => {
    render(
      <ChatHeader
        chat={null}
        tasks={[]}
      />,
    );

    expect(screen.queryByTestId('header-terminal')).toBeNull();
    expect(screen.queryByTestId('header-chat-panels')).toBeNull();
  });
});

describe('ChatHeader summary', () => {
  const project: LocalProject = {
    id: 'proj-1',
    name: 'cloudide',
    folderPath: '/work/cloudide',
    createdAt: '2026-09-13T01:00:00.000Z',
    updatedAt: '2026-09-13T01:00:00.000Z',
  };
  const report: TurnFile = {
    path: '/work/cloudide/docs/report.md',
    kind: 'created',
    category: 'deliverable',
  };
  const scratch: TurnFile = {
    path: '/work/cloudide/tmp/notes.txt',
    kind: 'modified',
    category: 'intermediate',
  };

  it('列出关联目录和去重后的产出，交付物排在前面', () => {
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[]}
        showProject
        project={project}
        outputs={[scratch, report, report]}
      />,
    );

    fireEvent.click(screen.getByTestId('header-chat-summary'));
    const popover = document.querySelector('[data-header-popover="summary"]');
    expect(popover?.textContent).toContain('Linked directory');
    expect(popover?.querySelector('[data-linked-directory]')?.getAttribute('data-linked-directory')).toBe(
      '/work/cloudide',
    );
    const paths = [...(popover?.querySelectorAll('[data-output-path]') ?? [])].map((node) =>
      node.getAttribute('data-output-path'),
    );
    expect(paths).toEqual(['/work/cloudide/docs/report.md', '/work/cloudide/tmp/notes.txt']);
    expect(popover?.querySelector('[data-output-view-all]')).toBeNull();
  });

  it('产出超过三份时只先露出三份，查看全部再展开', () => {
    const extra = ['a.py', 'b.py', 'c.py'].map(
      (name): TurnFile => ({
        path: `/work/cloudide/${name}`,
        kind: 'created',
        category: 'intermediate',
      }),
    );
    render(
      <ChatHeader
        chat={CHAT}
        tasks={[]}
        showProject
        project={project}
        outputs={[scratch, report, ...extra]}
      />,
    );

    fireEvent.click(screen.getByTestId('header-chat-summary'));
    const listed = () =>
      [...document.querySelectorAll('[data-output-path]')].map((node) =>
        node.getAttribute('data-output-path'),
      );
    expect(listed()).toEqual([
      '/work/cloudide/docs/report.md',
      '/work/cloudide/a.py',
      '/work/cloudide/b.py',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'View all' }));
    expect(listed()).toEqual([
      '/work/cloudide/docs/report.md',
      '/work/cloudide/a.py',
      '/work/cloudide/b.py',
      '/work/cloudide/c.py',
      '/work/cloudide/tmp/notes.txt',
    ]);
  });

  it('没有项目、没有产出时给出空态', () => {
    render(<ChatHeader chat={CHAT} tasks={[]} showProject project={null} outputs={[]} />);

    fireEvent.click(screen.getByTestId('header-chat-summary'));
    const popover = document.querySelector('[data-header-popover="summary"]');
    expect(popover?.textContent).toContain('No directory linked');
    expect(popover?.textContent).toContain('No files from this chat yet');
  });
});
