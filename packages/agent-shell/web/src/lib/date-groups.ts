/**
 * Date-group helpers used by AgentSidebar to label chat groups
 * ("Today" / "Yesterday" / "N days ago" / "M/D" / "M/D/YYYY"). Lifted from
 * `deeppath/apps/web/src/app/agent/AgentSidebar.tsx` so the visual
 * grouping stays in lockstep.
 *
 * priority is used for ordering groups: smaller = newer = listed first.
 * 标签走 t()，排序只看日期，不解析标签文本。
 */
import { t } from '@/i18n';

function dayBuckets(date: Date): { diffDays: number; target: Date; today: Date } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const diffDays =
    (today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24);
  return { diffDays, target, today };
}

export function getDateGroupLabel(date: Date): string {
  const { diffDays, target, today } = dayBuckets(date);
  if (diffDays === 0) return t('Today');
  if (diffDays === 1) return t('Yesterday');
  if (diffDays < 4) return t('{count} days ago', { count: Math.floor(diffDays) });
  const month = target.getMonth() + 1;
  const day = target.getDate();
  if (target.getFullYear() !== today.getFullYear()) {
    return t('{month}/{day}/{year}', { year: target.getFullYear(), month, day });
  }
  return t('{month}/{day}', { month, day });
}

export function getDateGroupPriority(date: Date): number {
  const { diffDays, target, today } = dayBuckets(date);
  if (diffDays === 0) return 1;
  if (diffDays === 1) return 2;
  if (diffDays < 4) return 2 + Math.floor(diffDays);
  if (target.getFullYear() !== today.getFullYear()) return 1000;
  return 100;
}
