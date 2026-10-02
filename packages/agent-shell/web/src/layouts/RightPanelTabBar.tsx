import { LuTerminal, LuX } from 'react-icons/lu';
import type { PackChatSlotContribution } from '@/packs/registry';
import { t } from '@/i18n';

/**
 * 右侧栏位的标签条。打开的文档、终端都留在这一行，点标签切换，点 × 关掉那一个。
 */
export function RightPanelTabBar({
  tabs,
  active,
  slots,
  onActivate,
  onClose,
}: {
  tabs: readonly string[];
  active: string;
  slots: readonly PackChatSlotContribution[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={t('Panels')}
      data-testid="right-panel-tabs"
      className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-agent-border bg-agent-canvas px-2"
    >
      {tabs.map((id) => {
        const slot = slots.find((item) => item.slotId === id);
        const title = slot?.title ?? (id === 'terminal' ? t('Terminal') : id);
        const Icon = slot?.Icon ?? (id === 'terminal' ? LuTerminal : null);
        const selected = id === active;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={selected}
            data-testid={`right-panel-tab-${id}`}
            className={`flex h-7 max-w-[11rem] shrink-0 items-center rounded-md pl-1.5 text-xs ${
              selected
                ? 'bg-agent-foreground/10 font-medium text-agent-foreground'
                : 'text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground'
            }`}
          >
            <button
              type="button"
              onClick={() => onActivate(id)}
              className="flex min-w-0 items-center gap-1 px-0.5"
              title={title}
            >
              {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
              <span className="truncate">{title}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(id)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
              aria-label={t('Close {name}', { name: title })}
              title={t('Close {name}', { name: title })}
            >
              <LuX className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
