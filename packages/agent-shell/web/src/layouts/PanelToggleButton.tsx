import { LuCopy } from 'react-icons/lu';
import { t } from '@/i18n';

/**
 * 右侧整栏的开关。栏关着时放在对话标题栏，栏开着时放到右侧标签条最右，点一下收起。
 */
export function PanelToggleButton({
  pressed,
  onClick,
}: {
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground ${
        pressed
          ? 'bg-agent-foreground/10 text-agent-foreground'
          : 'text-agent-muted-foreground'
      }`}
      title={
        pressed
          ? t('Close {name}', { name: t('Panels') })
          : t('Open {name}', { name: t('Panels') })
      }
      aria-label={t('Panels')}
      aria-pressed={pressed}
      data-testid="header-chat-panels"
    >
      <LuCopy className="h-4 w-4" />
    </button>
  );
}
