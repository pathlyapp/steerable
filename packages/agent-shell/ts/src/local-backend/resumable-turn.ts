/**
 * Which turns the `resume` channel may continue.
 *
 * `resume` replays the durable record's projection as the loop seed, so it can
 * only continue a turn the record still ends mid-way through. Three settled
 * states reach this decision, and they are not the same question:
 *
 * - **Interrupted** (W7-1): the process died, so the turn_active marker
 *   survived and no terminal assistant message was written. The user message
 *   is the record's tail; continuing finishes the request that never got an
 *   answer.
 * - **Failed**: the turn's last model request exhausted its retries. The
 *   process is alive and settled the turn, so the marker is gone and the
 *   assistant message carries `completionStatus: 'failed'`. Everything
 *   completed before the failure is in the record — tools included — so
 *   continuing asks the model for the next step without repeating side
 *   effects.
 * - **Cancelled**: the user stopped it. Continuing is allowed for the same
 *   reason as a failure, and deliberately: the usual cause is impatience with
 *   a retry, not a decision to abandon the task.
 *
 * A turn that completed normally is none of these. Resuming it would append a
 * reply the user never asked for, which is why this is a whitelist: an
 * unrecognised state refuses.
 */

/** Why a turn can be continued, as far as the store can tell. */
export type ResumableReason = 'interrupted' | 'failed' | 'cancelled';

export interface ResumableTurnInput {
  /** The `turn_active` marker survived: a turn began and never settled. */
  turnActive: boolean;
  /** A stream for this chat is live in THIS process right now. */
  streamActive: boolean;
  /** Role of the chat's newest persisted message, or null on an empty chat. */
  lastMessageRole: string | null;
  /**
   * `completionStatus` of the last assistant message when the store ends on
   * one. Absent when the newest message is not an assistant reply, or when the
   * metadata predates the field.
   */
  lastAssistantStatus?: string | null;
}

/**
 * Returns why the chat's last turn may be continued, or null when it may not.
 *
 * A live stream always refuses: the turn is running, and a second writer on
 * the same record would interleave two tails.
 */
export function resumableTurn(input: ResumableTurnInput): ResumableReason | null {
  if (input.streamActive) return null;
  if (input.turnActive) {
    // A surviving marker with an assistant tail is the crash-between-write-
    // and-clear window; the reply proves the turn settled, so it is not
    // interrupted — but a failed reply may still be worth continuing.
    return input.lastMessageRole === 'assistant'
      ? statusReason(input.lastAssistantStatus)
      : 'interrupted';
  }
  if (input.lastMessageRole !== 'assistant') return null;
  return statusReason(input.lastAssistantStatus);
}

function statusReason(status: string | null | undefined): ResumableReason | null {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return null;
}
