/**
 * AgentSidebar — parity rewrite that mirrors the visual + interaction
 * surface of `deeppath/apps/web/src/app/agent/AgentSidebar.tsx`.
 *
 * ## Agent picker semantics (this was a UX bug — read before changing!)
 *
 * Two distinct concepts share the agent list, and conflating them was the
 * original sin of the first cut:
 *
 *   • **selectedAgentId** — "which agent will the NEXT `+ 新对话` use".
 *     Driven by user clicks in the sidebar. Persists until the user clicks
 *     another agent. Defaults to this flavor's builtin expert on first load
 *     （场景产品 → 包的主打专家；无包产品 → shell 默认智能体）.
 *   • **activeChatAgentId** — "which agent the CURRENT chat is bound to"
 *     (URL-driven, can't be re-bound without a backend endpoint). Purely
 *     informational in the sidebar — there's no UI for switching mid-chat
 *     yet.
 *
 * The original code computed `displayAgentId = activeChatAgentId ?? selectedAgentId`
 * and lit up THAT row. Result: when the user was inside a chat and clicked a
 * DIFFERENT agent, the click silently mutated `selectedAgentId`, but the
 * highlight stayed pinned to the chat's existing agent → the user saw zero
 * feedback and assumed the button was broken. They only noticed selection
 * worked after clicking `+ 新对话` and seeing the new agent in the new chat.
 *
 * Current behavior:
 *   1. **Row highlight always tracks `selectedAgentId`** — click = visible
 *      response, no exceptions.
 *   2. **Current chat's agent gets a "当前" pill** — small badge to the
 *      right of the row, never blocks selection feedback.
 *   3. **Navigating to a chat auto-syncs `selectedAgentId = chat.agentId`**
 *      via a useEffect on `activeChatAgentId`. This way the user's mental
 *      model "I'm working with agent X" stays consistent: switching chat
 *      switches the selection; clicking an agent overrides it.
 *   4. **When `selectedAgentId !== activeChatAgentId`** (the user has
 *      explicitly diverged), an inline `+ 用「name」新建对话` CTA appears
 *      below the agent list. This makes the "your click set up a new chat"
 *      contract impossible to miss.
 *
 * ## Other intentional differences from the cloud sibling
 *
 *   • Active chat id comes from the URL (`useParams().chatId`) rather than
 *     a Context (we drive navigation, not vice versa).
 *   • Agent CRUD lives on `/settings?section=plugins`（侧栏「插件」里的智能体分类），
 *     not a modal. Custom agents show up in ChatInput's expert picker.
 *   • Cmd+N / Cmd+T trigger `menu:new-chat` / `menu:open-terminal` via the
 *     preload bridge; we subscribe here so the shortcuts work regardless of
 *     focused window. The terminal is a toggleable panel BESIDE the chat
 *     (owned by AgentLayout), not a route and not a separate window.
 *
 * Layout map:
 *
 *   ┌─────────────────────────────────┐
 *   │ ✨ Product Agent          +•   │ ← + has a color dot of the selected agent
 *   ├─────────────────────────────────┤
 *   │ ✎ 新对话                        │  ← 只打开落地页，有内容才落库
 *   │ 🧩 插件                         │ ← /settings?section=plugins（智能体 / Skills / MCP / 网络搜索）
 *   │  会话 v                     📁+ │ ← 📁+ 打开新建项目弹窗
 *   │  v 📁 项目A          (hover: ✎··)│ ← 拖拽组头排序；✎ 新建对话；·· 菜单：重命名/换目录/访达/删
 *   │   ...（项目内对话，超过 5 条再展开）│
 *   │   今天                          │
 *   │   ...（无项目对话，按日期分组）  │ ← 无项目排在项目分组之后
 *   ├─────────────────────────────────┤
 *   │ DeepSeek           可用 ↻   │ ← DeepSeek / Kimi 时显示供应商账户余额
 *   │ ⚙ 设置                   v0.2.2 │ ← /settings；右侧是当前版本，检查更新在设置页
 *   └─────────────────────────────────┘
 *
 * 项目模式：项目 = 名字 + 托管家目录（Documents/<应用名>/<项目名>/）+
 * 可选源文件夹。家目录与源文件夹（含各自子目录）都可读写。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  LuChevronDown,
  LuChevronRight,
  LuMessageSquare,
  LuCloudCog,
  LuTrash2,
  LuLoaderCircle,
  LuSettings,
  LuSquarePen,
  LuPanelLeftClose,
  LuBlocks,
  LuFolder,
  LuFolderOpen,
  LuFolderPlus,
  LuPencil,
  LuEllipsis,
  LuCircleHelp,
} from "react-icons/lu";
import { RiPushpin2Fill, RiPushpin2Line } from "react-icons/ri";
import { parseChatTitle } from "@/lib/chat-title";
import { getDateGroupLabel, getDateGroupPriority } from "@/lib/date-groups";
import { getHostBridge, hasHostBridge } from "@/lib/host-bridge";
import { hasGeneralSettingsChrome, hostToolChrome, settingsChrome } from "@/lib/host-tools";
import {
  createProject,
  deleteProject,
  getChatLiveStream,
  openLocalPath,
  setChatPinned,
  updateProject,
  type LocalChat,
  type LocalChatAgent,
  type LocalProject,
} from "@/lib/local-api";
import { usePendingAskUserChatIds } from "@/components/chat/AskUserPromptProvider";
import { usePendingApprovalChatIds } from "@/components/chat/ApprovalPromptProvider";
import type { UseChatsAndAgentsResult } from "@/hooks/useChatsAndAgents";
import { persistProjectOrder, useProjects } from "@/hooks/useProjects";
import {
  nextProjectOrder,
  type ProjectDropPlace,
} from "@/lib/project-order";
import type { RightPanelState } from "@/layouts/AgentLayout";
import { BrandLockup } from "@/components/BrandLockup";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  SidebarVersionLabel,
  useAppRelease,
} from "@/components/SidebarRelease";
import { SidebarAccount } from "@/components/SidebarAccount";
import { CreateProjectModal } from "@/components/CreateProjectModal";
import { t } from "@/i18n";

function projectDropPlace(element: HTMLElement, clientY: number): ProjectDropPlace {
  const rect = element.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/** 项目里先露出的普通会话条数。每一次「显示更多」再露出同样多条。 */
