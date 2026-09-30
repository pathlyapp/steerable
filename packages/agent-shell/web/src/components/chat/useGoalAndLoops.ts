import { useCallback, useEffect, useState } from 'react';

import {
  getChatGoal,
  listChatLoops,
  type LocalGoal,
  type LocalMonitoredLoop,
} from '@/lib/local-api';
import { getHostBridge, hasHostBridge } from '@/lib/host-bridge';

export interface GoalAndLoopsState {
  goal: LocalGoal | null;
  loops: LocalMonitoredLoop[];
  refreshGoal: () => Promise<void>;
  refreshLoops: () => Promise<void>;
}

/** Native goal state and Cursor-style monitored-loop process state for one chat. */
export function useGoalAndLoops(chatId: string | null): GoalAndLoopsState {
  const [goal, setGoal] = useState<LocalGoal | null>(null);
  const [loops, setLoops] = useState<LocalMonitoredLoop[]>([]);

  const refreshGoal = useCallback(async () => {
    if (!chatId || !hasHostBridge()) {
      setGoal(null);
      return;
    }
    try {
      setGoal((await getChatGoal(chatId)).goal);
    } catch {
      setGoal(null);
    }
  }, [chatId]);

  const refreshLoops = useCallback(async () => {
    if (!chatId || !hasHostBridge()) {
      setLoops([]);
      return;
    }
    try {
      const response = await listChatLoops(chatId);
      setLoops(Array.isArray(response.loops) ? response.loops : []);
    } catch {
      setLoops([]);
    }
  }, [chatId]);

  useEffect(() => {
    void refreshGoal();
    void refreshLoops();
  }, [refreshGoal, refreshLoops]);

  useEffect(() => {
    if (!chatId) return;
    const bridge = getHostBridge();
    const offGoal = bridge?.onPackEvent?.('goal-changed', (value) => {
      const payload = value as { chatId?: string; goal?: LocalGoal | null };
      if (payload.chatId === chatId) setGoal(payload.goal ?? null);
    });
    const offLoop = bridge?.onPackEvent?.('loop-changed', (value) => {
      const payload = value as { chatId?: string; loops?: LocalMonitoredLoop[] };
      if (payload.chatId === chatId) setLoops(payload.loops ?? []);
    });
    return () => {
      offGoal?.();
      offLoop?.();
    };
  }, [chatId]);

  return { goal, loops, refreshGoal, refreshLoops };
}
