import { LuGitFork } from 'react-icons/lu';
import { useOrchestrationSetting } from '@/lib/orchestration-settings';
import { t } from '@/i18n';

/**
 * OrchestrationSettingsPanel — 多智能体协同编排设置面板。
 * 默认开启。用户可手动关闭或再次开启，变更实时持久化并影响后续对话请求。
 */
export function OrchestrationSettingsPanel() {
  const [enabled, setEnabled] = useOrchestrationSetting();

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
            onClick={() => setEnabled(true)}
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
            onClick={() => setEnabled(false)}
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
    </div>
  );
}

export default OrchestrationSettingsPanel;
