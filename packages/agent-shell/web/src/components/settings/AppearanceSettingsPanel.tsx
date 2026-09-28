import {
  THINKING_DISPLAY_OPTIONS,
  persistThinkingDisplay,
  useThinkingDisplay,
} from '@/lib/show-thinking-content';
import { localeEndonym, supportedLocales, useI18n } from '@/i18n';

/**
 * 界面偏好：思考过程正文按「隐藏 / 显示5行 / 完整显示」三档。
 * 产品声明了多于一种语言时，在这里切换。立即写入 localStorage。
 */
export function AppearanceSettingsPanel() {
  const { t, locale, setLocale } = useI18n();
  const mode = useThinkingDisplay();
  const current = THINKING_DISPLAY_OPTIONS.find((item) => item.mode === mode);
  const locales = supportedLocales();

  return (
    <div className="space-y-2">
      {locales.length > 1 ? (
        <div
          className="space-y-2 rounded-agent-md border border-agent-border bg-agent-card p-2.5"
          data-testid="locale-settings"
        >
          <p className="text-xs font-medium text-agent-foreground">{t('Language')}</p>
          <div
            className="flex w-full rounded-full border border-agent-border bg-agent-canvas p-0.5"
            role="radiogroup"
            aria-label={t('Language')}
            data-testid="locale-toggle"
          >
            {locales.map((item) => {
              const selected = locale === item;
              return (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`locale-option-${item}`}
                  onClick={() => setLocale(item)}
                  className={[
                    'h-7 flex-1 rounded-full px-2 text-xs transition-colors',
                    selected
                      ? 'bg-agent-foreground/10 text-agent-foreground'
                      : 'text-agent-muted-foreground hover:text-agent-foreground',
                  ].join(' ')}
                >
                  {localeEndonym(item)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div
        className="space-y-2 rounded-agent-md border border-agent-border bg-agent-card p-2.5"
        data-testid="appearance-settings-panel"
      >
        <div>
          <p className="text-xs font-medium text-agent-foreground">{t('Show thinking')}</p>
          <p className="mt-1 text-xs leading-relaxed text-agent-muted-foreground">
            {current ? t(current.hint) : null}{' '}
            {t(
              'These options only control the thinking text. Tool cards and work rows stay as they are. A work row shows "Working", or the count and elapsed time after it finishes.',
            )}
          </p>
        </div>
        <div
          className="flex w-full rounded-full border border-agent-border bg-agent-canvas p-0.5"
          role="radiogroup"
          aria-label={t('Show thinking')}
          data-testid="thinking-display-toggle"
        >
          {THINKING_DISPLAY_OPTIONS.map((item) => {
            const selected = mode === item.mode;
            return (
              <button
                key={item.mode}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(item.label)}
                data-testid={`thinking-display-${item.mode}`}
                onClick={() => persistThinkingDisplay(item.mode)}
                className={[
                  'h-7 flex-1 rounded-full px-2 text-xs transition-colors',
                  selected
                    ? 'bg-agent-foreground/10 text-agent-foreground'
                    : 'text-agent-muted-foreground hover:text-agent-foreground',
                ].join(' ')}
              >
                {t(item.label)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
