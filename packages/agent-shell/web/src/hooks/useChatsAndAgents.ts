/**
 * `useChatsAndAgents` — sidebar state (paginated chats + agent catalog + the
 * "agent picked for next new chat" selection) for the Agent shell.
 *
 * Wave 1 of the Steerable refactor moved the generic pagination /
 * agent-selection / title-patching machinery into `@steerable/agent-ui/state`
 * as `useChatList<TChat, TAgent>`. This file is now an Electron-flavoured
 * adapter:
 *   - It wires the framework hook to the local-backend transport
 *     (`@/lib/local-api`).
 *   - It gates everything behind `hasHostBridge()` so a renderer running in a
 *     plain browser doesn't fire requests.
 *   - It keeps the legacy `UseChatsAndAgentsResult` shape so callers
 *     (`AgentLayout`, `useChatsAndAgents()` consumers) don't change.
 *
 * Pagination contract (mirrors `deeppath/apps/web` `useChatUI`):
 *   - First mount loads page 1 (50 items).
 *   - AgentSidebar scrolls within its own container and calls `loadMoreChats`
 *     when the user nears the bottom. `isLoadingMoreChats` gates re-entry.
 *   - After a `refreshChats` (e.g. post create/delete), we reset to page 1
 *     and drop any already-loaded pages — keeping the list consistent is
 *     simpler than trying to splice individual pages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useChatList,
  type ChatListTransport,
} from '@steerable/agent-ui/state';
import {
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
  listChatAgents,
  listChats,
  type LocalChat,
  type LocalChatAgent,
} from '@/lib/local-api';
import { hasHostBridge } from '@/lib/host-bridge';
import { pickDefaultAgentId } from '@/brand';

const CHAT_PAGE_SIZE = 50;

export interface UseChatsAndAgentsResult {
  chats: LocalChat[];
  agents: LocalChatAgent[];
  isLoading: boolean;
  error: string | null;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  refreshChats: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  createChat: (input?: { agentId?: string; projectId?: string }) => Promise<string | null>;
  deleteChat: (chatId: string) => Promise<boolean>;
  /**
   * 就地把某个 chat 的 title 改掉（不打后端、不重新拉列表）。
   * 用于 SSE `chat_title_updated` 事件——后端已经写好库了，前端只要
   * 同步内存里的 sidebar 视图就行，免得 refreshChats() 把翻页状态打回 page 1。
   * 找不到 id 时静默忽略。
   */
  patchChatTitle: (chatId: string, title: string) => void;
  /**
   * 就地把某个 chat 的最后更新时间改掉（不打后端、不重新拉已在列表里的会话）。
   * 用于 `chat-activity`：消息落库后侧边栏按这个时间重排。
   * 当前已加载的页里没有这条会话时，退回刷新第一页。
   */
  patchChatUpdatedAt: (chatId: string, updatedAt: string) => void;
  /** True while a `loadMoreChats` call is in flight. */
  isLoadingMoreChats: boolean;
  /** True iff the last list-chats response reported more pages available. */
  hasMoreChats: boolean;
  loadMoreChats: () => Promise<void>;
}

