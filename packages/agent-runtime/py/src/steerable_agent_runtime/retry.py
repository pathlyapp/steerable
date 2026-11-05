"""Request retry — the ``on_request_error`` hook consumer.

`steerable_agent_harness.next_retry_delay_ms` has existed since the harness
was extracted but nothing called it; this hook wires it into the CoreLoop.
Local models (Ollama) flake far more often than cloud endpoints, so the
desktop path gets real robustness from this.

Semantics: each round gets its own retry budget (the counter resets when the
round advances — a request that failed twice in round 3 doesn't eat round
7's budget). Retryable classification routes on the provider error taxonomy
(``llm.errors``): transport / rate_limit / server / unknown retry with
backoff; auth / invalid_request fail fast; context_overflow fails here too —
it is ``CompactionHooks``' job to retry those with a rewritten transcript.
Pass ``retryable=`` to customize.

Connection failures get their own, more patient policy. A dropped tunnel costs
seconds to re-establish, so the shared 200ms cadence spends its whole budget
inside a blip the network would have recovered from; ``transport`` instead
starts at a second and doubles, and stops at a wall-clock deadline measured
from the first attempt rather than at an attempt count. The deadline keeps a
long outage from piling attempts into minutes of silence before the turn
reports failure. Every other kind keeps the attempt-counted policy, because
their waits are bounded by the provider's own answer (``Retry-After``, an
immediate 5xx).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from steerable_agent_harness import RetryPolicy, next_retry_delay_ms

from .hooks import NoopHooks, RetryAction
from .llm.errors import classify_error

if TYPE_CHECKING:
    from .llm import LLMMessage


def _default_retryable(error: Exception) -> bool:
    kind = classify_error(error)
    # context_overflow is excluded: retrying the identical over-long request
    # is a guaranteed re-fail. CompactionHooks intercepts that kind upstream.
    return kind in ("transport", "rate_limit", "server", "unknown")


@dataclass(frozen=True, slots=True)
class TransportRetryPolicy:
    """Connection-failure retry: patient backoff under a wall-clock deadline.

    `deadline_ms` bounds the time from the first failed attempt to the last
    retry, so a long outage surfaces as a failure within roughly one deadline
    instead of after ``max_attempts × request timeout``. A retry whose wait
    would cross the deadline is refused, and the turn fails with the last
    error rather than starting a request it cannot wait for.
    """

    max_attempts: int = 5
    base_delay_ms: int = 1000
    max_delay_ms: int = 8000
    deadline_ms: int = 60_000
    jitter: bool = True

    def policy(self) -> RetryPolicy:
        """The backoff shape, for `next_retry_delay_ms`."""
        return RetryPolicy(
            max_attempts=self.max_attempts,
            base_delay_ms=self.base_delay_ms,
            max_delay_ms=self.max_delay_ms,
            jitter=self.jitter,
        )


class RetryHooks(NoopHooks):
    """``on_request_error`` hook: bounded exponential backoff per round.

    Two policies run side by side: `policy` for every retryable kind, and
    `transport_policy` for connection failures (pass ``transport_policy=None``
    to route them through `policy` as well).
    """

    def __init__(
        self,
        policy: RetryPolicy | None = None,
        *,
        retryable: Callable[[Exception], bool] = _default_retryable,
        transport_policy: TransportRetryPolicy | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._policy = policy or RetryPolicy()
        self._retryable = retryable
        self._transport_policy = transport_policy or TransportRetryPolicy()
        self._clock = clock
        self._round = -1
        self._attempt = 0
        # When the first transport failure of this request happened.
        self._first_transport_at: float | None = None
        # Observability for callers/tests.
        self.retries = 0

    async def on_request_error(
        self, error: Exception, transcript: list[LLMMessage], ctx: Any
    ) -> RetryAction:
        round_index = getattr(ctx, "round_index", 0)
        if round_index != self._round:
            self._round = round_index
            self._attempt = 0
            self._first_transport_at = None
        self._attempt += 1

        kind = classify_error(error)
        if not self._retryable(error):
            return RetryAction(
                kind="fail",
                reason=f"non-retryable error ({kind}): {error}",
            )
        if kind == "transport":
            return self._transport_retry(error)

        if self._attempt >= self._policy.max_attempts:
            return RetryAction(
                kind="fail",
                reason=f"exhausted {self._policy.max_attempts} attempts: {error}",
            )

        self.retries += 1
        delay_ms = next_retry_delay_ms(self._policy, self._attempt)
        retry_after = getattr(error, "retry_after_ms", None)
        if isinstance(retry_after, int) and retry_after > delay_ms:
            delay_ms = retry_after
        return RetryAction(
            kind="retry",
            delay_ms=delay_ms,
        )

    def _transport_retry(self, error: Exception) -> RetryAction:
        policy = self._transport_policy
        now = self._clock()
        if self._first_transport_at is None:
            self._first_transport_at = now
        elapsed_ms = int((now - self._first_transport_at) * 1000)

        if self._attempt >= policy.max_attempts:
            return RetryAction(
                kind="fail",
                reason=f"exhausted {policy.max_attempts} attempts: {error}",
            )

        delay_ms = next_retry_delay_ms(policy.policy(), self._attempt)
        if elapsed_ms + delay_ms > policy.deadline_ms:
            return RetryAction(
                kind="fail",
                reason=(
                    f"gave up after {elapsed_ms}ms "
                    f"(deadline {policy.deadline_ms}ms): {error}"
                ),
            )

        self.retries += 1
        return RetryAction(kind="retry", delay_ms=delay_ms)
