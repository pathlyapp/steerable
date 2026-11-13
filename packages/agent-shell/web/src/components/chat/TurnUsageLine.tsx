import { t } from '@/i18n';
import { formatTurnTokens, summarizeTurnUsage, type TurnUsage } from './turn-usage';

/**
 * TurnUsageLine — 本回合的账单，一行。**只在这一轮派过子代理时渲染。**
 *
 * 为什么不无条件显示：需求要的是「看得见子代理花了多少」，而一个没派活
 * 的回合把 token 数摆到每条消息下方只是噪音。判据是「这一轮有没有子代理
 * 的花费」，包含「有子代理但报告不出 token」那种——那正是最需要说明的情形。
 *
 * 为什么不显示成本：`stream.done.usage.costUsd` 只估算父级那一份（子代理
 * 按各自 profile 的模型跑，单价不同），拿它当整轮成本会偏低。宁可只报
 * token，也不报一个错的钱。
 */
export function TurnUsageLine({ usage }: { usage?: TurnUsage }) {
  if (!usage) return null;
  const breakdown = summarizeTurnUsage(usage);
  if (!breakdown.hasChildren) return null;
  if (breakdown.totalTokens <= 0) return null;
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 text-[10px] tabular-nums text-[var(--agent-muted-foreground,#6b7280)]"
      data-testid="turn-usage"
    >
      <span>
        {t('This turn {tokens} tokens', { tokens: formatTurnTokens(breakdown.totalTokens) })}
      </span>
      <span data-testid="turn-usage-children">
        {t('· sub-agents {tokens} ({percent}%)', {
          tokens: formatTurnTokens(breakdown.childTokens),
          percent: breakdown.childSharePercent,
        })}
      </span>
      {breakdown.partial ? (
        // 有子代理的引擎不报 token，合计只是下限。不加这句，偏小的数字会
        // 被读成完整账单。
        <span className="italic" data-testid="turn-usage-partial">
          {t('· excludes sub-agents whose engine reports no tokens')}
        </span>
      ) : null}
    </p>
  );
}

export default TurnUsageLine;
