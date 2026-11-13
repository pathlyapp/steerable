/**
 * Call-order display blocks persisted on assistant message metadata.
 * Keep this JSON compatible with apps/web `turn-timeline.ts`.
 */

export type PersistedTurnBlock =
  | {
      type: 'reasoning';
      content: string;
      sealed?: boolean;
      startedAtMs?: number;
      durationMs?: number;
    }
  | { type: 'text'; content: string; sealed?: boolean }
  | { type: 'tools'; actions: Array<Record<string, unknown>> };

function freezeOpenReasoning(blocks: PersistedTurnBlock[], now = Date.now()): void {
  const last = blocks[blocks.length - 1];
  if (!last || last.type !== 'reasoning' || last.durationMs != null) return;
  if (last.startedAtMs == null) return;
  last.durationMs = Math.max(0, now - last.startedAtMs);
}

export function appendTimelineDelta(
  blocks: PersistedTurnBlock[],
  type: 'text' | 'reasoning',
  delta: string,
  now = Date.now(),
): void {
  if (!delta) return;
  const last = blocks[blocks.length - 1];
  if (last && last.type === type && !last.sealed) {
    last.content += delta;
    return;
  }
  freezeOpenReasoning(blocks, now);
  if (type === 'reasoning') {
    blocks.push({ type, content: delta, startedAtMs: now });
    return;
  }
  blocks.push({ type, content: delta });
}

/**
 * Withdraw a discarded attempt's streamed text and reasoning.
 *
 * A retry after partial output restarts the reply from nothing, so the blocks
 * this attempt produced must not survive into the persisted turn: the retry's
 * own text would otherwise be appended after text the model never finished
 * saying. Tool blocks are kept — a tool call that already ran is a fact, and
 * the retry does not repeat it.
 *
 * @param blocks Timeline to prune in place.
 * @param sinceLength `blocks.length` recorded when the attempt started; only
 *   entries at or after that index are candidates.
 */
export function dropAttemptBlocks(
  blocks: PersistedTurnBlock[],
  sinceLength: number,
): void {
  for (let index = blocks.length - 1; index >= sinceLength; index -= 1) {
    const block = blocks[index];
    if (block && (block.type === 'text' || block.type === 'reasoning')) {
      blocks.splice(index, 1);
    }
  }
}

/**
 * Close the current reasoning/text segment so the next same-kind delta
 * starts a new block. Mirrors apps/web `sealLastBlock`.
 */
export function sealLastTimelineBlock(blocks: PersistedTurnBlock[], now = Date.now()): void {
  const last = blocks[blocks.length - 1];
  if (!last || last.type === 'tools' || last.sealed) return;
  freezeOpenReasoning(blocks, now);
  last.sealed = true;
}

export function freezeTimelineReasoning(blocks: PersistedTurnBlock[], now = Date.now()): void {
  freezeOpenReasoning(blocks, now);
}

export function syncTimelineTools(
  blocks: PersistedTurnBlock[],
  actions: Array<Record<string, unknown>>,
  now = Date.now(),
): void {
  let placed = 0;
  for (const block of blocks) {
    if (block.type === 'tools') placed += block.actions.length;
  }

  let idx = 0;
  for (const block of blocks) {
    if (block.type !== 'tools') continue;
    for (let i = 0; i < block.actions.length; i += 1) {
      if (idx < actions.length) {
        block.actions[i] = actions[idx];
        idx += 1;
      }
    }
  }

  const added = actions.slice(placed);
  if (added.length === 0) return;
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'tools') {
    last.actions.push(...added);
  } else {
    freezeOpenReasoning(blocks, now);
    blocks.push({ type: 'tools', actions: added });
  }
}
