import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  LuCheck,
  LuChevronLeft,
  LuDownload,
  LuEllipsis,
  LuFile,
  LuFolder,
  LuGitBranch,
  LuGitMerge,
  LuList,
  LuListTodo,
  LuListTree,
  LuLoaderCircle,
  LuPin,
  LuPinOff,
  LuShare2,
  LuTrash2,
} from 'react-icons/lu';
import type { LocalChat, LocalProject, LocalTask } from '@/lib/local-api';
import {
  activateChatBranch,
  discardTaskWorktree,
  getChatBranches,
  mergeTaskWorktree,
  openLocalPath,
  setChatPinned,
  type ChatBranchesResponse,
} from '@/lib/local-api';
import { SessionTreeModal } from './chat/SessionTreeModal';
import { summarizeTasks, type ChatTaskSummary } from './chat/useChatTasks';
import type { PackChatSlotContribution } from '@/packs/registry';
import {
  fetchChatDocument,
  isPortableEnabled,
  portableErrorMessage,
  safeDownloadName,
  saveJsonFile,
} from '@/lib/portable';
import { hostToolChrome } from '@/lib/host-tools';
import { PanelToggleButton } from '@/layouts/PanelToggleButton';
import { t } from '@/i18n';
import {
  getTurnFileCategory,
  isIgnoredTurnFile,
  splitTurnFilePath,
  type TurnFile,
} from './chat/turn-files';

interface ChatHeaderProps {
  chat: LocalChat | null;
  /**
   * W1.2.1: called after the active branch switches — the page re-hydrates
   * the message list from the re-projected store. When provided (and the
   * chat has branches), a branch picker appears in the chat menu.
   */
  onBranchSwitched?: () => void;
  /** 点击后台任务行：在右侧栏打开该任务的推理过程。 */
  onInspectTask?: (task: {
    id: string;
    chatId: string;
    title: string;
    live?: boolean;
  }) => void;
  /** 本对话的后台任务（AgentPage 的 `useChatTasks` 单一订阅源）。 */
  tasks?: LocalTask[];
  /** 包注册的聊天页槽位（如文档预览）。有槽位或终端时，标题栏才放右侧开关。 */
  chatSlots?: readonly PackChatSlotContribution[];
  /** 当前会话正在看的右侧标签（null = 都关着）。 */
  rightPanel?: string | null;
  /** 已经打开且正在显示的标签。缺省时只把 rightPanel 当作唯一打开项。 */
  openPanelIds?: readonly string[];
  /** 右侧整栏关着时，点标题栏开关把它打开。 */
  onOpenRightPanel?: () => void;
  /** 产品打开项目入口时，summary 展示当前对话关联的目录。 */
  showProject?: boolean;
  project?: LocalProject | null;
  /** 本对话各回合写过的文件。summary 按路径去重后列出。 */
  outputs?: readonly TurnFile[];
  /** 把对话截图写入剪贴板。缺省时菜单不显示分享。 */
  onShare?: () => Promise<boolean> | void;
  /** 置顶写完后刷新会话列表。 */
  onChatChanged?: () => void | Promise<void>;
}

type HeaderPopover = 'menu' | 'summary';

/**
 * ChatHeader — slim title bar above ChatPanel.
 * 右侧入口：
 *   - 菜单：操作当前对话（置顶、导出、分享、分支）
 *   - summary：当前对话的资源（关联目录、产出文件；有后台任务时也列在这里，点开后在右侧显示过程）
 *   - 面板开关：右侧整栏关着时出现在这里，点一下打开。栏开着时按钮挪到右侧标签条，点一下收起。
 *
 * 刷新按钮已下线（消息流有 SSE 自动同步）。
 */
