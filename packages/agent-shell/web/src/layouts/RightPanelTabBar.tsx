import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LuPlus, LuTerminal, LuX } from 'react-icons/lu';
import type { PackChatSlotContribution } from '@/packs/registry';
import { t } from '@/i18n';
import { PanelToggleButton } from '@/layouts/PanelToggleButton';
import type { RightPanelTabRecord } from '@/layouts/right-panel-tabs';

/**
 * 右侧栏位的标签条。打开的文档、终端都留在这一行，点标签切换，点 × 关掉那一个。
 * 还没打开的栏位从行尾的加号加进去。最右边的按钮收起整栏。
 */
export function RightPanelTabBar({
  tabs,
  activeTabId,
  slots,
  showTerminal,
  onActivate,
  onClose,
  onOpen,
  onCollapse,
}: {
  tabs: readonly RightPanelTabRecord[];
  activeTabId: string;
  slots: readonly PackChatSlotContribution[];
  showTerminal: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onOpen: (kind: string) => void;
  onCollapse: () => void;
}) {
  const addable = unopenedPanels(tabs, slots, showTerminal);
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-agent-border bg-agent-canvas px-2">
      <div
        role="tablist"
        aria-label={t('Panels')}
        data-testid="right-panel-tabs"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const slot = slots.find((item) => item.slotId === tab.kind);
          const Icon = slot?.Icon ?? (tab.kind === 'terminal' ? LuTerminal : null);
          const selected = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={selected}
              data-testid={`right-panel-tab-${tab.id}`}
              className={`flex h-7 max-w-[11rem] shrink-0 items-center rounded-md pl-1.5 text-xs ${
                selected
                  ? 'bg-agent-foreground/10 font-medium text-agent-foreground'
                  : 'text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground'
              }`}
            >
              <button
                type="button"
                onClick={() => onActivate(tab.id)}
                className="flex min-w-0 items-center gap-1 px-0.5"
                title={tab.title}
              >
                {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
                <span className="truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                aria-label={t('Close {name}', { name: tab.title })}
                title={t('Close {name}', { name: tab.title })}
              >
                <LuX className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {addable.length > 0 && <AddPanelButton entries={addable} onOpen={onOpen} />}
      </div>
      <PanelToggleButton pressed onClick={onCollapse} />
    </div>
  );
}

function AddPanelButton({
  entries,
  onOpen,
}: {
  entries: readonly AddPanelEntry[];
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const button = buttonRef.current;
    if (!open || !button) {
      setBox(null);
      return;
    }
    const update = () => {
      const rect = button.getBoundingClientRect();
      const width = 168;
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      setBox({ top: rect.bottom + 4, left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground"
        title={t('Open {name}', { name: t('Panels') })}
        aria-label={t('Open {name}', { name: t('Panels') })}
        aria-expanded={open}
        data-testid="right-panel-add"
      >
        <LuPlus className="h-3.5 w-3.5" />
      </button>
      {open &&
        box &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[80] w-[168px] rounded-lg border border-agent-border bg-agent-canvas p-1 shadow-lg"
            style={{ top: box.top, left: box.left }}
            data-testid="right-panel-add-menu"
          >
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  onOpen(entry.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground"
                title={entry.detail ?? t('Open {name}', { name: entry.title })}
                aria-label={entry.id === 'terminal' ? t('Terminal') : entry.title}
                data-testid={entry.testId}
              >
                {entry.icon}
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

interface AddPanelEntry {
  id: string;
  title: string;
  testId: string;
  icon: ReactNode;
  detail?: string;
}

function unopenedPanels(
  tabs: readonly RightPanelTabRecord[],
  slots: readonly PackChatSlotContribution[],
  showTerminal: boolean,
): AddPanelEntry[] {
  const entries: AddPanelEntry[] = [];
  for (const slot of slots) {
    if (!slot.multiple && tabs.some((tab) => tab.kind === slot.slotId)) continue;
    const Icon = slot.Icon;
    entries.push({
      id: slot.slotId,
      title: slot.title,
      testId: `header-slot-${slot.slotId}`,
      icon: <Icon className="h-3.5 w-3.5 shrink-0" />,
    });
  }
  if (showTerminal && !tabs.some((tab) => tab.kind === 'terminal')) {
    const shortcut =
      typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
        ? '⌘T'
        : 'Ctrl+T';
    entries.push({
      id: 'terminal',
      title: t('Terminal'),
      testId: 'header-terminal',
      icon: <LuTerminal className="h-3.5 w-3.5 shrink-0" />,
      detail: t('Open terminal panel ({shortcut})', { shortcut }),
    });
  }
  return entries;
}
