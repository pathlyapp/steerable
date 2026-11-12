import React from 'react';
import { t } from '@/i18n';

export interface SettingsNavItem {
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

export function SettingsNavMenu({
  items,
  activeId,
  onSelect,
}: {
  items: SettingsNavItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <aside
      className="sticky top-0 h-fit w-44 shrink-0 py-1 select-none"
      data-testid="settings-side-nav"
      aria-label={t('Settings section navigation')}
    >
      <div className="mb-2 px-2.5 text-[11px] font-semibold tracking-wider text-agent-muted-foreground uppercase">
        {t('Settings navigation')}
      </div>
      <nav className="space-y-0.5">
        {items.map((item) => {
          const isActive = activeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`settings-nav-item-${item.id}`}
              onClick={() => onSelect(item.id)}
              className={[
                'flex w-full items-center gap-2 rounded-agent-sm px-2.5 py-1.5 text-left text-xs transition-colors',
                isActive
                  ? 'bg-agent-foreground/10 font-semibold text-agent-foreground'
                  : 'text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground',
              ].join(' ')}
            >
              <item.Icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-agent-foreground' : 'text-agent-muted-foreground'}`} />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

export default SettingsNavMenu;