export function ChatHeader({
  chat,
  onBranchSwitched,
  onInspectTask,
  tasks = [],
  chatSlots = [],
  rightPanel = null,
  openPanelIds,
  onOpenRightPanel,
  showProject = false,
  project = null,
  outputs = [],
  onShare,
  onChatChanged,
}: ChatHeaderProps) {
  const [popover, setPopover] = useState<HeaderPopover | null>(null);
  const [menuPage, setMenuPage] = useState<'root' | 'branches'>('root');
  const [treeModalOpen, setTreeModalOpen] = useState(false);
  const [branches, setBranches] = useState<ChatBranchesResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const summaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const showTerminalChrome = hostToolChrome('terminal');
  const allowOpenPath = hostToolChrome('local-fs');
  const openIds = openPanelIds ?? (rightPanel ? [rightPanel] : []);
  const canTogglePanel = chatSlots.length > 0 || showTerminalChrome;

  const branchCount = branches ? branches.lineage.length + branches.children.length : 0;
  const files = useMemo(() => uniqueOutputs(outputs), [outputs]);

  const taskSummary = useMemo(() => summarizeTasks(tasks), [tasks]);
  const taskBadge = describeTaskBadge(taskSummary);

  const closePopover = () => {
    setPopover(null);
    setMenuPage('root');
  };

  const togglePopover = (next: HeaderPopover) => {
    setMenuPage('root');
    setPopover((current) => (current === next ? null : next));
  };

  const openBranchPage = async () => {
    if (!chat) return;
    setMenuPage('branches');
    try {
      const data = await getChatBranches(chat.id);
      setBranches(data);
    } catch {
      setBranches(null);
    }
  };

  const switchBranch = async (recordId: string) => {
    if (!chat || !branches || switching || recordId === branches.activeRecordId) return;
    setSwitching(true);
    try {
      await activateChatBranch(chat.id, recordId);
      closePopover();
      onBranchSwitched?.();
    } catch {
      // 切换失败（分支族外记录 / sidecar 离线）——菜单保持打开，用户可重试。
    } finally {
      setSwitching(false);
    }
  };

  const exportChat = () => {
    if (!chat || exporting) return;
    setExporting(true);
    setExportError(null);
    void fetchChatDocument(chat.id)
      .then((doc) => saveJsonFile(safeDownloadName(chat.title, t('Chat')), doc))
      .then((saved) => {
        if (saved) closePopover();
      })
      .catch((err: unknown) => setExportError(portableErrorMessage(err)))
      .finally(() => setExporting(false));
  };

  const shareChat = () => {
    if (!onShare || sharing) return;
    setSharing(true);
    void Promise.resolve(onShare())
      .then((ok) => {
        if (ok !== false) closePopover();
      })
      .finally(() => setSharing(false));
  };

  const togglePin = () => {
    if (!chat || pinning) return;
    setPinning(true);
    void setChatPinned(chat.id, !chat.isPinned)
      .then(() => onChatChanged?.())
      .catch(() => {
        // 宿主不在或写入失败时保持菜单，方便再点一次。
      })
      .finally(() => setPinning(false));
  };

  const openListedTask = (task: LocalTask) => {
    onInspectTask?.({
      id: task.id,
      chatId: task.chatId,
      title: task.task,
      ...(task.status === 'running' || task.status === 'blocked' ? { live: true } : {}),
    });
    closePopover();
  };

  const openOutput = (filePath: string) => {
    if (!allowOpenPath || openingPath) return;
    setOpeningPath(filePath);
    void openLocalPath(filePath).finally(() => setOpeningPath(null));
  };

  const anchor =
    popover === 'menu'
      ? menuButtonRef.current
      : popover === 'summary'
        ? summaryButtonRef.current
        : null;

  useLayoutEffect(() => {
    if (!popover || !anchor) {
      setMenuBox(null);
      return;
    }
    const update = () => setMenuBox(placeHeaderPopover(anchor, sheetWidth(popover, menuPage)));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [popover, anchor, menuPage]);

  useEffect(() => {
    if (!popover) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuButtonRef.current?.contains(target) ||
        summaryButtonRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      closePopover();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [popover]);

  const popoverNode =
    popover && menuBox
      ? createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[80] max-h-[min(24rem,70vh)] overflow-y-auto rounded-lg border border-agent-border bg-agent-canvas p-1 shadow-lg"
            style={{ top: menuBox.top, left: menuBox.left, width: menuBox.width }}
            data-header-popover={popover}
          >
            {popover === 'menu' &&
              (menuPage === 'branches' ? (
                <BranchPage
                  branches={branches}
                  branchCount={branchCount}
                  switching={switching}
                  onBack={() => setMenuPage('root')}
                  onSelect={(recordId) => void switchBranch(recordId)}
                  onOpenTree={() => {
                    closePopover();
                    setTreeModalOpen(true);
                  }}
                />
              ) : (
                <ChatActionsMenu
                  pinned={Boolean(chat?.isPinned)}
                  pinning={pinning}
                  onTogglePin={togglePin}
                  showExport={Boolean(chat && isPortableEnabled())}
                  exporting={exporting}
                  exportError={exportError}
                  onExport={exportChat}
                  showShare={Boolean(onShare)}
                  sharing={sharing}
                  onShare={shareChat}
                  showBranches={Boolean(onBranchSwitched)}
                  onOpenBranches={() => void openBranchPage()}
                />
              ))}
            {popover === 'summary' && (
              <ChatSummary
                showProject={showProject}
                project={project}
                files={files}
                allowOpenPath={allowOpenPath}
                openingPath={openingPath}
                onOpen={openOutput}
                tasks={tasks}
                onOpenTask={openListedTask}
              />
            )}
          </div>,
          document.body,
        )
      : null;

  const iconButton =
    'flex h-7 shrink-0 items-center justify-center gap-1 rounded-full text-xs text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground';

  return (
    <header className="flex w-full min-w-0 items-center gap-2 bg-agent-canvas px-2.5 py-1.5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          className="break-words text-xs font-medium text-agent-foreground"
          title={chat?.title}
        >
          {chat?.title ?? t('No chat selected')}
        </span>
      </div>
      {chat && (
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => togglePopover('menu')}
          className={`${iconButton} w-7 ${
            popover === 'menu' ? 'bg-agent-foreground/10 text-agent-foreground' : ''
          }`}
          title={t('Chat menu')}
          aria-label={t('Chat menu')}
          aria-expanded={popover === 'menu'}
          data-testid="header-chat-menu"
        >
          <LuEllipsis className="h-4 w-4" />
        </button>
      )}
      {chat && (
        <button
          ref={summaryButtonRef}
          type="button"
          onClick={() => togglePopover('summary')}
          className={`${iconButton} ${taskBadge ? 'px-2' : 'w-7'} ${
            popover === 'summary' ? 'bg-agent-foreground/10 text-agent-foreground' : ''
          }`}
          title={taskBadge?.title ?? t('Chat resources')}
          aria-label={t('Chat resources')}
          aria-expanded={popover === 'summary'}
          data-testid="header-chat-summary"
          data-task-state={taskBadge?.state}
        >
          <LuList className="h-4 w-4" />
          {taskBadge && (
            <span className={`rounded-full px-1 text-xs ${taskBadge.className}`}>
              {taskBadge.count}
            </span>
          )}
        </button>
      )}
      {chat && canTogglePanel && openIds.length === 0 && (
        <PanelToggleButton pressed={false} onClick={() => onOpenRightPanel?.()} />
      )}
      {popoverNode}
      {chat && treeModalOpen && (
        <SessionTreeModal
          chatId={chat.id}
          onClose={() => setTreeModalOpen(false)}
          onBranchSwitched={onBranchSwitched}
        />
      )}
    </header>
  );
}

