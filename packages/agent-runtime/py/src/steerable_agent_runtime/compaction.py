"""Context compaction — a ``pre_step`` hook.

Local models often run with small context windows; a few rounds of verbose
tool output can fill them. Check pressure before the request is derived, and when over threshold rewrite
the transcript so the turn can continue.

Strategy (deterministic first, LLM optional):

1. Measure context pressure. Ground truth is the provider-reported prompt
   tokens of the previous request (exposed on ``ctx.last_prompt_tokens``)
   plus a heuristic estimate of the messages appended since; only the first
   round falls back to a full heuristic estimate (CJK-aware, per-model
   calibrated — see ``tokens.py``).
2. Under ``threshold_ratio * max_context_tokens`` → proceed unchanged.
3. Over threshold →
   a. fold old ``tool`` messages (beyond ``keep_last_tool_results``) into a
      one-line placeholder keeping a short excerpt — tool output is the
      usual space hog;
   b. if still over and a summarizer provider is configured, replace the
      middle span (after the head, before the recent tail) with a summary
      message; otherwise drop the middle span behind a marker.

System messages and the first user message (the goal) are always kept; the
most recent ``keep_last_messages`` are never touched, and the kept tail is
widened when that count would cut a tool-call group in half (an orphan
``tool`` message is a provider-level 400). Between compactions
the transcript is append-only, so provider prompt caches keep hitting; a
rewrite invalidates the cache once, then the prefix is stable again.

Three trigger paths share the fold/summarize machinery:

- **pressure** (``pre_step``, above) — the reactive default;
- **overflow recovery** (``on_request_error``) — the heuristic threshold can
  still miss the real window, so a context-overflow error forces one
  compaction pass and retries, bounded per round;
- **micro-compaction** (``pre_step``, opt-in ``micro_compact_interval_rounds``)
  — every N rounds, fold old tool results regardless of pressure (CC
  time-based microcompact parity). Off by default: each fold invalidates the
  prompt-cache prefix, so the interval trades cache hits for a bounded
  transcript;
- **manual** (``compact_now``) — the host-command path (CC ``/compact``
  parity): the host calls the sidecar's ``agent.chat.compact`` RPC, which
  sets ``CoreLoop.request_compact()``; the loop runs ``compact_now`` at the
  next pre_step boundary, folding + summarizing on demand, bypassing
  threshold, hysteresis, and the circuit breaker.

Two safety rails share the machinery:

- Every rewrite carries its ``pre_tokens`` / ``post_tokens`` estimate onto
  the recorded ``CompactionBoundary`` (CC ``compact_boundary`` parity), so
  traces chart compaction effectiveness without re-estimating from bodies.
- A **circuit breaker** (CC auto-compact breaker parity): a pressure
  compaction whose post-estimate is still over threshold counts as
  ineffective; three consecutive ineffective compactions open the circuit
  and the pressure path stops firing — each further rewrite would only
  invalidate the prompt-cache prefix without shrinking the transcript. The
  overflow-recovery path keeps its own per-round bound and stays live, so
  the turn still fails loud (bounded retries, then a named error) instead
  of spinning. A round that lands under threshold — or any successful
  compaction — resets the count.
- A **rapid-refill breaker** (CC parity): a compaction that lands under
  threshold but refills within ``rapid_refill_window_rounds`` rounds of the
  previous one counts as a refill; ``max_rapid_refills`` consecutive
  refills open the same circuit — the transcript is churning faster than
  compaction can help, so further rewrites only kill the prompt cache.
  The tripping round appends a ``CompactionThrashingReminder`` (model- and
  UI-visible) with an actionable converge notice. ``circuit_reason``
  records which breaker tripped.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable
from uuid import uuid4

from .hooks import (
    CompactionBracket,
    NoopHooks,
    PreStepAction,
    RetryAction,
    RewriteRequest,
    TranscriptAppend,
)
from .llm import ImagePart, LLMMessage, LLMProvider, TextPart
from .llm.errors import classify_error
from .reminders import CompactionThrashingReminder
from .tokens import (
    DEFAULT_MAX_REQUEST_BYTES,
    estimate_tokens,
    estimate_wire_bytes,
    resolve_max_request_bytes,
)

_SUMMARY_MARKER = "[context compacted: earlier conversation summarized]"
_FOLDED_TOOL_MARKER = "[tool output folded to save context]"
_OFFLOADED_IMAGE_MARKER = "[image offloaded to save context]"

#: The compaction instruction, appended as the final user message of the
#: summarizer's warm-prefix replay (dsh compaction-basic parity).
_SUMMARY_INSTRUCTION = (
    "Summarize the conversation so far for an agent that needs to continue "
    "the task. Preserve: the user's goal, actions taken, tool outcomes, and "
    "any decisions. Be terse."
)

#: How much of a folded tool result survives as a clue (file paths, error
#: types, key numbers) so the model can still reason about what it saw.
_FOLD_EXCERPT_CHARS = 160

__all__ = ["CompactionHooks", "CompactionJournal", "estimate_tokens"]


@runtime_checkable
class CompactionJournal(Protocol):
    """Write-ahead durable journal for region-transaction brackets (P1/R4).

    ``open_bracket`` persists ``compaction_start`` *before* the paid summarizer
    network call; ``record_summary`` persists ``compaction_summary`` immediately
    after the call returns, before ``CompactionBoundary`` is written.
    """

    async def open_bracket(
        self,
        *,
        compaction_id: str,
        reason: str,
        action: str,
        span_start_index: int,
        span_end_index: int,
        pre_tokens: int | None = None,
    ) -> None: ...

    async def record_summary(
        self,
        *,
        compaction_id: str,
        summary_text: str,
    ) -> None: ...


def _fold_content(content: str | None, excerpt_chars: int = _FOLD_EXCERPT_CHARS) -> str:
    text = content or ""
    if len(text) <= excerpt_chars:
        excerpt = text
    else:
        head = max(excerpt_chars // 5, 1)
        tail = excerpt_chars - head
        omitted = len(text) - excerpt_chars
        excerpt = f"{text[:head]}\n...[{omitted} chars truncated]...\n{text[-tail:]}"
    if excerpt:
        return f"{_FOLDED_TOOL_MARKER} excerpt: {excerpt}"
    return _FOLDED_TOOL_MARKER


def _image_pointer_text(media_type: str, *, note: str | None = None) -> str:
    """The text pointer an offloaded image leaves in the projection (P2).
    The original bytes stay in the durable record; the pointer keeps the
    fact and type of the image visible to the model."""
    suffix = f"; {note}" if note else ""
    return f"{_OFFLOADED_IMAGE_MARKER} ({media_type}{suffix}); original preserved in the record"


def _text_pointer_span(messages: list[LLMMessage]) -> list[LLMMessage]:
    """Image parts → text pointers, for the summarizer replay: a text
    summarizer cannot consume image bytes, and the offload stage writes the
    same pointers into the projection — so the transform converges the
    replay with the next conversation request instead of diverging from
    the cached prefix. Text-only spans pass through untouched (byte-
    identity with the cached prefix is preserved)."""
    if not any(
        isinstance(p, ImagePart) for m in messages for p in m.content
    ):
        return messages
    return [
        LLMMessage(
            role=m.role,
            content=[
                TextPart(text=_image_pointer_text(p.media_type))
                if isinstance(p, ImagePart)
                else p
                for p in m.content
            ],
            name=m.name,
            tool_call_id=m.tool_call_id,
            tool_calls=m.tool_calls,
            reasoning=m.reasoning,
            reasoning_details=m.reasoning_details,
        )
        for m in messages
    ]


_UNSET_BYTES = -1


class CompactionHooks(NoopHooks):
    """``pre_step`` hook: compact the transcript when context or byte pressure is high."""

    def __init__(
        self,
        *,
        max_context_tokens: int,
        threshold_ratio: float = 0.8,
        keep_last_messages: int = 6,
        keep_last_tool_results: int = 2,
        summarizer: LLMProvider | None = None,
        model: str | None = None,
        recompact_margin_ratio: float = 0.1,
        fold_excerpt_chars: int = _FOLD_EXCERPT_CHARS,
        micro_compact_interval_rounds: int = 0,
        rapid_refill_window_rounds: int = 3,
        max_rapid_refills: int = 3,
        image_offload: bool = True,
        keep_last_images: int = 1,
        max_request_bytes: int | None = _UNSET_BYTES,
        byte_threshold_ratio: float = 0.85,
        journal: CompactionJournal | None = None,
    ) -> None:
        if not 0 < threshold_ratio <= 1:
            raise ValueError("threshold_ratio must be in (0, 1]")
        if not 0 < byte_threshold_ratio <= 1:
            raise ValueError("byte_threshold_ratio must be in (0, 1]")
        if not 0 <= recompact_margin_ratio:
            raise ValueError("recompact_margin_ratio must be >= 0")
        if not 0 <= micro_compact_interval_rounds:
            raise ValueError("micro_compact_interval_rounds must be >= 0")
        if not 0 <= keep_last_images:
            raise ValueError("keep_last_images must be >= 0")
        if not 1 <= rapid_refill_window_rounds:
            raise ValueError("rapid_refill_window_rounds must be >= 1")
        if not 1 <= max_rapid_refills:
            raise ValueError("max_rapid_refills must be >= 1")
        self._max_tokens = max_context_tokens
        self._threshold = threshold_ratio
        self._keep_last = keep_last_messages
        self._keep_last_tools = keep_last_tool_results
        self._fold_excerpt_chars = fold_excerpt_chars
        self._summarizer = summarizer
        self._journal = journal
        if max_request_bytes == _UNSET_BYTES:
            self._max_request_bytes = resolve_max_request_bytes(None)
        elif max_request_bytes is None or max_request_bytes <= 0:
            self._max_request_bytes = None
        else:
            self._max_request_bytes = max_request_bytes
        self._byte_threshold = byte_threshold_ratio
        self._recompact_margin_ratio = recompact_margin_ratio
        #: Proactive micro-compaction (CC time-based microcompact parity):
        #: every N rounds, fold old tool results regardless of pressure, so a
        #: long chatty run never drifts toward the window. 0 (default) is off
        #: — each fold invalidates the provider prompt-cache prefix, so the
        #: interval trades cache hits for a bounded transcript.
        self._micro_compact_interval = micro_compact_interval_rounds
        #: Image offload (P2, dsh compaction-basic parity): old in-middle
        #: images are replaced by text pointers in the projection — the
        #: original bytes stay in the durable record. The newest
        #: ``keep_last_images`` image-bearing messages inside the prune
        #: horizon stay raw; the tail is never touched (same no-leak rule
        #: as the fold stage).
        self._image_offload = image_offload
        self._keep_last_images = keep_last_images
        #: Model name used for calibrated token estimates (see tokens.py).
        self._model = model
        #: Hysteresis: after a compaction, pressure must grow by
        #: ``recompact_margin_ratio * max_context_tokens`` before the next one
        #: fires. Without it a transcript that stays over threshold even after
        #: folding+summarizing re-compacts EVERY round — each rewrite destroys
        #: the provider prompt-cache prefix (the dogfood 22-compacts/5-traces
        #: pathology).
        self._recompact_margin = recompact_margin_ratio * max_context_tokens
        self._last_compaction_pressure: int | None = None
        self._last_compaction_bytes: int | None = None
        # Observability for callers/tests: how many compactions happened.
        self.compactions = 0
        self.byte_compactions = 0
        self.tail_image_offloads = 0
        # Observability: how many of them were periodic micro-compactions.
        self.micro_compactions = 0
        # Overflow-recovery state: consecutive context-overflow retries within
        # one round. Capped so a pathological transcript cannot spin a
        # compact→overflow→compact loop forever.
        self._overflow_round = -1
        self._overflow_attempts = 0
        #: Max forced compactions per round on context-overflow errors.
        self.max_overflow_retries = 2
        # Observability: how many overflow-driven compactions happened.
        self.overflow_recoveries = 0
        #: Consecutive ineffective pressure compactions (post-estimate still
        #: over threshold) before the circuit opens (CC auto-compact breaker
        #: parity). The overflow path is bounded separately and unaffected.
        self.max_consecutive_failures = 3
        self._consecutive_failures = 0
        #: Rapid-refill breaker (CC parity): a compaction that *worked* but
        #: whose freed space refills within ``rapid_refill_window_rounds``
        #: rounds counts as a refill; ``max_rapid_refills`` consecutive
        #: refills open the circuit — the transcript is churning faster than
        #: compaction can help, and each rewrite only kills the prompt-cache
        #: prefix. Distinct from the failure breaker above, which catches
        #: compactions that never get under threshold at all.
        self.rapid_refill_window_rounds = rapid_refill_window_rounds
        self.max_rapid_refills = max_rapid_refills
        self._rapid_refills = 0
        self._last_compact_round: int | None = None
        # Observability: True once the breaker tripped; the pressure path
        # stops firing for the rest of the session.
        self.circuit_open = False
        #: Which breaker tripped: "consecutive_failures" | "rapid_refill".
        self.circuit_reason: str | None = None

    def _estimate(self, transcript: Sequence[LLMMessage]) -> int:
        return estimate_tokens(transcript, model=self._model)

    @staticmethod
    def _wire_bytes(transcript: Sequence[LLMMessage], ctx: Any = None) -> int:
        tool_bytes = int(getattr(ctx, "tool_schemas_bytes", 0) or 0) if ctx is not None else 0
        return estimate_wire_bytes(transcript) + tool_bytes

    @property
    def max_request_bytes(self) -> int | None:
        return self._max_request_bytes

    def _pressure(self, transcript: Sequence[LLMMessage], ctx: Any) -> int:
        """Estimated size of the NEXT request's prompt.

        The provider-reported prompt tokens of the previous request are
        ground truth for everything sent so far; only the messages appended
        since (assistant turn + tool results + steers) need the heuristic.
        First round (or any state where the observation went stale) falls
        back to a full heuristic estimate.
        """
        observed = getattr(ctx, "last_prompt_tokens", None)
        observed_len = getattr(ctx, "last_prompt_transcript_len", 0) or 0
        if observed is not None and 0 < observed_len <= len(transcript):
            return observed + self._estimate(transcript[observed_len:])
        return self._estimate(transcript)

    @staticmethod
    def _reset_observed(ctx: Any) -> None:
        """A rewrite invalidates the observed indices; the next request
        re-observes. Without this the stale length would mis-slice."""
        if getattr(ctx, "last_prompt_tokens", None) is not None:
            ctx.last_prompt_tokens = None
            ctx.last_prompt_transcript_len = 0

    async def pre_step(
        self, transcript: list[LLMMessage], ctx: Any
    ) -> PreStepAction:
        round_index = getattr(ctx, "round_index", 0)
        if (
            self._micro_compact_interval > 0
            and round_index > 0
            and round_index % self._micro_compact_interval == 0
        ):
            pruned = self._prune_with_horizon(transcript)
            if pruned is not transcript:
                self.compactions += 1
                self.micro_compactions += 1
                self._reset_observed(ctx)
                return PreStepAction(
                    kind="proceed",
                    rewrite=RewriteRequest(
                        messages=pruned,
                        reason=(
                            "micro-compact: periodic tool-result prune "
                            f"(every {self._micro_compact_interval} rounds)"
                        ),
                        action="micro_compact",
                        pre_tokens=self._estimate(transcript),
                        post_tokens=self._estimate(pruned),
                    ),
                )
        pressure = self._pressure(transcript, ctx)
        wire_bytes = self._wire_bytes(transcript, ctx)
        threshold = self._threshold * self._max_tokens
        byte_limit = self._max_request_bytes
        byte_threshold = (
            int(byte_limit * self._byte_threshold) if byte_limit is not None else None
        )
        over_tokens = pressure >= threshold
        over_bytes = byte_threshold is not None and wire_bytes >= byte_threshold

        if not over_tokens and not over_bytes:
            # A healthy round resets both breaker counts — the pathology
            # (or the transcript that caused it) is gone.
            self._consecutive_failures = 0
            self._rapid_refills = 0
            return PreStepAction(kind="proceed")
        if self.circuit_open:
            # Breaker tripped: further pressure rewrites only invalidate the
            # prompt-cache prefix without shrinking the transcript. The
            # overflow path stays live and fails loud if the window is hit.
            return PreStepAction(kind="proceed")
        token_hysteresis_blocked = (
            not over_tokens
            or (
                self._last_compaction_pressure is not None
                and pressure < self._last_compaction_pressure + self._recompact_margin
            )
        )
        byte_hysteresis_blocked = (
            not over_bytes
            or (
                byte_limit is not None
                and self._last_compaction_bytes is not None
                and wire_bytes
                < self._last_compaction_bytes
                + int(self._recompact_margin_ratio * byte_limit)
                and wire_bytes < int(0.95 * byte_limit)
            )
        )
        if token_hysteresis_blocked and byte_hysteresis_blocked:
            return PreStepAction(kind="proceed")

        reason_prefix = (
            "request byte budget"
            if over_bytes and not over_tokens
            else "context pressure"
        )
        compacted = self._prune_with_horizon(transcript)
        pruned_tokens = self._estimate(compacted)
        pruned_bytes = self._wire_bytes(compacted, ctx)
        if pruned_tokens < threshold and (
            byte_threshold is None or pruned_bytes < byte_threshold
        ):
            self.compactions += 1
            if over_bytes:
                self.byte_compactions += 1
            self._consecutive_failures = 0
            notice = self._note_successful_compaction(round_index)
            self._last_compaction_pressure = pressure
            self._last_compaction_bytes = pruned_bytes
            self._reset_observed(ctx)
            return PreStepAction(
                kind="proceed",
                rewrite=RewriteRequest(
                    messages=compacted,
                    reason=f"{reason_prefix}: folded old tool results",
                    action="compact",
                    pre_tokens=pressure,
                    post_tokens=pruned_tokens,
                ),
                appends=[notice] if notice is not None else None,
                append_action="reminder" if notice is not None else None,
            )

        summarize_reason = f"{reason_prefix}: summarized middle"
        compacted, bracket = await self._summarize_middle(
            compacted,
            replay_source=transcript,
            ctx=ctx,
            reason=summarize_reason,
            action="compact",
            pre_tokens=pressure,
        )
        if self._estimate(compacted) >= threshold:
            # Last resort: the tail itself is the pressure (the middle was
            # empty or already minimal). Fold without the horizon — lossy
            # beats dead — accepting that these markers will be replayed
            # folded by a later summarization.
            refolded = self._fold_old_tool_results(compacted)
            if self._estimate(refolded) < self._estimate(compacted):
                compacted = refolded
        if byte_limit is not None and self._wire_bytes(compacted, ctx) > (
            byte_threshold or byte_limit
        ):
            compacted = self._shed_tail_for_byte_budget(
                compacted,
                ctx,
                target_bytes=byte_threshold or byte_limit,
            )
        post = self._estimate(compacted)
        post_bytes = self._wire_bytes(compacted, ctx)
        self.compactions += 1
        if over_bytes:
            self.byte_compactions += 1
        notice: TranscriptAppend | None = None
        under_thresholds = post < threshold and (
            byte_limit is None or post_bytes <= byte_limit
        )
        if under_thresholds:
            self._consecutive_failures = 0
            notice = self._note_successful_compaction(round_index)
        else:
            # Ineffective: even fold+summarize stayed over threshold (e.g. a
            # single kept tool result bigger than the window). Three in a
            # row open the circuit.
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.max_consecutive_failures:
                self.circuit_open = True
                self.circuit_reason = "consecutive_failures"
        self._last_compaction_pressure = pressure
        self._last_compaction_bytes = post_bytes
        self._reset_observed(ctx)
        return PreStepAction(
            kind="proceed",
            rewrite=RewriteRequest(
                messages=compacted,
                reason=summarize_reason,
                action="compact",
                pre_tokens=pressure,
                post_tokens=post,
                bracket=bracket,
            ),
            appends=[notice] if notice is not None else None,
            append_action="reminder" if notice is not None else None,
        )

    def _note_successful_compaction(self, round_index: int) -> TranscriptAppend | None:
        """Rapid-refill bookkeeping for a compaction that landed under
        threshold. A refill is a successful compaction within
        ``rapid_refill_window_rounds`` of the previous one; on the
        ``max_rapid_refills``-th consecutive refill the circuit opens and
        the round carries the thrashing reminder so both the model and the
        host UI see the actionable notice."""
        if (
            self._last_compact_round is not None
            and round_index - self._last_compact_round <= self.rapid_refill_window_rounds
        ):
            self._rapid_refills += 1
        else:
            self._rapid_refills = 0
        self._last_compact_round = round_index
        if self._rapid_refills >= self.max_rapid_refills and not self.circuit_open:
            self.circuit_open = True
            self.circuit_reason = "rapid_refill"
            reminder = CompactionThrashingReminder(
                self._rapid_refills, self.rapid_refill_window_rounds
            )
            return TranscriptAppend(
                message=LLMMessage.text_of(reminder.role, reminder.render()),
                kind=reminder.content_kind,
                fragment=reminder,
            )
        return None

    async def compact_now(
        self,
        transcript: list[LLMMessage],
        ctx: Any = None,
        *,
        focus: str | None = None,
        keep_head_turns: int | None = None,
        keep_tail_messages: int | None = None,
    ) -> PreStepAction:
        """Manual & partial compaction (CC ``/compact`` + partial-span parity).

        Folds old tool results and summarizes the middle regardless of pressure,
        hysteresis, or the circuit breaker. Optional ``focus`` appends a user
        retention directive to the warm-prefix replay; optional
        ``keep_head_turns`` / ``keep_tail_messages`` customize the verbatim
        protected boundaries (Partial Compaction).
        """
        pre = self._estimate(transcript)
        has_custom_bounds = (
            keep_head_turns is not None or keep_tail_messages is not None
        )
        head_end = self._head_end(transcript, keep_head_turns=keep_head_turns)
        tail_start = self._tail_start(
            transcript,
            head_end,
            keep_last_override=keep_tail_messages,
        )
        compacted = self._fold_old_tool_results(transcript, horizon=tail_start)
        if self._image_offload:
            compacted = self._offload_old_images(compacted, horizon=tail_start)
        reason = f"manual compact (focus: {focus.strip()})" if focus and focus.strip() else "manual compact"
        compacted, bracket = await self._summarize_middle(
            compacted,
            replay_source=transcript,
            ctx=ctx,
            reason=reason,
            action="compact",
            pre_tokens=pre,
            focus=focus,
            head_end_override=head_end,
            tail_start_override=tail_start,
        )
        if not has_custom_bounds:
            # Standard manual passes finish with the horizon-free fold so a
            # tail-only transcript still shrinks. Partial compaction with
            # explicit head/tail bounds preserves those spans verbatim.
            compacted = self._fold_old_tool_results(compacted)
        if self._max_request_bytes is not None and self._wire_bytes(compacted, ctx) > self._max_request_bytes:
            compacted = self._shed_tail_for_byte_budget(
                compacted, ctx, target_bytes=self._max_request_bytes
            )
        self._consecutive_failures = 0
        self._rapid_refills = 0
        self._last_compact_round = None
        if compacted is transcript or compacted == transcript:
            return PreStepAction(kind="proceed", reason="compact: nothing to fold")
        self.compactions += 1
        self._last_compaction_pressure = pre
        self._last_compaction_bytes = self._wire_bytes(compacted, ctx)
        if ctx is not None:
            self._reset_observed(ctx)
        return PreStepAction(
            kind="proceed",
            rewrite=RewriteRequest(
                messages=compacted,
                reason=reason,
                action="compact",
                pre_tokens=pre,
                post_tokens=self._estimate(compacted),
                bracket=bracket,
            ),
        )

    async def on_request_error(
        self, error: Exception, transcript: list[LLMMessage], ctx: Any
    ) -> RetryAction:
        """Context-overflow and HTTP 413 recovery: rewrite the transcript
        shorter (including tiered tail-image offload when gateway body limits
        or protected-tail images caused the rejection) and retry boundedly.
        """
        if classify_error(error) != "context_overflow":
            return RetryAction(kind="fail", reason=str(error))

        round_index = getattr(ctx, "round_index", 0)
        if round_index != self._overflow_round:
            self._overflow_round = round_index
            self._overflow_attempts = 0
        self._overflow_attempts += 1
        if self._overflow_attempts > self.max_overflow_retries:
            return RetryAction(
                kind="fail",
                reason=(
                    f"context overflow persists after {self.max_overflow_retries} "
                    f"forced compactions: {error}"
                ),
            )

        pre_tokens = self._estimate(transcript)
        pre_bytes = self._wire_bytes(transcript, ctx)
        status_code = getattr(error, "status_code", None)
        compacted = self._prune_with_horizon(transcript)
        compacted, bracket = await self._summarize_middle(
            compacted,
            replay_source=transcript,
            ctx=ctx,
            reason="context overflow: compacted transcript before retry",
            action="overflow_recovery",
            pre_tokens=pre_tokens,
        )
        # Retrying an unshrunk payload must re-fail, so when the horizon
        # fold + summarize made no progress at all (all the bulk sits in
        # the protected tail), finish with the horizon-free fold.
        if self._estimate(compacted) >= pre_tokens:
            refolded = self._fold_old_tool_results(compacted)
            if self._estimate(refolded) < self._estimate(compacted):
                compacted = refolded

        post_bytes = self._wire_bytes(compacted, ctx)
        byte_limit = self._max_request_bytes
        needs_tail_shed = (
            status_code == 413
            or self._overflow_attempts >= 2
            or (byte_limit is not None and post_bytes > byte_limit)
            or post_bytes >= int(pre_bytes * 0.9)
        )
        if needs_tail_shed:
            half_pre = max(int(pre_bytes * 0.5), 65_536)
            target_bytes = (
                min(byte_limit, half_pre) if byte_limit is not None else half_pre
            )
            compacted = self._shed_tail_for_byte_budget(
                compacted,
                ctx,
                target_bytes=target_bytes,
                force_tier2=(self._overflow_attempts >= 2),
            )

        self.compactions += 1
        self.overflow_recoveries += 1
        self._last_compaction_pressure = self._pressure(transcript, ctx)
        self._last_compaction_bytes = self._wire_bytes(compacted, ctx)
        self._reset_observed(ctx)
        return RetryAction(
            kind="retry",
            delay_ms=0,
            reason="context overflow: compacted transcript before retry",
            rewrite=RewriteRequest(
                messages=compacted,
                reason="context overflow: compacted transcript before retry",
                action="overflow_recovery",
                pre_tokens=pre_tokens,
                post_tokens=self._estimate(compacted),
                bracket=bracket,
            ),
        )

    # ------------------------------------------------------------------

    @staticmethod
    def _head_end(
        transcript: list[LLMMessage],
        *,
        keep_head_turns: int | None = None,
    ) -> int:
        """End of the always-kept head.

        By default keeps leading system messages plus the first user message
        (the goal). When ``keep_head_turns`` > 1 (Partial Compaction), keeps
        the first ``keep_head_turns`` user turns (including their assistant /
        tool responses up to the next user turn) verbatim.
        """
        if keep_head_turns is not None and keep_head_turns > 1:
            user_turns_seen = 0
            for i, m in enumerate(transcript):
                if m.role == "user":
                    is_tool_image = i > 0 and transcript[i - 1].role == "tool"
                    if not is_tool_image:
                        user_turns_seen += 1
                        if user_turns_seen > keep_head_turns:
                            return i
            return len(transcript)

        head_end = 0
        for i, m in enumerate(transcript):
            if m.role == "system" or (m.role == "user" and not any(
                x.role == "user" for x in transcript[:i]
            )):
                head_end = i + 1
            else:
                break
        return head_end

    def _fold_old_tool_results(
        self,
        transcript: list[LLMMessage],
        horizon: int | None = None,
        *,
        keep_last_tools_override: int | None = None,
    ) -> list[LLMMessage]:
        limit = len(transcript) if horizon is None else max(horizon, 0)
        tool_idx = [
            i
            for i, m in enumerate(transcript[:limit])
            if m.role == "tool" and not m.content_text.startswith(_FOLDED_TOOL_MARKER)
        ]
        keep_tools = (
            self._keep_last_tools
            if keep_last_tools_override is None
            else max(keep_last_tools_override, 0)
        )
        fold_before = len(tool_idx) - keep_tools
        if fold_before <= 0:
            return transcript
        fold_set = set(tool_idx[:fold_before])
        return [
            LLMMessage.text_of(
                "tool",
                _fold_content(m.content_text, self._fold_excerpt_chars),
                name=m.name,
                tool_call_id=m.tool_call_id,
            )
            if i in fold_set
            else m
            for i, m in enumerate(transcript)
        ]

    def _shed_tail_for_byte_budget(
        self,
        transcript: list[LLMMessage],
        ctx: Any,
        *,
        target_bytes: int,
        force_tier2: bool = False,
    ) -> list[LLMMessage]:
        """Tiered tail shedding when HTTP request bytes exceed gateway limits.

        Tier 1: fold all tool outputs except the newest 1, and offload all
        historical/tool images in the tail while protecting images attached to
        the latest user prompt (when it is not a tool-image echo).
        Tier 2: if wire bytes still exceed ``target_bytes`` (or on a second
        overflow retry), shed remaining ImageParts from oldest to newest until
        the request fits inside ``target_bytes``.
        """
        current = self._fold_old_tool_results(
            transcript, horizon=None, keep_last_tools_override=1
        )
        protect_index: int | None = None
        if (
            not force_tier2
            and current
            and current[-1].role == "user"
            and (len(current) == 1 or current[-2].role != "tool")
        ):
            protect_index = len(current) - 1

        shed_any_image = False
        tier1_msgs: list[LLMMessage] = []
        for idx, m in enumerate(current):
            if idx != protect_index and any(isinstance(p, ImagePart) for p in m.content):
                shed_any_image = True
                tier1_msgs.append(
                    LLMMessage(
                        role=m.role,
                        content=[
                            TextPart(
                                text=_image_pointer_text(
                                    p.media_type,
                                    note=f"tail message #{idx} offloaded for gateway byte budget",
                                )
                            )
                            if isinstance(p, ImagePart)
                            else p
                            for p in m.content
                        ],
                        name=m.name,
                        tool_call_id=m.tool_call_id,
                        tool_calls=m.tool_calls,
                        reasoning=m.reasoning,
                        reasoning_details=m.reasoning_details,
                    )
                )
            else:
                tier1_msgs.append(m)
        current = tier1_msgs

        # Tier 2: shed remaining images (e.g. multiple large attachments on the
        # latest user turn) oldest-first until under target_bytes.
        attachment_ord = 0
        while self._wire_bytes(current, ctx) > target_bytes:
            replaced_one = False
            next_msgs: list[LLMMessage] = []
            for m in current:
                if not replaced_one and any(isinstance(p, ImagePart) for p in m.content):
                    new_parts = []
                    for p in m.content:
                        if not replaced_one and isinstance(p, ImagePart):
                            attachment_ord += 1
                            replaced_one = True
                            shed_any_image = True
                            new_parts.append(
                                TextPart(
                                    text=_image_pointer_text(
                                        p.media_type,
                                        note=(
                                            f"large attachment #{attachment_ord} omitted "
                                            "to fit gateway body limit"
                                        ),
                                    )
                                )
                            )
                        else:
                            new_parts.append(p)
                    next_msgs.append(
                        LLMMessage(
                            role=m.role,
                            content=new_parts,
                            name=m.name,
                            tool_call_id=m.tool_call_id,
                            tool_calls=m.tool_calls,
                            reasoning=m.reasoning,
                            reasoning_details=m.reasoning_details,
                        )
                    )
                else:
                    next_msgs.append(m)
            current = next_msgs
            if not replaced_one:
                break

        if shed_any_image:
            self.tail_image_offloads += 1
        return current

    def _prune_with_horizon(self, transcript: list[LLMMessage]) -> list[LLMMessage]:
        """The prune stage: fold old tool results + offload old images, both
        confined to the region the summarize stage would shadow."""
        head_end = self._head_end(transcript)
        horizon = self._tail_start(transcript, head_end)
        pruned = self._fold_old_tool_results(transcript, horizon=horizon)
        if self._image_offload:
            pruned = self._offload_old_images(pruned, horizon=horizon)
        return pruned

    def _offload_old_images(
        self, transcript: list[LLMMessage], horizon: int | None = None
    ) -> list[LLMMessage]:
        """Replace old image parts with text pointers (P2). The original
        bytes stay in the durable record — only the projection sheds them —
        and the pointer tells the model where the image went. Within the
        horizon the newest ``keep_last_images`` image-bearing messages stay
        raw; idempotent because offloaded messages carry no image parts.
        """
        limit = len(transcript) if horizon is None else max(horizon, 0)
        image_idx = [
            i
            for i, m in enumerate(transcript[:limit])
            if any(isinstance(p, ImagePart) for p in m.content)
        ]
        offload_before = len(image_idx) - self._keep_last_images
        if offload_before <= 0:
            return transcript
        offload_set = set(image_idx[:offload_before])
        return [
            LLMMessage(
                role=m.role,
                content=[
                    TextPart(text=_image_pointer_text(p.media_type))
                    if isinstance(p, ImagePart)
                    else p
                    for p in m.content
                ],
                name=m.name,
                tool_call_id=m.tool_call_id,
                tool_calls=m.tool_calls,
                reasoning=m.reasoning,
                reasoning_details=m.reasoning_details,
            )
            if i in offload_set
            else m
            for i, m in enumerate(transcript)
        ]

    @staticmethod
    def _orphan_tool_ids(tail: Sequence[LLMMessage]) -> set[str]:
        """``tool_call_id``s answered inside ``tail`` but issued before it."""
        issued: set[str] = set()
        orphans: set[str] = set()
        for m in tail:
            for call in m.tool_calls or ():
                issued.add(call.id)
            if (
                m.role == "tool"
                and m.tool_call_id is not None
                and m.tool_call_id not in issued
            ):
                orphans.add(m.tool_call_id)
        return orphans

    def _tail_start(
        self,
        transcript: list[LLMMessage],
        head_end: int,
        *,
        keep_last_override: int | None = None,
    ) -> int:
        """Where the untouched tail begins: ``keep_last_messages`` back, then
        widened until the tail answers no tool call it does not also issue.
        """
        keep_count = (
            self._keep_last
            if keep_last_override is None
            else max(keep_last_override, 0)
        )
        tail_start = max(head_end, len(transcript) - keep_count)
        issuable = {
            call.id for m in transcript[head_end:] for call in m.tool_calls or ()
        }
        while tail_start > head_end and (
            self._orphan_tool_ids(transcript[tail_start:]) & issuable
        ):
            tail_start -= 1
        return tail_start

    async def _summarize_middle(
        self,
        transcript: list[LLMMessage],
        replay_source: list[LLMMessage] | None = None,
        *,
        ctx: Any = None,
        reason: str = "context pressure: summarized middle",
        action: str = "compact",
        pre_tokens: int | None = None,
        focus: str | None = None,
        head_end_override: int | None = None,
        tail_start_override: int | None = None,
    ) -> tuple[list[LLMMessage], CompactionBracket | None]:
        # Keep every system message plus the first user message (the goal) as
        # the head; keep the recent tail untouched; summarize the middle.
        head_end = (
            head_end_override
            if head_end_override is not None
            else self._head_end(transcript)
        )
        tail_start = (
            tail_start_override
            if tail_start_override is not None
            else self._tail_start(transcript, head_end)
        )
        middle = transcript[head_end:tail_start]
        if not middle:
            return transcript, None

        # ``replay_source`` is the pre-fold transcript the caller just folded
        # from (folding preserves message count and order, so indices align).
        # The summarizer replays THAT span — see _summarize for why.
        replay = (
            replay_source
            if replay_source is not None and len(replay_source) == len(transcript)
            else transcript
        )
        compaction_id = uuid4().hex
        journal: CompactionJournal | None = self._journal or (
            getattr(ctx, "compaction_journal", None) if ctx is not None else None
        )
        already_journaled = False
        if journal is not None and self._summarizer is not None:
            await journal.open_bracket(
                compaction_id=compaction_id,
                reason=reason,
                action=action,
                span_start_index=head_end,
                span_end_index=tail_start,
                pre_tokens=pre_tokens,
            )
            summary, paid_ok = await self._summarize_with_status(
                replay[:head_end], replay[head_end:tail_start], focus=focus
            )
            if paid_ok:
                await journal.record_summary(
                    compaction_id=compaction_id,
                    summary_text=summary,
                )
                already_journaled = True
        else:
            summary, _ = await self._summarize_with_status(
                replay[:head_end], replay[head_end:tail_start], focus=focus
            )
        summary_msg = LLMMessage.text_of("user", f"{_SUMMARY_MARKER}\n{summary}")
        bracket = CompactionBracket(
            compaction_id=compaction_id,
            span_start_index=head_end,
            span_end_index=tail_start,
            summary_text=summary,
            already_journaled=already_journaled,
        )
        return [*transcript[:head_end], summary_msg, *transcript[tail_start:]], bracket

    async def _summarize(
        self,
        head: list[LLMMessage],
        middle: list[LLMMessage],
        *,
        focus: str | None = None,
    ) -> str:
        summary, _ = await self._summarize_with_status(head, middle, focus=focus)
        return summary

    async def _summarize_with_status(
        self,
        head: list[LLMMessage],
        middle: list[LLMMessage],
        *,
        focus: str | None = None,
    ) -> tuple[str, bool]:
        if self._summarizer is not None:
            instruction = _SUMMARY_INSTRUCTION
            if focus and focus.strip():
                instruction = (
                    f"{_SUMMARY_INSTRUCTION}\n\n"
                    "Additional user retention directive (preserve verbatim details "
                    f"matching this focus): {focus.strip()}"
                )
            prompt = [
                *_text_pointer_span(head),
                *_text_pointer_span(middle),
                LLMMessage.text_of("user", instruction),
            ]
            try:
                message, _usage = await self._summarizer.complete(
                    prompt, cache_retention="none"
                )
            except Exception:
                return self._excerpt_summary(_text_pointer_span(middle)), False
            text = (message.content_text or "").strip()
            if text:
                return text, True
        return self._excerpt_summary(_text_pointer_span(middle)), False

    def _excerpt_summary(self, middle: list[LLMMessage]) -> str:
        # No summarizer, empty model reply, or a failed complete(): keep
        # role + a short excerpt per message so the thread of actions
        # survives. Image parts arrive as text pointers (the caller maps
        # them) so an image-only message still leaves a line.
        lines = []
        for m in middle:
            excerpt = m.content_text.replace("\n", " ")[:200]
            lines.append(f"[{m.role}] {excerpt}")
        return "\n".join(lines)
