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
 *   │  v 📁 项目A          (hover: ✎··)│ ← ✎ 新建对话；·· 菜单：重命名/换目录/访达/删
 *   │   ...（项目内对话）              │
 *   │   今天                          │
 *   │   ...（无项目对话，按日期分组）  │ ← 无项目排在项目分组之后
 *   ├─────────────────────────────────┤
 *   │ ⚙ 设置                   v0.2.2 │ ← /settings；右侧是当前版本，检查更新在设置页
 *   └─────────────────────────────────┘
 *
 * 项目模式：项目 = 名字 + 托管家目录（Documents/<应用名>/<项目名>/）+
 * 可选源文件夹。写入/命令围栏在家目录；源文件夹只放宽读取。
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
import { getElectronBridge, isElectron } from "@/lib/electron-bridge";
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
import { useProjects } from "@/hooks/useProjects";
import type { RightPanelState } from "@/layouts/AgentLayout";
import { BrandLockup } from "@/components/BrandLockup";
import {
  SidebarVersionLabel,
  useAppRelease,
} from "@/components/SidebarRelease";
import { CreateProjectModal } from "@/components/CreateProjectModal";

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
  confirmDelete,
  deleting,
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
  confirmDelete: boolean;
  deleting: boolean;
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
            {chatCount} 个会话
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
          title="重命名项目"
          onClick={onRename}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuPencil className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          重命名
        </button>
        <button
          type="button"
          role="menuitem"
          title="编辑项目"
          onClick={onChangeFolder}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuFolderOpen className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          编辑项目
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
          disabled={deleting}
          title={
            confirmDelete
              ? "再次点击确认删除（会话会保留为无项目对话）"
              : "删除项目（会话保留为无项目对话）"
          }
          onClick={onDelete}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-agent-destructive/10 ${
            confirmDelete ? "text-agent-destructive" : "text-agent-foreground"
          }`}
        >
          <LuTrash2 className={`h-3.5 w-3.5 shrink-0 ${deleting ? "animate-pulse" : ""}`} />
          {confirmDelete ? "再次点击确认删除" : "删除项目"}
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
  const bridge = getElectronBridge();
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
  const [confirmDeleteChatId, setConfirmDeleteChatId] = useState<string | null>(
    null,
  );
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
    if (backgroundIds.length === 0 || !isElectron()) return;

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
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(
    null,
  );
  const [renamingValue, setRenamingValue] = useState("");
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<
    string | null
  >(null);
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
        setConfirmDeleteProjectId(null);
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

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      // 与会话删除同款两段确认：第一次点击武装红色按钮，第二次才真删。
      if (confirmDeleteProjectId !== projectId) {
        setConfirmDeleteProjectId(projectId);
        return;
      }
      try {
        await removeProject(projectId);
      } catch {
        // 横幅已写 projectError
      }
    },
    [confirmDeleteProjectId, removeProject],
  );

  const closeProjectMenu = useCallback(() => {
    setProjectMenu(null);
    setConfirmDeleteProjectId(null);
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

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

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
          title: displayTitle || "新会话",
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
            priority: getDateGroupPriority(label),
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

  const handleDeleteChat = useCallback(
    async (id: string) => {
      if (deletingChatId === id) return;
      // Two-step confirm — first click arms the red button, second click
      // actually deletes. Matches the cloud sibling exactly so users don't
      // get muscle-memory whiplash.
      if (confirmDeleteChatId !== id) {
        setConfirmDeleteChatId(id);
        return;
      }
      try {
        setDeletingChatId(id);
        const ok = await deleteChat(id);
        if (ok) {
          setConfirmDeleteChatId(null);
          if (id === currentChatId) navigate("/agent");
        }
      } finally {
        setDeletingChatId(null);
      }
    },
    [confirmDeleteChatId, deleteChat, deletingChatId, currentChatId, navigate],
  );

  const handleTogglePinChat = useCallback(
    async (id: string, nextPinned: boolean) => {
      if (pinningChatId === id) return;
      setPinningChatId(id);
      try {
        await setChatPinned(id, nextPinned);
        await refreshChats();
      } catch (err) {
        console.error("切换会话置顶失败:", err);
      } finally {
        setPinningChatId(null);
      }
    },
    [pinningChatId, refreshChats],
  );

  // 单条会话行——无项目日期分组和项目分组共用同一个渲染，避免两份 JSX。
  const renderChatRow = (chat: (typeof normalizedChats)[number]) => {
    const isCurrent = currentChatId === chat.id;
    const isConfirmingDelete = confirmDeleteChatId === chat.id;
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
            setConfirmDeleteChatId(null);
            navigate(`/agent/${chat.id}`);
          }}
          className={[
            "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-200",
            isCurrent
              ? "bg-agent-foreground/10 font-medium text-agent-foreground"
              : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
          ].join(" ")}
          title={
            chat.isAutomation ? `[由自动化触发] ${chat.title}` : chat.title
          }
        >
          {needsUserInput ? (
            <span
              className="flex shrink-0 items-center justify-center text-amber-500 dark:text-amber-400"
              title="有问题需要输入"
              aria-label="等待用户输入"
            >
              <LuCircleHelp className="h-3.5 w-3.5 animate-pulse" />
            </span>
          ) : isStreaming ? (
            <span
              className="flex shrink-0 items-center justify-center text-agent-foreground/70"
              title="正在对话中"
              aria-label="正在生成"
            >
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            </span>
          ) : null}
          {chat.isAutomation && (
            <LuCloudCog
              className="h-3 w-3 shrink-0 text-agent-muted-foreground"
              aria-label="由自动化触发"
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
            isConfirmingDelete
              ? "opacity-100 pointer-events-auto"
              : "opacity-0 group-hover/item:opacity-100 focus-within:opacity-100 pointer-events-none group-hover/item:pointer-events-auto focus-within:pointer-events-auto",
          ].join(" ")}
        >
          {!isConfirmingDelete && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void handleTogglePinChat(chat.id, !chat.isPinned);
              }}
              disabled={isPinning}
              className="flex h-6 w-6 items-center justify-center rounded-full text-agent-foreground/70 transition-all duration-200 hover:bg-agent-foreground/10 hover:text-agent-foreground disabled:cursor-not-allowed"
              title={chat.isPinned ? "取消置顶" : "置顶会话"}
              aria-label={chat.isPinned ? "取消置顶" : "置顶会话"}
              data-testid="sidebar-chat-pin"
            >
              {chat.isPinned ? (
                <RiPushpin2Fill className="h-3.5 w-3.5 text-agent-foreground" />
              ) : (
                <RiPushpin2Line className="h-3.5 w-3.5 text-agent-foreground/75 hover:text-agent-foreground" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleDeleteChat(chat.id);
            }}
            disabled={isDeleting}
            className={[
              "flex h-6 w-6 items-center justify-center rounded-full transition-all duration-200",
              isConfirmingDelete
                ? "bg-agent-destructive/10 text-agent-destructive hover:bg-agent-destructive/20"
                : "text-agent-foreground/70 hover:bg-agent-foreground/10 hover:text-agent-destructive",
              "disabled:cursor-not-allowed disabled:opacity-100",
            ].join(" ")}
            title={isConfirmingDelete ? "再次点击确认删除" : "删除会话"}
            aria-label={isConfirmingDelete ? "再次点击确认删除" : "删除会话"}
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

  // Auto-load next page when the chat scroller approaches the bottom.
  // Throttled by `isLoadingMoreChats` inside the hook.
  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;

    const maybeLoadMore = () => {
      if (!hasMoreChats || isLoadingMoreChats) return;
      const nearBottom =
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - 60;
      if (nearBottom) void loadMoreChats();
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
  ]);

  const hasElectron = isElectron();

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
            title="收起侧边栏"
            aria-label="收起侧边栏"
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
            title="新建对话"
            data-testid="sidebar-new-chat"
          >
            <LuSquarePen className="h-3.5 w-3.5" />
            <span>新对话</span>
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
            title="插件"
            data-testid="sidebar-plugins"
          >
            <LuBlocks className="h-3.5 w-3.5" />
            <span>插件</span>
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
              加载中...
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
                    <span>置顶</span>
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
                      <span>项目</span>
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
                        title="新建项目"
                        aria-label="新建项目"
                      >
                        <LuFolderPlus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {isProjectsExpanded && (
                    <div className="space-y-0.5">
                      {projectGroups.length === 0 ? (
                        <div className="px-2.5 py-1 text-[11px] text-agent-muted-foreground/60">
                          暂无项目
                        </div>
                      ) : (
                        projectGroups.map(({ project, items }) => (
                          <div key={project.id} className="mb-1">
                            <div className="group/proj relative">
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
                                    onClick={() => toggleProjectCollapsed(project.id)}
                                    className="flex w-full min-w-0 items-center px-2 pb-0.5 pt-1 text-[11px] font-medium text-agent-muted-foreground/90 transition-colors hover:text-agent-foreground"
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
                                        ? "opacity-100"
                                        : "opacity-0 group-hover/proj:opacity-100"
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => handleOpenNewChat(project.id)}
                                      className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                                      title="在此项目下新建对话"
                                    >
                                      <LuSquarePen className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label="项目菜单"
                                      aria-expanded={projectMenu?.id === project.id}
                                      onClick={(event) => {
                                        const button = event.currentTarget;
                                        setConfirmDeleteProjectId(null);
                                        setProjectMenu((current) =>
                                          current?.id === project.id
                                            ? null
                                            : { id: project.id, anchor: button },
                                        );
                                      }}
                                      className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                                      title="项目菜单"
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
                                    暂无会话 — hover 项目名点 + 新建
                                  </div>
                                ) : (
                                  items.map((chat) => renderChatRow(chat))
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
                    <span>最近</span>
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
                      title="新对话"
                      aria-label="新对话"
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
                          暂无会话
                        </div>
                      ) : (
                        <div className="px-2.5 py-1 text-[11px] text-agent-muted-foreground/60">
                          暂无会话
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
                  加载更多...
                </span>
              ) : hasMoreChats ? (
                "继续下滑加载更多"
              ) : (
                `共 ${normalizedChats.length} 个会话`
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
          title="设置"
          data-testid="sidebar-llm-settings"
        >
          <LuSettings className="h-3.5 w-3.5" />
          <span>设置</span>
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
              revealLabel={isMac ? "在访达中显示" : "在文件管理器中显示"}
              confirmDelete={confirmDeleteProjectId === project.id}
              deleting={deletingProjectId === project.id}
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
              onDelete={() => void handleDeleteProject(project.id)}
            />
          );
        })()}

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