function ChatActionsMenu({
  pinned,
  pinning,
  onTogglePin,
  showExport,
  exporting,
  exportError,
  onExport,
  showShare,
  sharing,
  onShare,
  showBranches,
  onOpenBranches,
}: {
  pinned: boolean;
  pinning: boolean;
  onTogglePin: () => void;
  showExport: boolean;
  exporting: boolean;
  exportError: string | null;
  onExport: () => void;
  showShare: boolean;
  sharing: boolean;
  onShare: () => void;
  showBranches: boolean;
  onOpenBranches: () => void;
}) {
  return (
    <>
      <MenuRow
        icon={
          pinning ? (
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : pinned ? (
            <LuPinOff className="h-3.5 w-3.5" />
          ) : (
            <LuPin className="h-3.5 w-3.5" />
          )
        }
        label={pinned ? t('Unpin') : t('Pin chat')}
        disabled={pinning}
        onClick={onTogglePin}
        data-action="pin"
      />
      {showExport && (
        <MenuRow
          icon={
            exporting ? (
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LuDownload className="h-3.5 w-3.5" />
            )
          }
          label={exportError ? t('Export failed') : exporting ? t('Exporting') : t('Export')}
          disabled={exporting}
          title={exportError ?? t('Export this chat')}
          onClick={onExport}
          data-testid="header-export-chat"
        />
      )}
      {showShare && (
        <MenuRow
          icon={
            sharing ? (
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LuShare2 className="h-3.5 w-3.5" />
            )
          }
          label={t('Share chat screenshot')}
          disabled={sharing}
          onClick={onShare}
          data-action="share"
        />
      )}
      {showBranches && (
        <MenuRow
          icon={<LuGitBranch className="h-3.5 w-3.5" />}
          label={t('Chat branches')}
          title={t('Chat branches (forks created by regenerating)')}
          onClick={onOpenBranches}
          data-action="branches"
        />
      )}
    </>
  );
}

function BranchPage({
  branches,
  branchCount,
  switching,
  onBack,
  onSelect,
  onOpenTree,
}: {
  branches: ChatBranchesResponse | null;
  branchCount: number;
  switching: boolean;
  onBack: () => void;
  onSelect: (recordId: string) => void;
  onOpenTree: () => void;
}) {
  return (
    <>
      <MenuRow
        icon={<LuChevronLeft className="h-3.5 w-3.5" />}
        label={t('Chat branches')}
        onClick={onBack}
        data-action="branches-back"
      />
      <div className="mx-1 my-1 border-t border-agent-border" />
      {!branches || branchCount === 0 ? (
        <div className="px-2.5 py-1.5 text-xs text-agent-muted-foreground">
          {t('No branches yet. After you regenerate a reply, the old version stays here.')}
        </div>
      ) : (
        <>
          {branches.lineage.map((point) => (
            <BranchRow
              key={point.recordId}
              label={point.label}
              active={point.recordId === branches.activeRecordId}
              disabled={switching}
              onSelect={() => onSelect(point.recordId)}
            />
          ))}
          {branches.children.map((point) => (
            <BranchRow
              key={point.recordId}
              label={point.label}
              active={point.recordId === branches.activeRecordId}
              disabled={switching}
              onSelect={() => onSelect(point.recordId)}
            />
          ))}
          <div className="mt-1 border-t border-agent-border pt-1">
            <button
              type="button"
              onClick={onOpenTree}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1 text-left text-xs text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground"
              data-action="branch-tree"
            >
              <LuListTree className="h-3 w-3 shrink-0" />
              {t('View full branch tree')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function ChatSummary({
  showProject,
  project,
  files,
  allowOpenPath,
  openingPath,
  onOpen,
  tasks,
  onOpenTask,
}: {
  showProject: boolean;
  project: LocalProject | null;
  files: TurnFile[];
  allowOpenPath: boolean;
  openingPath: string | null;
  onOpen: (path: string) => void;
  tasks: readonly LocalTask[];
  onOpenTask: (task: LocalTask) => void;
}) {
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const [showAllOutputs, setShowAllOutputs] = useState(false);

  const runWorktreeAction = async (task: LocalTask, action: 'merge' | 'discard') => {
    if (actingId) return;
    setActingId(task.id);
    setActionError((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    try {
      if (action === 'merge') {
        await mergeTaskWorktree(task.id);
      } else {
        await discardTaskWorktree(task.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError((prev) => ({ ...prev, [task.id]: message }));
    } finally {
      setActingId(null);
    }
  };

  const directories = linkedDirectories(project);
  const visibleFiles = showAllOutputs ? files : files.slice(0, OUTPUT_PREVIEW_LIMIT);
  const hiddenOutputCount = files.length - visibleFiles.length;

  return (
    <div className="px-1 py-0.5">
      {showProject && (
        <section className="mb-1">
          <SectionLabel>{t('Linked directory')}</SectionLabel>
          {directories.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-agent-muted-foreground">{t('No directory linked')}</div>
          ) : (
            directories.map((dir) => (
              <button
                key={dir}
                type="button"
                disabled={!allowOpenPath || openingPath === dir}
                onClick={() => onOpen(dir)}
                title={dir}
                className="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5 disabled:cursor-default disabled:hover:bg-transparent"
                data-linked-directory={dir}
              >
                {openingPath === dir ? (
                  <LuLoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <LuFolder className="mt-0.5 h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 break-all font-mono text-[10px] leading-4">{dir}</span>
              </button>
            ))
          )}
        </section>
      )}
      {tasks.length > 0 && (
        <section className="mb-1">
          <SectionLabel>{t('Background tasks')}</SectionLabel>
          {tasks.map((task) => {
            const pending = task.worktreeState === 'pending' && task.status === 'completed';
            const acting = actingId === task.id;
            return (
              <div key={task.id} className="rounded" data-task-id={task.id}>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onOpenTask(task)}
                    title={task.task}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5"
                    data-action="tasks"
                  >
                    {task.status === 'running' || task.status === 'blocked' ? (
                      <LuLoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : (
                      <LuListTodo className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{task.task}</span>
                  </button>
                  {pending && (
                    <>
                      <button
                        type="button"
                        disabled={actingId !== null}
                        onClick={() => void runWorktreeAction(task, 'merge')}
                        className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400"
                        title={t('Merge into main repo')}
                        aria-label={t('Merge into main repo')}
                        data-task-merge
                      >
                        {acting ? (
                          <LuLoaderCircle className="h-3 w-3 animate-spin" />
                        ) : (
                          <LuGitMerge className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={actingId !== null}
                        onClick={() => void runWorktreeAction(task, 'discard')}
                        className="flex h-6 shrink-0 items-center rounded px-1.5 text-agent-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                        title={t('Discard')}
                        aria-label={t('Discard')}
                        data-task-discard
                      >
                        <LuTrash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
                {actionError[task.id] && (
                  <div className="px-2 pb-1 text-[10px] text-red-600 dark:text-red-400">
                    {actionError[task.id]}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
      <section>
        <SectionLabel>{t('Outputs')}</SectionLabel>
        {files.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-agent-muted-foreground">
            {t('No files from this chat yet')}
          </div>
        ) : (
          visibleFiles.map((file) => {
            const { name } = splitTurnFilePath(file.path);
            const deliverable = getTurnFileCategory(file) === 'deliverable';
            return (
              <button
                key={file.path}
                type="button"
                disabled={!allowOpenPath || openingPath === file.path}
                onClick={() => onOpen(file.path)}
                title={file.path}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5 disabled:cursor-default disabled:hover:bg-transparent"
                data-output-path={file.path}
              >
                {openingPath === file.path ? (
                  <LuLoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <LuFile className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {deliverable && (
                  <span className="shrink-0 text-[10px] text-agent-muted-foreground">{t('Output')}</span>
                )}
              </button>
            );
          })
        )}
        {hiddenOutputCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllOutputs(true)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground"
            data-output-view-all
          >
            {t('View all')}
          </button>
        )}
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-agent-muted-foreground/70">
      {children}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  detail,
  title,
  disabled,
  onClick,
  ...rest
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled' | 'title'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-agent-foreground transition-colors hover:bg-agent-foreground/5 disabled:opacity-60"
      {...rest}
    >
      <span className="text-agent-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="shrink-0 text-agent-muted-foreground">{detail}</span>}
    </button>
  );
}

/** 资源浮层里先露出的产出条数。其余用「查看全部」展开，不把回合文件一次摊开。 */
const OUTPUT_PREVIEW_LIMIT = 3;

function linkedDirectories(project: LocalProject | null): string[] {
  if (!project) return [];
  const dirs = [project.folderPath, ...(project.sourceFolders ?? [])];
  return [...new Set(dirs.filter((dir) => dir.length > 0))];
}

function uniqueOutputs(files: readonly TurnFile[]): TurnFile[] {
  const byPath = new Map<string, TurnFile>();
  for (const file of files) {
    if (isIgnoredTurnFile(file.path)) continue;
    byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => {
    const rank = (file: TurnFile) => (getTurnFileCategory(file) === 'deliverable' ? 0 : 1);
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    return splitTurnFilePath(a.path).name.localeCompare(splitTurnFilePath(b.path).name);
  });
}

interface TaskBadge {
  /** 驱动角标配色的那一类任务，也写进 `data-task-state` 供测试断言。 */
  state: 'running' | 'review' | 'failed' | 'idle';
  count: number;
  className: string;
  title: string;
}

/**
 * 资源按钮上的任务角标。只有一个状态能上色，按「用户该不该现在看一眼」排序：
 * 运行中（正在发生）> 待合并（等用户动手）> 失败（需要知道）> 全部跑完。
 * 计数跟着状态走——显示 3 个任务里那 1 个待合并的，比显示总数 3 更有用。
 */
function describeTaskBadge(summary: ChatTaskSummary): TaskBadge | null {
  if (summary.total === 0) return null;

  const detail = [
    summary.running > 0 ? t('{count} in progress', { count: summary.running }) : null,
    summary.blocked > 0 ? t('{count} waiting on dependencies', { count: summary.blocked }) : null,
    summary.needsReview > 0 ? t('{count} awaiting merge', { count: summary.needsReview }) : null,
    summary.failed > 0 ? t('{count} failed', { count: summary.failed }) : null,
  ]
    .filter((part) => part !== null)
    .join(t(', '));
  const title = detail
    ? t('Background tasks: {total} ({detail})', { total: summary.total, detail })
    : t('Background tasks: {total}', { total: summary.total });

  // 等依赖的任务也算在推进中：依赖跑完它会自动点火，用户不用做任何事。
  const active = summary.running + summary.blocked;
  if (active > 0) {
    return {
      state: 'running',
      count: active,
      className:
        'bg-sky-500/10 text-sky-600 hover:bg-sky-500/15 dark:bg-sky-500/20 dark:text-sky-400',
      title,
    };
  }
  if (summary.needsReview > 0) {
    return {
      state: 'review',
      count: summary.needsReview,
      className:
        'bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:bg-amber-500/20 dark:text-amber-400',
      title,
    };
  }
  if (summary.failed > 0) {
    return {
      state: 'failed',
      count: summary.failed,
      className:
        'bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:bg-red-500/20 dark:text-red-400',
      title,
    };
  }
  return {
    state: 'idle',
    count: summary.total,
    className: 'text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground',
    title,
  };
}

/** 浮层按内容给宽度，右缘对齐触发按钮，再夹进对话面板里。 */
function sheetWidth(kind: HeaderPopover, page: 'root' | 'branches'): number {
  if (kind === 'summary' || page === 'branches') return 304;
  return 176;
}

/** Pin the popover to the trigger, clamped inside the chat panel so
 *  `overflow-hidden` ancestors cannot clip the left side. */
function placeHeaderPopover(
  button: HTMLElement,
  preferredWidth: number,
): { top: number; left: number; width: number } {
  const pad = 8;
  const panel = button.closest('.chat-panel-container');
  const bounds = (panel ?? document.documentElement).getBoundingClientRect();
  const btn = button.getBoundingClientRect();
  const width = Math.min(preferredWidth, Math.max(160, bounds.width - pad * 2));
  const minLeft = bounds.left + pad;
  const maxLeft = bounds.right - width - pad;
  const left = Math.min(Math.max(btn.right - width, minLeft), Math.max(minLeft, maxLeft));
  return { top: btn.bottom + 4, left, width };
}

function BranchRow({
  label,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      aria-disabled={disabled || active || undefined}
      className={`flex w-full items-center gap-2 rounded px-2.5 py-1 text-left text-xs transition-colors ${
        active
          ? 'cursor-default bg-agent-foreground/5 font-medium text-agent-foreground'
          : 'text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground'
      } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
      data-branch-row
      data-active={active || undefined}
    >
      <span className="min-w-0 flex-1 truncate">{label || t('(empty branch)')}</span>
      {active && (
        <LuCheck className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
      )}
    </button>
  );
}
