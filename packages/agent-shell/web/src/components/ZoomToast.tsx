import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import { getHostBridge } from '@/lib/host-bridge';

const TOAST_MS = 1500;

/**
 * Desktop zoom level, centered at the top of the window.
 * Shown after each zoom change, then hidden. Absent when the host has no zoom.
 */
export function ZoomToast() {
  const [scale, setScale] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const bridge = getHostBridge();
    if (!bridge?.onZoomChanged) return;
    let timer = 0;
    const off = bridge.onZoomChanged(({ scale: next }) => {
      setScale(next);
      setVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), TOAST_MS);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

  if (!visible || scale == null) return null;
  const percent = Math.round(scale * 100);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center">
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-agent-border bg-agent-canvas/95 px-3 py-1 text-xs text-agent-foreground shadow-sm"
        data-testid="zoom-toast"
      >
        <span>{percent}%</span>
        <button
          type="button"
          className="text-agent-muted-foreground hover:text-agent-foreground"
          onClick={() => {
            void getHostBridge()?.setZoom?.(1);
          }}
        >
          {t('Reset')}
        </button>
      </div>
    </div>
  );
}
