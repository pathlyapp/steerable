import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { t } from '@/i18n';

/**
 * RetryStatus — "reconnecting" line for a model request that is being retried.
 *
 * The backend retries connection failures on a seconds-scale backoff, so a
 * turn that is working looks identical to one that is stuck. This renders the
 * three facts a waiting user needs: it is retrying, since when, and that Stop
 * still works. The elapsed label appears only after
 * `RETRY_ELAPSED_VISIBLE_MS`, because a sub-10s wait reads as progress while a
 * ticking timer on a short wait reads as a problem.
 */

/** Elapsed seconds are shown from here on: 10s is where a wait needs progress. */
export const RETRY_ELAPSED_VISIBLE_MS = 10_000;

export interface RetryState {
  /** Epoch ms when the first retry of this request started. */
  startedAt: number;
  /** Delay the loop announced for this attempt, for the next tick. */
  delayMs?: number;
}

interface RetryStatusProps {
  /** Live retry state, or undefined once the request is no longer retrying. */
  retry: RetryState;
  /** Injectable clock for tests; real time by default. */
  now?: () => number;
}

/** Seconds waited so far; exported for the label's unit tests. */
export function waitedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** The line's text: bare "reconnecting", then the elapsed count. */
export function retryLabel(startedAt: number, now: number): string {
  const waited = waitedSeconds(startedAt, now);
  if (now - startedAt < RETRY_ELAPSED_VISIBLE_MS) {
    return t('Network unstable, reconnecting…');
  }
  return t('Network unstable, reconnecting… ({seconds}s)', { seconds: waited });
}

export function RetryStatus({ retry, now = Date.now }: RetryStatusProps) {
  const [tick, setTick] = useState(() => now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(now()), 1000);
    return () => window.clearInterval(id);
  }, [now, retry.startedAt]);

  const current = Math.max(tick, retry.startedAt);

  return (
    <motion.div
      key="retry"
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      // `polite` announces the line once when it appears. The elapsed counter
      // updates every second but is not announced again: it is informational,
      // and a per-second announcement would interrupt screen-reader reading.
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="my-2 inline-flex items-center gap-2 text-xs text-agent-warning"
      data-testid="retry-status"
    >
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
      <span>{retryLabel(retry.startedAt, current)}</span>
    </motion.div>
  );
}

export default RetryStatus;
