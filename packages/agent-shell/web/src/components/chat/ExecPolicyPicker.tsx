import { useEffect, useRef, useState } from 'react';
import { LuChevronDown, LuFolderLock, LuLockOpen } from 'react-icons/lu';
import type { ExecPolicy } from '@/lib/exec-policy';
import { t } from '@/i18n';

/**
 * ExecPolicyPicker — 输入框上的命令沙箱切换（类 Codex 底部权限档）。
 *
 * 切档立刻记住，下一轮才生效：当前回合的 `execSandbox` 已经随流发出。
 * 工作区 = Seatbelt/bwrap 只允许写项目家目录、源文件夹（含各自子目录）或本对话工作区；完整权限
 * = 不下发命令沙箱，本机路径（如 Downloads）不再被 Operation not permitted 拦住。
 */

const OPTIONS: Array<{
  id: ExecPolicy;
  label: string;
  description: string;
}> = [
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'Can only write to the current workspace. Paths outside it are blocked.',
  },
  {
    id: 'full',
    label: 'Full access',
    description:
      'Turns off the command sandbox so any path on this computer can be written. Tool approvals still apply.',
  },
];

export function ExecPolicyPicker({
  policy,
  disabled,
  onChange,
}: {
  policy: ExecPolicy;
  disabled: boolean;
  onChange: (policy: ExecPolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = OPTIONS.find((option) => option.id === policy) ?? OPTIONS[0];
  const isFull = policy === 'full';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('Command sandbox')}
        data-testid="exec-policy-picker"
        title={t(current.description)}
        onClick={() => setOpen((next) => !next)}
        className={[
          'inline-flex h-6 max-w-[140px] items-center gap-1 rounded-full border px-1.5 text-[12px] leading-[1.45] transition-colors disabled:cursor-not-allowed disabled:opacity-70',
          isFull
            ? 'border-amber-400/50 bg-amber-400/10 text-amber-700 dark:text-amber-400'
            : 'border-agent-border bg-agent-canvas text-agent-foreground hover:bg-agent-foreground/5',
        ].join(' ')}
      >
        {isFull ? (
          <LuLockOpen className="h-3 w-3 shrink-0" />
        ) : (
          <LuFolderLock className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{t(current.label)}</span>
        <LuChevronDown className="h-3 w-3 shrink-0 text-agent-muted-foreground" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t('Command sandbox')}
          className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-agent-md border border-agent-border bg-agent-canvas py-1 shadow-sm"
        >
          {OPTIONS.map((option) => {
            const selected = option.id === policy;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`exec-policy-${option.id}`}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={[
                  'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors',
                  selected
                    ? 'bg-agent-foreground/10'
                    : 'hover:bg-agent-foreground/5',
                ].join(' ')}
              >
                <span className="text-[12px] font-medium leading-[1.45] text-agent-foreground">
                  {t(option.label)}
                </span>
                <span className="text-[11px] leading-snug text-agent-muted-foreground">
                  {t(option.description)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
