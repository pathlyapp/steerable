export interface UsageTotals {
  turns?: number;
  totalTokens?: number;
  costUsd?: number;
}

/** One status line from `GET /api/v2/usage/summary`. */
export function formatUsage(data: { totals?: UsageTotals } | null | undefined): string {
  const totals = data?.totals ?? {};
  const turns = numberOf(totals.turns);
  const tokens = numberOf(totals.totalTokens);
  const cost = typeof totals.costUsd === 'number' && Number.isFinite(totals.costUsd)
    ? ` · $${totals.costUsd.toFixed(2)}`
    : '';
  return `用量 ${turns} 回合 · ${tokens} token${cost}`;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
