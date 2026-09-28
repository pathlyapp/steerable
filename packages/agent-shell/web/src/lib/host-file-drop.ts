/**
 * Tauri consumes OS file drags before they become HTML5 drop events.
 * The webview reports paths through `onDragDropEvent` instead.
 *
 * macOS labels AppKit points as a physical position. Windows reports device
 * pixels. Checking both against the composer rectangle accepts the drop on
 * either scale.
 */
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';

export interface HostFileDrop {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
  x?: number;
  y?: number;
}

export function hostFileDropAvailable(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ != null;
}

export function dropPointHitsRect(
  position: { x: number; y: number },
  rect: { left: number; right: number; top: number; bottom: number },
  devicePixelRatio: number,
): boolean {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return (
    contains(rect, position.x, position.y) ||
    contains(rect, position.x / scale, position.y / scale)
  );
}

/** Subscribe while a composer is mounted. The returned function removes it. */
export function listenHostFileDrop(onEvent: (event: HostFileDrop) => void): () => void {
  if (!hostFileDropAvailable()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  const pending = getCurrentWebview().onDragDropEvent((event) => {
    onEvent(hostFileDropFrom(event.payload));
  });
  void pending.then((stop) => {
    if (cancelled) stop();
    else unlisten = stop;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

function contains(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function hostFileDropFrom(payload: DragDropEvent): HostFileDrop {
  if (payload.type === 'leave') return { type: 'leave', paths: [] };
  return {
    type: payload.type,
    paths: payload.type === 'over' ? [] : payload.paths,
    x: payload.position.x,
    y: payload.position.y,
  };
}
