import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  getHostBridge,
  type ApprovalDecisionKind,
  type ApprovalPromptRequest,
} from '@/lib/host-bridge';
import { bindPromptToActiveChat, promptVisibleInChat } from './prompt-chat-scope';

interface ApprovalPromptContextValue {
  queue: ApprovalPromptRequest[];
  decide: (requestId: string, kind: ApprovalDecisionKind) => void;
}

interface ApprovalPromptView {
  current: ApprovalPromptRequest | null;
  pendingCount: number;
  decide: (kind: ApprovalDecisionKind) => void;
}

const ApprovalPromptContext = createContext<ApprovalPromptContextValue | null>(null);

/**
 * Keeps approval prompts alive across chat navigation. Each composer
 * presents only the prompt that belongs to its chat.
 */
export function ApprovalPromptProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ApprovalPromptRequest[]>([]);
  const decidedRequestIds = useRef(new Set<string>());

  useEffect(() => {
    const bridge = getHostBridge();
    if (!bridge?.approval) return;
    let active = true;
    const addRequests = (
      requests: ApprovalPromptRequest[],
      placement: 'append' | 'prepend' = 'append',
    ) => {
      setQueue((previous) => {
        const known = new Set(previous.map(({ requestId }) => requestId));
        const additions = requests
          .filter(
            ({ requestId }) =>
              !known.has(requestId) && !decidedRequestIds.current.has(requestId),
          )
          .map(bindPromptToActiveChat);
        if (additions.length === 0) return previous;
        return placement === 'prepend'
          ? [...additions, ...previous]
          : [...previous, ...additions];
      });
    };
    const unsubscribe = bridge.approval.onRequest((request) => {
      addRequests([request]);
    });
    void bridge.approval
      .pending()
      .then((requests) => {
        if (active) addRequests(requests, 'prepend');
      })
      .catch((error) => {
        console.error('Failed to restore pending approval requests:', error);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const decide = useCallback((requestId: string, kind: ApprovalDecisionKind) => {
    const bridge = getHostBridge();
    decidedRequestIds.current.add(requestId);
    setQueue((previous) => previous.filter((request) => request.requestId !== requestId));
    void bridge?.approval?.decide({ requestId, kind });
  }, []);

  const value = useMemo(
    () => ({
      queue,
      decide,
    }),
    [decide, queue],
  );

  return (
    <ApprovalPromptContext.Provider value={value}>
      {children}
    </ApprovalPromptContext.Provider>
  );
}

/** Returns the approval prompt for this composer’s chat, if one is waiting. */
export function useApprovalPrompt(chatId?: string | null): ApprovalPromptView | null {
  const context = useContext(ApprovalPromptContext);
  return useMemo(() => {
    if (!context) return null;
    const mine = context.queue.filter((request) => promptVisibleInChat(request, chatId));
    const current = mine[0] ?? null;
    return {
      current,
      pendingCount: Math.max(0, mine.length - 1),
      decide: (kind) => {
        if (!current) return;
        context.decide(current.requestId, kind);
      },
    };
  }, [chatId, context]);
}

/** 返回存在未处理工具权限审批的会话 ID 集合。 */
export function usePendingApprovalChatIds(): Set<string> {
  const context = useContext(ApprovalPromptContext);
  return useMemo(() => {
    if (!context) return new Set();
    const set = new Set<string>();
    for (const request of context.queue) {
      if (request.chatId) set.add(request.chatId);
    }
    return set;
  }, [context?.queue]);
}
