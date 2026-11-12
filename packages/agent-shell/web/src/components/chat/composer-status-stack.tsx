import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ComposerStatusPanelId = 'orchestration' | 'todos';

type ComposerStatusContextValue = {
  activeId: ComposerStatusPanelId | null;
  claim: (id: ComposerStatusPanelId, force: boolean) => void;
  release: (id: ComposerStatusPanelId) => void;
};

const ComposerStatusContext = createContext<ComposerStatusContextValue | null>(null);

/**
 * Right-aligned column for the composer status pills (orchestration + todos).
 * At most one panel is expanded; a user click steals the open slot, while an
 * automatic open only claims it when nothing else is showing.
 */
export function ComposerStatusStack({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<ComposerStatusPanelId | null>(null);
  const claim = useCallback((id: ComposerStatusPanelId, force: boolean) => {
    setActiveId((current) => {
      if (force || current == null || current === id) return id;
      return current;
    });
  }, []);
  const release = useCallback((id: ComposerStatusPanelId) => {
    setActiveId((current) => (current === id ? null : current));
  }, []);
  const value = useMemo(
    () => ({ activeId, claim, release }),
    [activeId, claim, release],
  );

  return (
    <ComposerStatusContext.Provider value={value}>
      <div
        className="flex min-w-0 flex-col items-end gap-1.5"
        data-testid="composer-status-stack"
      >
        {children}
      </div>
    </ComposerStatusContext.Provider>
  );
}

/**
 * Fold a panel's own open preference into the stack.
 * Outside a stack, `expanded` follows `desired` directly.
 */
export function useExclusiveExpand(
  id: ComposerStatusPanelId,
  desired: boolean,
): { expanded: boolean; requestOpen: () => void } {
  const ctx = useContext(ComposerStatusContext);
  const wasDesired = useRef(false);

  useLayoutEffect(() => {
    if (!ctx) return;
    if (desired && !wasDesired.current) ctx.claim(id, false);
    if (!desired && wasDesired.current) ctx.release(id);
    wasDesired.current = desired;
  }, [ctx, desired, id]);

  const requestOpen = useCallback(() => {
    ctx?.claim(id, true);
  }, [ctx, id]);

  const expanded = ctx ? desired && ctx.activeId === id : desired;
  return { expanded, requestOpen };
}
