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
import { getHostBridge, type AskUserPromptRequest } from '@/lib/host-bridge';
import { bindPromptToActiveChat, promptVisibleInChat } from './prompt-chat-scope';

type AnswerValue = string | string[];

interface AskUserPromptContextValue {
  queue: AskUserPromptRequest[];
  answer: (requestId: string, answers: Record<string, AnswerValue>) => void;
}

interface AskUserPromptView {
  current: AskUserPromptRequest | null;
  pendingCount: number;
  answer: (answers: Record<string, AnswerValue>) => void;
}

const AskUserPromptContext = createContext<AskUserPromptContextValue | null>(null);

/**
 * Keeps structured user prompts alive across chat navigation. Each composer
 * presents only the prompt that belongs to its chat.
 */
export function AskUserPromptProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<AskUserPromptRequest[]>([]);
  const answeredRequestIds = useRef(new Set<string>());

  useEffect(() => {
    const bridge = getHostBridge();
    if (!bridge?.askUser) return;
    let active = true;
    const addRequests = (
      requests: AskUserPromptRequest[],
      placement: 'append' | 'prepend' = 'append',
    ) => {
      setQueue((previous) => {
        const known = new Set(previous.map(({ requestId }) => requestId));
        const additions = requests
          .filter(
            ({ requestId }) =>
              !known.has(requestId) && !answeredRequestIds.current.has(requestId),
          )
          .map(bindPromptToActiveChat);
        if (additions.length === 0) return previous;
        return placement === 'prepend'
          ? [...additions, ...previous]
          : [...previous, ...additions];
      });
    };
    const unsubscribe = bridge.askUser.onRequest((request) => {
      addRequests([request]);
    });
    void bridge.askUser
      .pending()
      .then((requests) => {
        if (active) addRequests(requests, 'prepend');
      })
      .catch((error) => {
        console.error('Failed to restore pending questions:', error);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const answer = useCallback(
    (requestId: string, answers: Record<string, AnswerValue>) => {
      const bridge = getHostBridge();
      answeredRequestIds.current.add(requestId);
      setQueue((previous) => previous.filter((request) => request.requestId !== requestId));
      void bridge?.askUser?.answer({ requestId, answers });
    },
    [],
  );

  const value = useMemo(
    () => ({
      queue,
      answer,
    }),
    [answer, queue],
  );

  return (
    <AskUserPromptContext.Provider value={value}>
      {children}
    </AskUserPromptContext.Provider>
  );
}

/** Returns the structured prompt for this composer’s chat, if one is waiting. */
export function useAskUserPrompt(chatId?: string | null): AskUserPromptView | null {
  const context = useContext(AskUserPromptContext);
  return useMemo(() => {
    if (!context) return null;
    const mine = context.queue.filter((request) => promptVisibleInChat(request, chatId));
    const current = mine[0] ?? null;
    return {
      current,
      pendingCount: Math.max(0, mine.length - 1),
      answer: (answers) => {
        if (!current) return;
        context.answer(current.requestId, answers);
      },
    };
  }, [chatId, context]);
}

/** 返回存在未处理提问（需要用户回答）的会话 ID 集合。 */
export function usePendingAskUserChatIds(): Set<string> {
  const context = useContext(AskUserPromptContext);
  return useMemo(() => {
    if (!context) return new Set();
    const set = new Set<string>();
    for (const request of context.queue) {
      if (request.chatId) set.add(request.chatId);
    }
    return set;
  }, [context?.queue]);
}

