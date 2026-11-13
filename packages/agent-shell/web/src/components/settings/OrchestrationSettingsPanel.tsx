import { LuGitFork } from 'react-icons/lu';
import {
  ORCHESTRATION_MAX_DEPTH_RANGE,
  ORCHESTRATION_MAX_PARALLEL_RANGE,
  useOrchestrationLimits,
} from '@/lib/orchestration-settings';
import { t } from '@/i18n';

/**
 * OrchestrationSettingsPanel — 多智能体协同编排设置面板。
 * 默认开启。开关、深度与并发都实时持久化，并随 `metadata.orchestration`
 * 以对象形式下发给后续回合。
 *
 * 深度是权限（子代理能不能再派孙代理），所以它必须能在界面上改；写死 1/4
 * 会让「设置里有这个开关」变成一句空话。
 */
export function OrchestrationSettingsPanel() {
  const [setting, update] = useOrchestrationLimits();
  const enabled = setting.enabled;

  return (
    <div
      className="space-y-2.5 rounded-agent-md border border-agent-border bg-agent-card p-3"
      data-testid="orchestration-settings-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-agent-foreground">
            <LuGitFork className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
            <span>{t('Multi-agent orchestration (Fork-Join)')}</span>
          </div>
          <p className="text-xs leading-relaxed text-agent-muted-foreground">
            {t(
              'Let the main agent spawn subtasks (agent_spawn) to reason in parallel, and show a flow chart and live progress board above the input box.',
            )}
          </p>
        </div>

        {/* 开关 Radio Group / Toggle */}
        <div
          className="flex shrink-0 rounded-full border border-agent-border bg-agent-canvas p-0.5"
          role="radiogroup"
          aria-label={t('Multi-agent orchestration toggle')}
        >
          <button
            type="button"
            role="radio"
            aria-checked={enabled}
            onClick={() => update({ enabled: true })}
            className={[
              'h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors',
              enabled
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 shadow-2xs'
                : 'text-agent-muted-foreground hover:text-agent-foreground',
            ].join(' ')}
          >
            {t('On')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!enabled}
            onClick={() => update({ enabled: false })}
            className={[
              'h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors',
              !enabled
                ? 'bg-agent-foreground/10 text-agent-foreground shadow-2xs'
                : 'text-agent-muted-foreground hover:text-agent-foreground',
            ].join(' ')}
          >
            {t('Off')}
          </button>
        </div>
      </div>

      {/* 编排参数：关掉开关时置灰，值保留（下次打开还是用户调过的）。 */}
      <div className="grid grid-cols-2 gap-2 border-t border-agent-border/60 pt-2">
        <label className={enabled ? 'space-y-1' : 'space-y-1 opacity-50'}>
          <span className="block text-[10px] font-medium text-agent-muted-foreground">
            {t('Max depth')}
          </span>
          <select
            value={setting.maxDepth}
            disabled={!enabled}
            onChange={(event) => update({ maxDepth: Number(event.target.value) })}
            className="h-7 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground disabled:cursor-not-allowed"
            data-testid="orchestration-max-depth"
          >
            {rangeOptions(ORCHESTRATION_MAX_DEPTH_RANGE).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="block text-[10px] leading-snug text-agent-muted-foreground">
            {t('{min}–{max}; above 1 lets sub-agents spawn their own.', {
              min: ORCHESTRATION_MAX_DEPTH_RANGE.min,
              max: ORCHESTRATION_MAX_DEPTH_RANGE.max,
            })}
          </span>
        </label>
        <label className={enabled ? 'space-y-1' : 'space-y-1 opacity-50'}>
          <span className="block text-[10px] font-medium text-agent-muted-foreground">
            {t('Max parallel')}
          </span>
          <select
            value={setting.maxParallel}
            disabled={!enabled}
            onChange={(event) => update({ maxParallel: Number(event.target.value) })}
            className="h-7 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground disabled:cursor-not-allowed"
            data-testid="orchestration-max-parallel"
          >
            {rangeOptions(ORCHESTRATION_MAX_PARALLEL_RANGE).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="block text-[10px] leading-snug text-agent-muted-foreground">
            {t('{min}–{max}; how many sub-agents run at once.', {
              min: ORCHESTRATION_MAX_PARALLEL_RANGE.min,
              max: ORCHESTRATION_MAX_PARALLEL_RANGE.max,
            })}
          </span>
        </label>
      </div>
      {enabled && setting.maxDepth > 1 ? (
        // 深度 >1 是权限扩张，不是普通偏好：说清代价。
        <p className="text-[10px] leading-relaxed text-agent-muted-foreground">
          {t(
            'Allowing children to spawn further sub-agents raises token use and unpredictability with every extra layer.',
          )}
        </p>
      ) : null}
      <p className="text-[10px] text-agent-muted-foreground">
        {t('Taking effect next turn')}
      </p>
    </div>
  );
}

function rangeOptions(range: { min: number; max: number }): number[] {
  return Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i);
}

export default OrchestrationSettingsPanel;
