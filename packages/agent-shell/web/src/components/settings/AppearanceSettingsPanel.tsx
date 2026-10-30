import { useEffect, useState } from 'react';
import {
  THINKING_DISPLAY_OPTIONS,
  persistThinkingDisplay,
  useThinkingDisplay,
} from '@/lib/show-thinking-content';
import { getHostBridge } from '@/lib/host-bridge';
import { localeEndonym, supportedLocales, useI18n } from '@/i18n';

function stepZoom(scale: number, direction: -1 | 1): number {
  const snapped = Math.round(scale * 10) / 10;
  const next = Math.round((snapped + direction * 0.1) * 10) / 10;
  return Math.min(2, Math.max(0.8, next));
}

function InterfaceZoomRow() {
  const { t } = useI18n();
  const [scale, setScale] = useState<number | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const zoom = getHostBridge();
    if (!zoom?.getZoom) return;
    setAvailable(true);
    let active = true;
    void zoom.getZoom().then((next) => {
      if (active) setScale(next);
    });
    const off = zoom.onZoomChanged?.((payload) => setScale(payload.scale));
    return () => {
      active = false;
      off?.();
    };
  }, []);

  if (!available || scale == null) return null;
  const percent = Math.round(scale * 100);
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-agent-md border border-agent-border bg-agent-card p-2.5"
      data-testid="interface-zoom"
    >
      <div>
        <p className="text-xs font-medium text-agent-foreground">{t('Interface zoom')}</p>
        <p className="mt-1 text-xs text-agent-muted-foreground" data-testid="interface-zoom-level">
          {percent}%
        </p>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="h-7 w-7 rounded-full border border-agent-border text-sm text-agent-foreground disabled:opacity-30"
          aria-label={t('Zoom out')}
          data-testid="interface-zoom-out"
          disabled={percent <= 80}
          onClick={() => {
            const next = stepZoom(scale, -1);
            setScale(next);
            void getHostBridge()?.setZoom?.(next);
          }}
        >
          −
        </button>
        <button
          type="button"
          className="h-7 w-7 rounded-full border border-agent-border text-sm text-agent-foreground disabled:opacity-30"
          aria-label={t('Zoom in')}
          data-testid="interface-zoom-in"
          disabled={percent >= 200}
          onClick={() => {
            const next = stepZoom(scale, 1);
            setScale(next);
            void getHostBridge()?.setZoom?.(next);
          }}
        >
          +
        </button>
        <button
          type="button"
          className="h-7 rounded-full border border-agent-border px-2 text-xs text-agent-foreground"
          data-testid="interface-zoom-reset"
          onClick={() => {
            setScale(1);
            void getHostBridge()?.setZoom?.(1);
          }}
        >
          {t('Reset')}
        </button>
      </div>
    </div>
  );
}

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
      <InterfaceZoomRow />
    </div>
  );
}
