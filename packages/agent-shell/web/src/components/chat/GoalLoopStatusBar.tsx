import { useState } from 'react';
import { LuCirclePause, LuPlay, LuRepeat2, LuSquare, LuTarget, LuTrash2 } from 'react-icons/lu';

import { t } from '@/i18n';
import {
  stopChatLoop,
  updateChatGoal,
  type LocalGoal,
  type LocalMonitoredLoop,
} from '@/lib/local-api';

export interface GoalLoopStatusBarProps {
  chatId: string;
  goal: LocalGoal | null;
  loops: LocalMonitoredLoop[];
  onChanged: () => void;
}

/** Compact native status for the goal and monitored PTY loops in this chat. */
export function GoalLoopStatusBar({
  chatId,
  goal,
  loops = [],
  onChanged,
}: GoalLoopStatusBarProps) {
  const [busy, setBusy] = useState(false);
  const visibleGoal = goal?.phase === 'complete' ? null : goal;
  if (!visibleGoal && loops.length === 0) return null;

  const goalAction = async (action: 'pause' | 'resume' | 'clear') => {
    setBusy(true);
    try {
      await updateChatGoal(chatId, { action });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const stopLoop = async (id: string) => {
    setBusy(true);
    try {
      await stopChatLoop(chatId, id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-2.5 mb-1 space-y-1 rounded-agent-md border border-agent-border bg-agent-muted/30 px-2.5 py-1.5 text-xs">
      {visibleGoal ? (
        <div className="flex items-center gap-2">
          <LuTarget className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('Goal')} · {visibleGoal.objective} · {goalPhase(visibleGoal)}
          </span>
          {visibleGoal.phase === 'active' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void goalAction('pause')}
              title={t('Pause goal')}
              aria-label={t('Pause goal')}
            >
              <LuCirclePause className="h-3.5 w-3.5" />
            </button>
          ) : visibleGoal.phase === 'paused' || visibleGoal.phase === 'blocked' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void goalAction('resume')}
              title={t('Resume goal')}
              aria-label={t('Resume goal')}
            >
              <LuPlay className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void goalAction('clear')}
            title={t('Clear goal')}
            aria-label={t('Clear goal')}
          >
            <LuTrash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      {loops.map((loop) => (
        <div key={loop.id} className="flex items-center gap-2">
          <LuRepeat2 className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('Loop')} · {loop.prompt} · {t('every {seconds}s', { seconds: loop.intervalSeconds })}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void stopLoop(loop.id)}
            title={t('Stop loop')}
            aria-label={t('Stop loop')}
            className="flex shrink-0 items-center gap-1 rounded-agent-sm border border-agent-border bg-agent-canva px-1.5 py-0.5 font-medium hover:bg-agent-muted disabled:opacity-50"
          >
            <LuSquare className="h-2.5 w-2.5 fill-current" />
            <span>{t('Stop')}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

function goalPhase(goal: LocalGoal): string {
  if (goal.phase === 'active') return t('Turn {turn}', { turn: goal.turns });
  if (goal.phase === 'paused') return t('Paused');
  if (goal.phase === 'blocked') {
    return goal.blockedReason
      ? t('Blocked: {reason}', { reason: goal.blockedReason })
      : t('Blocked');
  }
  return t('Complete');
}