export function useChatsAndAgents(): UseChatsAndAgentsResult {
  const hasHostBridgeRef = useRef(hasHostBridge());

  const transport = useMemo<ChatListTransport<LocalChat, LocalChatAgent>>(
    () => ({
      listChats: async ({ page, pageSize }) => {
        if (!hasHostBridgeRef.current) return { chats: [], hasMore: false };
        const data = await listChats({ page, limit: pageSize });
        return {
          chats: data.chats,
          hasMore: Boolean(data.pagination?.hasMore),
        };
      },
      listAgents: async () => {
        if (!hasHostBridgeRef.current) return [];
        const data = await listChatAgents(false);
        return data.agents;
      },
      createChat: async ({ agentId, projectId }) => {
        if (!hasHostBridgeRef.current) {
          throw new Error('not connected to the host');
        }
        const res = await apiCreateChat({
          ...(agentId ? { agentId } : {}),
          ...(projectId ? { projectId } : {}),
        });
        return res.chatId;
      },
      deleteChat: async (chatId) => {
        if (!hasHostBridgeRef.current) return false;
        await apiDeleteChat(chatId);
        return true;
      },
      getChatId: (c) => c.id,
      setChatTitle: (c, title) => (c.title === title ? c : { ...c, title }),
      getAgentId: (a) => a.id,
    }),
    [],
  );

  const list = useChatList<LocalChat, LocalChatAgent>({
    transport,
    pageSize: CHAT_PAGE_SIZE,
    // The renderer mounts before electron decides whether the bridge is live;
    // skip the auto-fetch and trigger it manually after the SSR no-op check.
    skipInitialLoad: !hasHostBridgeRef.current,
  });

  // Default-select this flavor's builtin expert once the catalog loads.
  // 场景产品默认包的主打专家；无包产品默认 shell 内置智能体。
  useEffect(() => {
    if (list.agents.length === 0) return;
    const current = list.selectedAgentId;
    if (current && list.agents.some((a) => a.id === current)) return;
    const next = pickDefaultAgentId(list.agents);
    if (next) list.setSelectedAgentId(next);
    // We only want this to fire when the catalog identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.agents]);

  // Translate the framework's `Error | null` into the legacy `string | null`.
  const errorStr = useMemo(
    () => (list.error ? list.error.message : null),
    [list.error],
  );
  // Some app-side flows (createChat/deleteChat below) also need to surface a
  // string error without round-tripping through the framework hook. We keep a
  // local override that takes precedence.
  const [localError, setLocalError] = useState<string | null>(null);
  const mergedError = localError ?? errorStr;

  const createChat = useCallback(
    async (input?: { agentId?: string; projectId?: string }) => {
      try {
        const id = await list.createChat(input);
        return id;
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [list],
  );

  // 消息落库后的活动时间。叠在已加载列表上，避免整表刷新把分页打回第一页。
  const [activityAt, setActivityAt] = useState<ReadonlyMap<string, string>>(() => new Map());
  const chats = useMemo(() => {
    if (activityAt.size === 0) return list.chats;
    return list.chats.map((chat) => {
      const next = activityAt.get(chat.id);
      if (!next || chat.updatedAt >= next) return chat;
      return { ...chat, updatedAt: next };
    });
  }, [activityAt, list.chats]);
  useEffect(() => {
    setActivityAt((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [id, stamp] of prev) {
        const chat = list.chats.find((item) => item.id === id);
        if (chat && chat.updatedAt >= stamp) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [list.chats]);
  const patchChatUpdatedAt = useCallback((chatId: string, updatedAt: string) => {
    const known = list.chats.some((chat) => chat.id === chatId);
    setActivityAt((prev) => {
      const current = prev.get(chatId);
      if (current && current >= updatedAt) return prev;
      const next = new Map(prev);
      next.set(chatId, updatedAt);
      return next;
    });
    if (!known) void list.refreshChats();
  }, [list.chats, list.refreshChats]);

  const deleteChat = useCallback(
    async (chatId: string) => {
      try {
        const ok = await list.deleteChat(chatId);
        if (ok) await list.refreshChats();
        return ok;
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [list],
  );

  return {
    chats,
    agents: list.agents,
    isLoading: list.isLoading,
    error: mergedError,
    selectedAgentId: list.selectedAgentId,
    setSelectedAgentId: list.setSelectedAgentId,
    refreshChats: list.refreshChats,
    refreshAgents: list.refreshAgents,
    createChat,
    deleteChat,
    patchChatTitle: list.patchChatTitle,
    patchChatUpdatedAt,
    isLoadingMoreChats: list.isLoadingMoreChats,
    hasMoreChats: list.hasMoreChats,
    loadMoreChats: list.loadMoreChats,
  };
}