const PROJECT_CHAT_PAGE = 5;

/**
 * 进行中、等待输入的会话保持原位，不占用这 5 条名额。
 * 当前打开的会话如果落在名额之外，仍单独留在列表里。
 */
function visibleProjectChats<T extends { id: string }>(
  items: readonly T[],
  limit: number,
  options: {
    currentId?: string;
    isAlwaysVisible: (chat: T) => boolean;
  },
): { rows: T[]; hiddenCount: number } {
  let ordinary = 0;
  const kept = new Set<string>();
  for (const chat of items) {
    if (options.isAlwaysVisible(chat)) {
      kept.add(chat.id);
      continue;
    }
    if (ordinary < limit) {
      kept.add(chat.id);
      ordinary += 1;
    }
  }
  if (
    options.currentId &&
    items.some((chat) => chat.id === options.currentId)
  ) {
    kept.add(options.currentId);
  }
  const rows = items.filter((chat) => kept.has(chat.id));
  return { rows, hiddenCount: items.length - rows.length };
}

function placeProjectMenu(anchor: HTMLElement): { top: number; left: number } {
  const box = anchor.getBoundingClientRect();
  const width = 224;
  const left = Math.min(box.right + 4, window.innerWidth - width - 8);
  return { top: Math.max(8, box.top), left };
}

function ProjectOverflowMenu({
  project,
  chatCount,
  anchor,
  revealLabel,
  onClose,
  onRename,
  onChangeFolder,
  onReveal,
  onDelete,
}: {
  project: LocalProject;
  chatCount: number;
  anchor: HTMLElement;
  revealLabel: string;
  onClose: () => void;
  onRename: () => void;
  onChangeFolder: () => void;
  onReveal?: () => void;
  onDelete: () => void;
}) {
  const pos = placeProjectMenu(anchor);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="fixed inset-0 z-[90]" onClick={onClose} />
      <div
        role="menu"
        className="fixed z-[91] w-56 overflow-hidden rounded-2xl border border-agent-border bg-agent-canvas p-1 shadow-lg"
        style={pos}
        data-testid="project-overflow-menu"
      >
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-agent-foreground">
            <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
            <span className="min-w-0 truncate">{project.name}</span>
          </div>
          <div className="mt-0.5 pl-[22px] text-[10px] text-agent-muted-foreground">
            {t("Chats: {count}", { count: chatCount })}
          </div>
          <div
            className="mt-0.5 truncate pl-[22px] font-mono text-[10px] text-agent-muted-foreground/70"
            title={project.folderPath}
          >
            {project.folderPath}
          </div>
        </div>
        <div className="mx-1 my-1 border-t border-agent-border/60" />
        <button
          type="button"
          role="menuitem"
          title={t("Rename project")}
          onClick={onRename}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuPencil className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          {t("Rename")}
        </button>
        <button
          type="button"
          role="menuitem"
          title={t("Edit project")}
          onClick={onChangeFolder}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuFolderOpen className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          {t("Edit project")}
        </button>
        {onReveal && (
        <button
          type="button"
          role="menuitem"
          title={revealLabel}
          onClick={onReveal}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          {revealLabel}
        </button>
        )}
        <div className="mx-1 my-1 border-t border-agent-border/60" />
        <button
          type="button"
          role="menuitem"
          title={t("Delete project (its chats stay as chats without a project)")}
          onClick={onDelete}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-destructive/10"
        >
          <LuTrash2 className="h-3.5 w-3.5 shrink-0" />
          {t("Delete project")}
        </button>
      </div>
    </>,
    document.body,
  );
}

/** 置顶 / 项目 / 最近 的展开状态。缺省键走组件内默认。 */
const SIDEBAR_SECTIONS_KEY = "deeppath.agent.sidebarSections";

type SidebarSectionId = "pinned" | "projects" | "recents";

function readStoredSidebarSections(): Partial<Record<SidebarSectionId, boolean>> {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const out: Partial<Record<SidebarSectionId, boolean>> = {};
    for (const id of ["pinned", "projects", "recents"] as const) {
      if (typeof record[id] === "boolean") out[id] = record[id];
    }
    return out;
  } catch {
    return {};
  }
}

/** 切走后对后台会话轮询 live-stream 的间隔，与对话页恢复轮询同级。 */
const BACKGROUND_STREAM_POLL_MS = 750;
/**
 * 标记成正在生成之后，快照可能还没注册。这段时间内 live-stream 报
 * inactive 不摘指示；见过 active，或超过这段时间仍 inactive，才摘掉。
 */
const BACKGROUND_STREAM_GRACE_MS = 3_000;

function writeSidebarSectionExpanded(id: SidebarSectionId, expanded: boolean) {
  try {
    const current = readStoredSidebarSections();
    window.localStorage.setItem(
      SIDEBAR_SECTIONS_KEY,
      JSON.stringify({ ...current, [id]: expanded }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

interface AgentSidebarProps {
  data: UseChatsAndAgentsResult;
  /** 右侧栏当前打开的面板：null / 'terminal' / 包槽位 id（互斥）。 */
  rightPanel?: RightPanelState;
  /** 切换右侧栏面板显隐——面板不是路由也不是独立窗口，只是布局里的一栏。 */
  onToggleRightPanel?: (kind: string) => void;
  /** 收起侧边栏（AgentLayout 换成窄 rail，展开按钮在 rail 上）。 */
  onCollapse: () => void;
}

export function AgentSidebar({
  data,
  rightPanel: _rightPanel,
  onToggleRightPanel: _onToggleRightPanel,
  onCollapse,
}: AgentSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { chatId: currentChatId } = useParams<{ chatId?: string }>();
  const bridge = getHostBridge();
  const release = useAppRelease();
  const onSettingsPage = location.pathname === "/settings";
  // 插件页（及旧的 agents/skills/mcp 深链）高亮「插件」；其余 /settings 高亮底部综合设置。
  const settingsSection = useMemo(
    () => new URLSearchParams(location.search).get("section"),
    [location.search],
  );
  const pluginsAvailable =
    settingsChrome("agents") ||
    settingsChrome("skills") ||
    settingsChrome("mcp") ||
    settingsChrome("web-search");
  const onPluginsSettings =
    pluginsAvailable &&
    onSettingsPage &&
    (settingsSection === "plugins" ||
      settingsSection === "agents" ||
      settingsSection === "skills" ||
      settingsSection === "mcp");
  const onGeneralSettings = onSettingsPage && !onPluginsSettings;
  const onNewChatHome = !currentChatId && !onSettingsPage;

  const {
    chats,
    isLoading: isChatLoading,
    error,
    refreshChats,
    setSelectedAgentId,
    deleteChat,
    isLoadingMoreChats,
    hasMoreChats,
    loadMoreChats,
  } = data;

  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform));
    }
  }, []);
  const [pendingDeleteChat, setPendingDeleteChat] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [pinningChatId, setPinningChatId] = useState<string | null>(null);
  const [streamingChatIds, setStreamingChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingAskUserChatIds = usePendingAskUserChatIds();
  const pendingApprovalChatIds = usePendingApprovalChatIds();

  useEffect(() => {
    const handleStreamingChange = (event: Event) => {
      const customEvent = event as CustomEvent<{
        chatId: string;
        isStreaming: boolean;
      }>;
      const { chatId, isStreaming } = customEvent.detail || {};
      if (!chatId) return;
      setStreamingChatIds((prev) => {
        const next = new Set(prev);
        if (isStreaming) {
          next.add(chatId);
        } else {
          next.delete(chatId);
        }
        return next;
      });
    };
    window.addEventListener("chat:streaming-change", handleStreamingChange);
    return () => {
      window.removeEventListener(
        "chat:streaming-change",
        handleStreamingChange,
      );
    };
  }, []);

  // 当前打开的会话由 AgentChatView 自己报开始/结束。切走后的会话回合还在
  // 后端跑，卸载时不会再报结束，这里用 live-stream 对账，结束后摘掉指示。
  const seenActiveBackgroundRef = useRef<Set<string>>(new Set());
  const backgroundSinceRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const id of seenActiveBackgroundRef.current) {
      if (!streamingChatIds.has(id)) seenActiveBackgroundRef.current.delete(id);
    }
    for (const id of backgroundSinceRef.current.keys()) {
      if (!streamingChatIds.has(id)) backgroundSinceRef.current.delete(id);
    }
    const backgroundIds = [...streamingChatIds].filter(
      (id) => id !== currentChatId,
    );
    if (backgroundIds.length === 0 || !hasHostBridge()) return;

    let cancelled = false;
    let ticking = false;
    const tick = async () => {
      if (ticking || cancelled) return;
      ticking = true;
      try {
        const now = Date.now();
        const settled = await Promise.all(
          backgroundIds.map(async (id) => {
            try {
              const live = await getChatLiveStream(id);
              return { id, active: live?.active === true, ok: true as const };
            } catch {
              return { id, active: false, ok: false as const };
            }
          }),
        );
        if (cancelled) return;
        const drop = new Set<string>();
        for (const row of settled) {
          if (!row.ok) continue;
          if (row.active) {
            seenActiveBackgroundRef.current.add(row.id);
            backgroundSinceRef.current.delete(row.id);
            continue;
          }
          // 已经对上过运行中的快照：inactive 就是回合结束。
          if (seenActiveBackgroundRef.current.has(row.id)) {
            drop.add(row.id);
            seenActiveBackgroundRef.current.delete(row.id);
            backgroundSinceRef.current.delete(row.id);
            continue;
          }
          // 还没见过快照（切走时回合可能刚起步）。宽限期内保留指示。
          const since = backgroundSinceRef.current.get(row.id);
          if (since === undefined) {
            backgroundSinceRef.current.set(row.id, now);
            continue;
          }
          if (now - since >= BACKGROUND_STREAM_GRACE_MS) {
            drop.add(row.id);
            backgroundSinceRef.current.delete(row.id);
          }
        }
        if (drop.size === 0) return;
        setStreamingChatIds((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const id of drop) {
            if (next.delete(id)) changed = true;
          }
          return changed ? next : prev;
        });
      } finally {
        ticking = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, BACKGROUND_STREAM_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [streamingChatIds, currentChatId]);

  // null = 用户还没点过这一组，走默认（置顶：有置顶会话才展开；项目、最近：展开）。
  // 点过之后写入 localStorage，刷新和重启后保持。
  const [pinnedExpanded, setPinnedExpanded] = useState<boolean | null>(
    () => readStoredSidebarSections().pinned ?? null,
  );
  const [projectsExpanded, setProjectsExpanded] = useState<boolean | null>(
    () => readStoredSidebarSections().projects ?? null,
  );
  const [recentsExpanded, setRecentsExpanded] = useState<boolean | null>(
    () => readStoredSidebarSections().recents ?? null,
  );
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // ───── 项目模式 ─────
  // 项目列表与输入框「关联到项目」共用 useProjects。会话按 projectId
  // 分组：项目分组在上（组头 hover：+ 新建对话 / ·· 菜单），无项目对话在下。
  const {
    projects,
    error: projectsLoadError,
    refresh: fetchProjects,
  } = useProjects();
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  // 每个项目已展开的普通会话名额。缺省是 PROJECT_CHAT_PAGE；Infinity 表示已全部展开。
  const [projectChatLimits, setProjectChatLimits] = useState<
    Record<string, number>
  >({});
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(
    null,
  );
  const [renamingValue, setRenamingValue] = useState("");
  const [pendingDeleteProject, setPendingDeleteProject] =
    useState<LocalProject | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  );
  const [projectError, setProjectError] = useState<string | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{
    id: string;
    anchor: HTMLElement;
  } | null>(null);
  const draggingProjectIdRef = useRef<string | null>(null);
  const projectDragMovedRef = useRef(false);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    place: ProjectDropPlace;
  } | null>(null);

  const endProjectDrag = useCallback(() => {
    draggingProjectIdRef.current = null;
    setDraggingProjectId(null);
    setDropTarget(null);
    // dragend 之后浏览器有时还会补一次 click。等这次 click 过去再清标记，
    // 避免松手把项目折叠掉；下一次真正的点击仍能折叠。
    window.setTimeout(() => {
      projectDragMovedRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    if (!draggingProjectId) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [draggingProjectId]);

  const showProjectsChrome = hostToolChrome("projects");

  const handleCreateProject = useCallback(
    async (input: { name: string; sourceFolders: string[] }) => {
      setProjectError(null);
      try {
        await createProject({
          name: input.name,
          ...(input.sourceFolders.length > 0
            ? { sourceFolders: input.sourceFolders }
            : {}),
        });
        await fetchProjects();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProjectError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [fetchProjects],
  );

  const handleRenameProject = useCallback(
    async (projectId: string) => {
      const name = renamingValue.trim();
      setRenamingProjectId(null);
      if (!name) return;
      try {
        await updateProject(projectId, { name });
        await fetchProjects();
      } catch (err) {
        setProjectError(err instanceof Error ? err.message : String(err));
      }
    },
    [renamingValue, fetchProjects],
  );

  const handleUpdateProject = useCallback(
    async (
      projectId: string,
      input: { name: string; sourceFolders: string[] },
    ) => {
      setProjectError(null);
      try {
        await updateProject(projectId, {
          name: input.name,
          sourceFolders: input.sourceFolders,
        });
        await fetchProjects();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProjectError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [fetchProjects],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      if (deletingProjectId === projectId) return;
      try {
        setDeletingProjectId(projectId);
        await deleteProject(projectId);
        setPendingDeleteProject(null);
        setProjectMenu(null);
        setEditingProjectId(null);
        await fetchProjects();
        await data.refreshChats();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProjectError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setDeletingProjectId(null);
      }
    },
    [deletingProjectId, fetchProjects, data],
  );

  const closeProjectMenu = useCallback(() => {
    setProjectMenu(null);
  }, []);

  const handleRevealProjectFolder = useCallback(async (folderPath: string) => {
    setProjectError(null);
    try {
      const res = await openLocalPath(folderPath);
      if (!res.success && res.error) setProjectError(res.error);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleProjectCollapsed = useCallback(
    (projectId: string) => {
      const collapsing = !collapsedProjectIds.has(projectId);
      setCollapsedProjectIds((prev) => {
        const next = new Set(prev);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        return next;
      });
      // 收起项目后再打开，回到最初的 5 条，不记住上次展开到第几页。
      if (collapsing) {
        setProjectChatLimits((limits) => {
          if (limits[projectId] === undefined) return limits;
          const next = { ...limits };
          delete next[projectId];
          return next;
        });
      }
    },
    [collapsedProjectIds],
  );

  const revealMoreProjectChats = useCallback(
    (projectId: string, hiddenCount: number) => {
      setProjectChatLimits((limits) => {
        if (hiddenCount === 0) {
          if (limits[projectId] === undefined) return limits;
          const next = { ...limits };
          delete next[projectId];
          return next;
        }
        const current = limits[projectId] ?? PROJECT_CHAT_PAGE;
        return {
          ...limits,
          [projectId]:
            hiddenCount <= PROJECT_CHAT_PAGE
              ? Number.POSITIVE_INFINITY
              : current + PROJECT_CHAT_PAGE,
        };
      });
    },
    [],
  );

  // Keep the shared "next new chat" agent aligned with the current chat. The
  // actual picker now lives in ChatInput, so the sidebar no longer renders the
  // expert list itself.
  const activeChatAgentId = useMemo(() => {
    if (!currentChatId) return null;
    return chats.find((c) => c.id === currentChatId)?.agentId ?? null;
  }, [chats, currentChatId]);

  // Auto-sync `selectedAgentId` when the user navigates to a chat. Without
  // this, the user lands in chat A (built on agent X), opens the sidebar,
  // sees agent Y still highlighted from a stale selection, and gets confused
  // about which agent is "active". Following the URL keeps the mental model
  // straight: "the agent I'm currently working with is the highlighted one".
  // Any explicit click in the sidebar overrides this back to the clicked
  // agent (see handlePickAgent).
  useEffect(() => {
    if (activeChatAgentId) setSelectedAgentId(activeChatAgentId);
  }, [activeChatAgentId, setSelectedAgentId]);

  // 「新对话」只打开落地页，不落库。有内容才在 EmptyChatGate 提交时
  // createChat。项目组头的「+」带上 projectId，落地页预选该项目。
  const handleOpenNewChat = useCallback(
    (projectId?: string) => {
      if (projectId) {
        navigate(`/agent?projectId=${encodeURIComponent(projectId)}`);
        return;
      }
      navigate("/agent");
    },
    [navigate],
  );

  const normalizedChats = useMemo(() => {
    return chats
      .map((chat) => {
        const updated = chat.updatedAt ? new Date(chat.updatedAt) : null;
        const created = new Date(chat.createdAt);
        const sortDate =
          updated && !Number.isNaN(updated.getTime())
            ? updated
            : !Number.isNaN(created.getTime())
              ? created
              : new Date();
        const { displayTitle, isAutomation } = parseChatTitle(chat.title);
        return {
          id: chat.id,
          title: displayTitle || t("New conversation"),
          isAutomation,
          isPinned: chat.isPinned,
          sortDate,
          agentId: chat.agentId ?? null,
          projectId: chat.projectId ?? null,
          isStreaming: chat.isStreaming,
          needsUserInput: chat.needsUserInput,
        };
      })
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return b.sortDate.getTime() - a.sortDate.getTime();
      });
  }, [chats]);

  // 顶层按项目分组：无项目对话（含项目已被删但列表还没刷新的孤儿会话）
  // 保持原有的日期分组；每个项目一个分组，组内按 pin + 时间排序。
  const knownProjectIds = useMemo(
    () =>
      showProjectsChrome
        ? new Set(projects.map((p) => p.id))
        : new Set<string>(),
    [projects, showProjectsChrome],
  );

  const noProjectChats = useMemo(
    () =>
      normalizedChats.filter(
        (c) => !c.projectId || !knownProjectIds.has(c.projectId),
      ),
    [normalizedChats, knownProjectIds],
  );

  const projectGroups = useMemo(
    () =>
      showProjectsChrome
        ? projects.map((project) => ({
            project,
            items: normalizedChats.filter((c) => c.projectId === project.id),
          }))
        : [],
    [projects, normalizedChats, showProjectsChrome],
  );

  const pinnedChats = useMemo(
    () => normalizedChats.filter((c) => c.isPinned),
    [normalizedChats],
  );

  const recentChatGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        label: string;
        priority: number;
        items: typeof normalizedChats;
      }
    >();
    noProjectChats
      .filter((chat) => !chat.isPinned)
      .forEach((chat) => {
        const label = getDateGroupLabel(chat.sortDate);
        if (!map.has(label)) {
          map.set(label, {
            label,
            priority: getDateGroupPriority(chat.sortDate),
            items: [],
          });
        }
        map.get(label)!.items.push(chat);
      });
    return Array.from(map.values()).sort((a, b) => a.priority - b.priority);
  }, [noProjectChats]);

  const isPinnedExpanded = pinnedExpanded ?? pinnedChats.length > 0;
  const isProjectsExpanded = projectsExpanded ?? true;
  const isRecentsExpanded = recentsExpanded ?? true;

  const handleDeleteChat = useCallback(async () => {
    if (!pendingDeleteChat || deletingChatId === pendingDeleteChat.id) return;
    const id = pendingDeleteChat.id;
    try {
      setDeletingChatId(id);
      const ok = await deleteChat(id);
      if (ok) {
        setPendingDeleteChat(null);
        if (id === currentChatId) navigate("/agent");
      }
    } finally {
      setDeletingChatId(null);
    }
  }, [pendingDeleteChat, deleteChat, deletingChatId, currentChatId, navigate]);

  const handleTogglePinChat = useCallback(
    async (id: string, nextPinned: boolean) => {
      if (pinningChatId === id) return;
      setPinningChatId(id);
      try {
        await setChatPinned(id, nextPinned);
        await refreshChats();
      } catch (err) {
        console.error("Failed to toggle chat pin:", err);
      } finally {
        setPinningChatId(null);
      }
    },
    [pinningChatId, refreshChats],
  );

  // 单条会话行——无项目日期分组和项目分组共用同一个渲染，避免两份 JSX。
  const renderChatRow = (chat: (typeof normalizedChats)[number]) => {
    const isCurrent = currentChatId === chat.id;
    const isDeleting = deletingChatId === chat.id;
    const isPinning = pinningChatId === chat.id;
    const isStreaming = Boolean(
      chat.isStreaming || streamingChatIds.has(chat.id),
    );
    const needsUserInput = Boolean(
      chat.needsUserInput ||
      pendingAskUserChatIds.has(chat.id) ||
      pendingApprovalChatIds.has(chat.id),
    );

    return (
      <div
        key={chat.id}
        className="group/item relative"
        data-testid="sidebar-chat-row"
        data-chat-id={chat.id}
      >
        <button
          type="button"
          onClick={() => {
            navigate(`/agent/${chat.id}`);
          }}
          className={[
            "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-200",
            isCurrent
              ? "bg-agent-foreground/10 font-medium text-agent-foreground"
              : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
          ].join(" ")}
          title={
            chat.isAutomation
              ? t("[Triggered by automation] {title}", { title: chat.title })
              : chat.title
          }
        >
          {needsUserInput ? (
            <span
              className="flex shrink-0 items-center justify-center text-amber-500 dark:text-amber-400"
              title={t("Has a question that needs your input")}
              aria-label={t("Waiting for user input")}
            >
              <LuCircleHelp className="h-3.5 w-3.5 animate-pulse" />
            </span>
          ) : isStreaming ? (
            <span
              className="flex shrink-0 items-center justify-center text-agent-foreground/70"
              title={t("Conversation in progress")}
              aria-label={t("Generating")}
            >
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            </span>
          ) : null}
          {chat.isAutomation && (
            <LuCloudCog
              className="h-3 w-3 shrink-0 text-agent-muted-foreground"
              aria-label={t("Triggered by automation")}
            />
          )}
          <span className="min-w-0 truncate leading-none">{chat.title}</span>
        </button>
        {/* Semi-transparent gradient container for action buttons:
            fades long text smoothly to the left so buttons don't collide with text. */}
        <div
          className={[
            "absolute inset-y-0 right-0 flex items-center justify-end gap-0.5 pr-1 pl-8 rounded-r-full transition-all duration-200",
            "bg-gradient-to-l from-agent-muted/95 via-agent-muted/80 to-transparent",
            "opacity-0 group-hover/item:opacity-100 focus-within:opacity-100 pointer-events-none group-hover/item:pointer-events-auto focus-within:pointer-events-auto",
          ].join(" ")}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleTogglePinChat(chat.id, !chat.isPinned);
            }}
            disabled={isPinning}
            className="flex h-6 w-6 items-center justify-center rounded-full text-agent-foreground/70 transition-all duration-200 hover:bg-agent-foreground/10 hover:text-agent-foreground disabled:cursor-not-allowed"
            title={chat.isPinned ? t("Unpin") : t("Pin chat")}
            aria-label={chat.isPinned ? t("Unpin") : t("Pin chat")}
            data-testid="sidebar-chat-pin"
          >
            {chat.isPinned ? (
              <RiPushpin2Fill className="h-3.5 w-3.5 text-agent-foreground" />
            ) : (
              <RiPushpin2Line className="h-3.5 w-3.5 text-agent-foreground/75 hover:text-agent-foreground" />
            )}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setPendingDeleteChat({ id: chat.id, title: chat.title });
            }}
            disabled={isDeleting}
            className="flex h-6 w-6 items-center justify-center rounded-full text-agent-foreground/70 transition-all duration-200 hover:bg-agent-foreground/10 hover:text-agent-destructive disabled:cursor-not-allowed disabled:opacity-100"
            title={t("Delete chat")}
            aria-label={t("Delete chat")}
            data-testid="sidebar-chat-delete"
          >
            <LuTrash2
              className={["h-3.5 w-3.5", isDeleting ? "animate-pulse" : ""].join(
                " ",
              )}
            />
          </button>
        </div>
      </div>
    );
  };

  // Cmd+N from the app menu — wired in src/main.ts:createMenu (sends
  // `menu:new-chat`). The bridge methods are optional because non-Electron
  // dev previews don't have them.
  useEffect(() => {
    if (!bridge?.onMenuNewChat) return;
    bridge.onMenuNewChat(() => {
      handleOpenNewChat();
    });
    return () => {
      bridge.offMenuNewChat?.();
    };
  }, [bridge, handleOpenNewChat]);

  // Auto-load next page when the chat scroller approaches the bottom. Project
  // groups need the complete list: otherwise an older project chat outside the
  // first page makes its project incorrectly render as empty.
  // Throttled by `isLoadingMoreChats` inside the hook.
  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;

    const maybeLoadMore = () => {
      if (!hasMoreChats || isLoadingMoreChats) return;
      const nearBottom =
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - 60;
      const needsCompleteProjectGroups =
        showProjectsChrome && projects.length > 0;
      if (nearBottom || needsCompleteProjectGroups) void loadMoreChats();
    };
    container.addEventListener("scroll", maybeLoadMore, { passive: true });
    const tickId = window.requestAnimationFrame(maybeLoadMore);
    return () => {
      container.removeEventListener("scroll", maybeLoadMore);
      window.cancelAnimationFrame(tickId);
    };
  }, [
    hasMoreChats,
    isLoadingMoreChats,
    loadMoreChats,
    isRecentsExpanded,
    normalizedChats.length,
    projects.length,
    showProjectsChrome,
  ]);

  const hasElectron = hasHostBridge();

  const projectChatWindow = (
    items: typeof normalizedChats,
    limit: number,
  ) =>
    visibleProjectChats(items, limit, {
      currentId: currentChatId,
      isAlwaysVisible: (chat) =>
        Boolean(
          chat.isStreaming ||
            streamingChatIds.has(chat.id) ||
            chat.needsUserInput ||
            pendingAskUserChatIds.has(chat.id) ||
            pendingApprovalChatIds.has(chat.id),
        ),
    });

  return (
    <div className="flex h-full w-full flex-col border-r border-agent-border/60 bg-agent-muted/70 backdrop-blur-md">
      {/* ───── Brand + actions ───── */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between px-2.5">
        <BrandLockup onClick={() => handleOpenNewChat()} />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-full text-agent-muted-foreground transition-colors duration-200 hover:bg-agent-foreground/5 hover:text-agent-foreground"
            title={t("Collapse sidebar")}
            aria-label={t("Collapse sidebar")}
          >
            <LuPanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ───── 会话 ───── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 新对话 + 插件（智能体 / Skills / MCP / 网络搜索在同一页用分类切换） */}
        <div className="flex-shrink-0 space-y-0.5 px-2.5 pb-0.5">
          <button
            type="button"
            onClick={() => handleOpenNewChat()}
            className={[
              "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
              onNewChatHome
                ? "bg-agent-foreground/10 font-medium text-agent-foreground"
                : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
            ].join(" ")}
            title={t("Start a new chat")}
            data-testid="sidebar-new-chat"
          >
            <LuSquarePen className="h-3.5 w-3.5" />
            <span>{t("New chat")}</span>
          </button>
          {pluginsAvailable && (
          <button
            type="button"
            onClick={() => navigate("/settings?section=plugins")}
            className={[
              "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
              onPluginsSettings
                ? "bg-agent-foreground/10 font-medium text-agent-foreground"
                : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
            ].join(" ")}
            title={t("Plugins")}
            data-testid="sidebar-plugins"
          >
            <LuBlocks className="h-3.5 w-3.5" />
            <span>{t("Plugins")}</span>
          </button>
          )}
        </div>

        <div
          ref={chatScrollRef}
          className="flex-1 overflow-y-auto px-2.5 pb-1"
        >
          {isChatLoading && chats.length === 0 && projects.length === 0 ? (
            <div className="flex items-center justify-center py-4 text-xs text-agent-muted-foreground">
              <LuLoaderCircle className="mr-1.5 h-3 w-3 animate-spin" />
              {t("Loading...")}
            </div>
          ) : (
            <>
              {/* 1. 置顶 (Pinned)：没有置顶会话时整组不出现 */}
              {pinnedChats.length > 0 && (
              <div className="mb-1.5">
                <div className="group/section flex h-7 items-center justify-between rounded-agent-md px-1.5 text-xs text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground">
                  <button
                    type="button"
                    aria-expanded={isPinnedExpanded}
                    onClick={() => {
                      const next = !isPinnedExpanded;
                      setPinnedExpanded(next);
                      writeSidebarSectionExpanded("pinned", next);
                    }}
                    className="flex flex-1 min-w-0 items-center gap-1 text-left font-medium text-agent-muted-foreground hover:text-agent-foreground"
                  >
                    <span>{t("Pinned")}</span>
                    {isPinnedExpanded ? (
                      <LuChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                    ) : (
                      <LuChevronRight className="h-3 w-3 shrink-0 opacity-70" />
                    )}
                  </button>
                </div>
                {isPinnedExpanded && (
                  <div className="space-y-0.5">
                    {pinnedChats.map((chat) => renderChatRow(chat))}
                  </div>
                )}
              </div>
              )}

              {/* 2. 项目 (Projects) */}
              {showProjectsChrome && (
                <div className="mb-1.5">
                  <div className="group/section flex h-7 items-center justify-between rounded-agent-md px-1.5 text-xs text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground">
                    <button
                      type="button"
                      aria-expanded={isProjectsExpanded}
                      onClick={() => {
                        const next = !isProjectsExpanded;
                        setProjectsExpanded(next);
                        writeSidebarSectionExpanded("projects", next);
                      }}
                      className="flex flex-1 min-w-0 items-center gap-1 text-left font-medium text-agent-muted-foreground hover:text-agent-foreground"
                    >
                      <span>{t("Projects")}</span>
                      {isProjectsExpanded ? (
                        <LuChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                      ) : (
                        <LuChevronRight className="h-3 w-3 shrink-0 opacity-70" />
                      )}
                    </button>
                    {hasElectron && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCreateProjectOpen(true);
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground opacity-0 transition-opacity duration-200 hover:bg-agent-foreground/10 hover:text-agent-foreground group-hover/section:opacity-100 focus:opacity-100"
                        title={t("New project")}
                        aria-label={t("New project")}
                      >
                        <LuFolderPlus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {isProjectsExpanded && (
                    <div className="space-y-0.5">
                      {projectGroups.length === 0 ? (
                        <div className="px-2.5 py-1 text-[11px] text-agent-muted-foreground/60">
                          {t("No projects")}
                        </div>
                      ) : (
                        projectGroups.map(({ project, items }) => (
                          <div
                            key={project.id}
                            data-testid="sidebar-project"
                            data-project-id={project.id}
                            className="relative pb-1"
                            onDragOver={(event) => {
                              if (!draggingProjectIdRef.current) return;
                              event.preventDefault();
                              if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                              const place = projectDropPlace(
                                event.currentTarget,
                                event.clientY,
                              );
                              setDropTarget((current) =>
                                current?.id === project.id && current.place === place
                                  ? current
                                  : { id: project.id, place },
                              );
                            }}
                            onDragLeave={(event) => {
                              const next = event.relatedTarget;
                              if (
                                next instanceof Node &&
                                event.currentTarget.contains(next)
                              ) {
                                return;
                              }
                              setDropTarget((current) =>
                                current?.id === project.id ? null : current,
                              );
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const fromId = draggingProjectIdRef.current;
                              const place = projectDropPlace(
                                event.currentTarget,
                                event.clientY,
                              );
                              endProjectDrag();
                              if (!fromId) return;
                              const next = nextProjectOrder(
                                projectGroups.map((group) => group.project.id),
                                fromId,
                                project.id,
                                place,
                              );
                              if (!next) return;
                              void persistProjectOrder(next).catch((err) => {
                                setProjectError(
                                  err instanceof Error ? err.message : String(err),
                                );
                              });
                            }}
                          >
                            {dropTarget?.id === project.id && draggingProjectId ? (
                              <div
                                className={[
                                  "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-agent-foreground",
                                  dropTarget.place === "before" ? "top-0" : "bottom-1",
                                ].join(" ")}
                                data-testid="sidebar-project-drop-indicator"
                              />
                            ) : null}
                            <div
                              className={[
                                "group/proj relative",
                                draggingProjectId === project.id ? "opacity-40" : "",
                              ].join(" ")}
                            >
                              {renamingProjectId === project.id ? (
                                <form
                                  className="flex items-center px-2.5 pb-1 pt-1.5"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    void handleRenameProject(project.id);
                                  }}
                                >
                                  <input
                                    autoFocus
                                    value={renamingValue}
                                    onChange={(event) =>
                                      setRenamingValue(event.target.value)
                                    }
                                    onBlur={() => void handleRenameProject(project.id)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Escape")
                                        setRenamingProjectId(null);
                                    }}
                                    className="h-6 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                                  />
                                </form>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    draggable
                                    data-testid="sidebar-project-handle"
                                    data-project-id={project.id}
                                    onDragStart={(event) => {
                                      projectDragMovedRef.current = true;
                                      draggingProjectIdRef.current = project.id;
                                      setDraggingProjectId(project.id);
                                      const transfer = event.dataTransfer;
                                      if (!transfer) return;
                                      transfer.effectAllowed = "move";
                                      try {
                                        transfer.setData("text/plain", project.name);
                                      } catch (error) {
                                        // 排序状态记在 ref 里。个别环境拒绝写入 DataTransfer。
                                        void error;
                                      }
                                    }}
                                    onDragEnd={() => {
                                      endProjectDrag();
                                    }}
                                    onClick={() => {
                                      if (projectDragMovedRef.current) return;
                                      toggleProjectCollapsed(project.id);
                                    }}
                                    className="flex w-full min-w-0 cursor-grab items-center px-2 pb-0.5 pt-1 text-[11px] font-medium text-agent-muted-foreground/90 transition-colors hover:text-agent-foreground active:cursor-grabbing"
                                    title={`${project.name}\n${project.folderPath}`}
                                  >
                                    <LuFolder className="mr-1 h-3.5 w-3.5 shrink-0" />
                                    <span className="min-w-0 truncate normal-case">
                                      {project.name}
                                    </span>
                                    <span className="ml-1 shrink-0">
                                      {collapsedProjectIds.has(project.id) ? (
                                        <LuChevronRight className="h-3 w-3" />
                                      ) : (
                                        <LuChevronDown className="h-3 w-3" />
                                      )}
                                    </span>
                                  </button>
                                  <div
                                    className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity ${
                                      projectMenu?.id === project.id
                                        ? "pointer-events-auto opacity-100"
                                        : "pointer-events-none opacity-0 group-hover/proj:pointer-events-auto group-hover/proj:opacity-100"
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => handleOpenNewChat(project.id)}
                                      className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                                      title={t("New chat in this project")}
                                    >
                                      <LuSquarePen className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={t("Project menu")}
                                      aria-expanded={projectMenu?.id === project.id}
                                      onClick={(event) => {
                                        const button = event.currentTarget;
                                        setProjectMenu((current) =>
                                          current?.id === project.id
                                            ? null
                                            : { id: project.id, anchor: button },
                                        );
                                      }}
                                      className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                                      title={t("Project menu")}
                                    >
                                      <LuEllipsis className="h-3 w-3" />
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                            {!collapsedProjectIds.has(project.id) && (
                              <div className="space-y-0.5 pl-2">
                                {items.length === 0 ? (
                                  <div className="px-2.5 py-0.5 text-[11px] text-agent-muted-foreground/60">
                                    {t("No chats yet. Hover the project name and click + to start one.")}
                                  </div>
                                ) : (
                                  (() => {
                                    const limit =
                                      projectChatLimits[project.id] ??
                                      PROJECT_CHAT_PAGE;
                                    const folded = projectChatWindow(
                                      items,
                                      PROJECT_CHAT_PAGE,
                                    );
                                    const shown = projectChatWindow(items, limit);
                                    const fullyShown = shown.hiddenCount === 0;
                                    return (
                                      <>
                                        {shown.rows.map((chat) =>
                                          renderChatRow(chat),
                                        )}
                                        {folded.hiddenCount > 0 && (
                                          <button
                                            type="button"
                                            data-testid="sidebar-project-show-more"
                                            data-project-id={project.id}
                                            aria-expanded={fullyShown}
                                            onClick={() =>
                                              revealMoreProjectChats(
                                                project.id,
                                                shown.hiddenCount,
                                              )
                                            }
                                            className="flex h-7 w-full items-center rounded-full px-2.5 text-left text-[11px] text-agent-muted-foreground/80 transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground"
                                          >
                                            {fullyShown
                                              ? t("Show less")
                                              : t("Show {count} more", {
                                                  count: shown.hiddenCount,
                                                })}
                                          </button>
                                        )}
                                      </>
                                    );
                                  })()
                                )}
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 3. 最近 (Recents) */}
              <div className="mb-1.5">
                <div className="group/section flex h-7 items-center justify-between rounded-agent-md px-1.5 text-xs text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground">
                  <button
                    type="button"
                    aria-expanded={isRecentsExpanded}
                    onClick={() => {
                      const next = !isRecentsExpanded;
                      setRecentsExpanded(next);
                      writeSidebarSectionExpanded("recents", next);
                    }}
                    className="flex flex-1 min-w-0 items-center gap-1 text-left font-medium text-agent-muted-foreground hover:text-agent-foreground"
                  >
                    <span>{t("Recent")}</span>
                    {isRecentsExpanded ? (
                      <LuChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                    ) : (
                      <LuChevronRight className="h-3 w-3 shrink-0 opacity-70" />
                    )}
                  </button>
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover/section:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenNewChat();
                      }}
                      className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                      title={t("New chat")}
                      aria-label={t("New chat")}
                    >
                      <LuSquarePen className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                {isRecentsExpanded && (
                  <div className="space-y-0.5">
                    {recentChatGroups.length === 0 ? (
                      chats.length === 0 && projects.length === 0 ? (
                        <div className="flex flex-col items-center gap-1.5 py-4 text-xs text-agent-muted-foreground">
                          <LuMessageSquare className="h-4 w-4 text-agent-muted-foreground/60" />
                          {t("No chats yet")}
                        </div>
                      ) : (
                        <div className="px-2.5 py-1 text-[11px] text-agent-muted-foreground/60">
                          {t("No chats yet")}
                        </div>
                      )
                    ) : (
                      recentChatGroups.map((group) => (
                        <div key={group.label} className="mb-1">
                          <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-agent-muted-foreground/80">
                            {group.label}
                          </div>
                          <div className="space-y-0.5">
                            {group.items.map((chat) => renderChatRow(chat))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          {normalizedChats.length > 0 && (
            <div className="px-2 py-2 text-center text-[11px] text-agent-muted-foreground">
              {isLoadingMoreChats ? (
                <span className="inline-flex items-center gap-1">
                  <LuLoaderCircle className="h-3 w-3 animate-spin" />
                  {t("Loading more...")}
                </span>
              ) : hasMoreChats ? (
                t("Scroll down to load more")
              ) : (
                t("Total chats: {count}", { count: normalizedChats.length })
              )}
            </div>
          )}
        </div>
      </div>

      {(error || projectError || projectsLoadError) && (
        <div
          className="flex-shrink-0 border-t border-agent-destructive/40 bg-agent-destructive/10 px-2.5 py-1.5 text-[11px] text-agent-destructive"
          role="alert"
        >
          {error ?? projectError ?? projectsLoadError}
        </div>
      )}

      {/* ───── Footer: 设置 ───── */}
      <div className="flex-shrink-0 border-t border-agent-border/40 px-2.5 py-1.5">
        <SidebarAccount />
        {hasGeneralSettingsChrome() && (
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className={[
            "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
            onGeneralSettings
              ? "bg-agent-foreground/10 font-medium text-agent-foreground"
              : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
          ].join(" ")}
          title={t("Settings")}
          data-testid="sidebar-llm-settings"
        >
          <LuSettings className="h-3.5 w-3.5" />
          <span>{t("Settings")}</span>
          <SidebarVersionLabel release={release} />
        </button>
        )}
        {!hasGeneralSettingsChrome() && release.version ? (
          <div className="mt-0.5 flex h-7 w-full items-center px-2.5">
            <SidebarVersionLabel release={release} />
          </div>
        ) : null}
      </div>

      {projectMenu &&
        (() => {
          const project = projects.find((item) => item.id === projectMenu.id);
          if (!project) return null;
          const chatCount =
            projectGroups.find((group) => group.project.id === project.id)
              ?.items.length ?? 0;
          return (
            <ProjectOverflowMenu
              project={project}
              chatCount={chatCount}
              anchor={projectMenu.anchor}
              revealLabel={isMac ? t("Show in Finder") : t("Show in file manager")}
              onClose={closeProjectMenu}
              onRename={() => {
                setProjectMenu(null);
                setRenamingProjectId(project.id);
                setRenamingValue(project.name);
              }}
              onChangeFolder={() => {
                setProjectMenu(null);
                setEditingProjectId(project.id);
              }}
              onReveal={
                hostToolChrome("local-fs")
                  ? () => {
                      setProjectMenu(null);
                      void handleRevealProjectFolder(project.folderPath);
                    }
                  : undefined
              }
              onDelete={() => {
                setProjectMenu(null);
                setPendingDeleteProject(project);
              }}
            />
          );
        })()}

      <ConfirmDialog
        open={pendingDeleteChat !== null}
        title={t("Delete chat")}
        description={
          pendingDeleteChat
            ? t("Delete \"{title}\"? This cannot be undone.", {
                title: pendingDeleteChat.title,
              })
            : ""
        }
        error={pendingDeleteChat ? error : null}
        pending={
          pendingDeleteChat !== null && deletingChatId === pendingDeleteChat.id
        }
        onCancel={() => {
          if (deletingChatId) return;
          setPendingDeleteChat(null);
        }}
        onConfirm={() => void handleDeleteChat()}
        testId="sidebar-delete-chat-dialog"
      />
      <ConfirmDialog
        open={pendingDeleteProject !== null}
        title={t("Delete project")}
        description={
          pendingDeleteProject
            ? t(
                "Delete project \"{name}\"? Its chats will stay as chats without a project.",
                { name: pendingDeleteProject.name },
              )
            : ""
        }
        confirmLabel={t("Delete project")}
        pending={
          pendingDeleteProject !== null &&
          deletingProjectId === pendingDeleteProject.id
        }
        onCancel={() => {
          if (deletingProjectId) return;
          setPendingDeleteProject(null);
        }}
        onConfirm={() => {
          if (!pendingDeleteProject) return;
          void removeProject(pendingDeleteProject.id).catch(() => {
            // 横幅已写 projectError
          });
        }}
        testId="sidebar-delete-project-dialog"
      />
      <CreateProjectModal
        open={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onCreate={handleCreateProject}
      />
      {editingProjectId &&
        (() => {
          const project = projects.find((item) => item.id === editingProjectId);
          if (!project) return null;
          return (
            <CreateProjectModal
              open
              mode="edit"
              initial={{
                name: project.name,
                sourceFolders: project.sourceFolders ?? [],
              }}
              onClose={() => setEditingProjectId(null)}
              onCreate={(input) => handleUpdateProject(project.id, input)}
              onDelete={() => removeProject(project.id)}
            />
          );
        })()}
    </div>
  );
}

// Re-export for callers that still import the type from here.
export type { LocalChat, LocalChatAgent };
