"""RetryHooks (test_retry_hooks): on_request_error wired to the harness backoff primitive."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_harness import RetryPolicy
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import (
    CoreLoop,
    LoopEvent,
    RetryHooks,
    RouterToolExecutor,
    ToolRouter,
)
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk
from steerable_agent_runtime.llm.errors import LLMError
from steerable_agent_runtime.retry import TransportRetryPolicy


def make_flaky_provider(*, fail_on: set[int] | None, script: list[dict[str, Any]]):
    """Provider whose stream raises on the given 1-based attempt numbers.

    ``fail_on=None`` means every attempt fails (persistent error).
    """

    class _FlakyProvider:
        name = "flaky"
        model = "flaky-model"

        def __init__(self) -> None:
            self.attempts = 0
            self.calls: list[list[LLMMessage]] = []
            self._idx = 0

        async def complete(self, messages, *, tools=None, **kw):  # pragma: no cover
            raise NotImplementedError

        def stream(self, messages, *, tools=None, **kw) -> AsyncIterator[LLMStreamChunk]:
            self.calls.append(list(messages))
            self.attempts += 1
            attempt = self.attempts
            entry = script[min(self._idx, len(script) - 1)]

            async def _gen() -> AsyncIterator[LLMStreamChunk]:
                if fail_on is None or attempt in fail_on:
                    raise RuntimeError("connection reset by peer")
                self._idx += 1
                content = entry.get("content", "")
                if content:
                    yield LLMStreamChunk(content_delta=content)
                for call in entry.get("tool_calls", []):
                    yield LLMStreamChunk(tool_call_delta=call)
                yield LLMStreamChunk(
                    finish_reason="tool_calls" if entry.get("tool_calls") else "stop"
                )

            return _gen()

    return _FlakyProvider()


def tc(name: str, args: dict[str, Any] | None = None) -> ToolCall:
    return ToolCall(id=f"call_{name}", name=name, arguments=args or {})


async def collect(loop_run: AsyncIterator[LoopEvent]) -> list[LoopEvent]:
    return [e async for e in loop_run]


def _policy() -> RetryPolicy:
    # zero-ish delays keep the tests fast; jitter off for determinism
    return RetryPolicy(max_attempts=3, base_delay_ms=1, max_delay_ms=2, jitter=False)


@pytest.mark.asyncio
async def test_transient_error_is_retried_and_run_completes() -> None:
    provider = make_flaky_provider(fail_on={1, 2}, script=[{"content": "recovered"}])
    hooks = RetryHooks(_policy())
    loop = CoreLoop(provider, RouterToolExecutor(ToolRouter()), hooks=hooks)

    events = await collect(loop.run([LLMMessage.text_of("user", "hi")]))

    assert provider.attempts == 3  # 2 failures + 1 success
    assert hooks.retries == 2
    assert events[-1].data["status"] == "completed"
    assert not [e for e in events if e.kind == "error"]


@pytest.mark.asyncio
async def test_persistent_error_fails_after_max_attempts() -> None:
    provider = make_flaky_provider(fail_on=None, script=[{"content": "never"}])
    hooks = RetryHooks(_policy())
    loop = CoreLoop(provider, RouterToolExecutor(ToolRouter()), hooks=hooks)

    events = await collect(loop.run([LLMMessage.text_of("user", "hi")]))

    assert provider.attempts == 3  # max_attempts
    errors = [e for e in events if e.kind == "error"]
    assert len(errors) == 1
    assert events[-1].data["status"] == "failed"
    assert "exhausted" in events[-1].data["reason"]


@pytest.mark.asyncio
async def test_non_retryable_error_fails_immediately() -> None:
    provider = make_flaky_provider(fail_on=None, script=[{"content": "never"}])
    hooks = RetryHooks(_policy(), retryable=lambda exc: False)
    loop = CoreLoop(provider, RouterToolExecutor(ToolRouter()), hooks=hooks)

    events = await collect(loop.run([LLMMessage.text_of("user", "hi")]))

    assert provider.attempts == 1  # no retry
    assert events[-1].data["status"] == "failed"
    assert "non-retryable" in events[-1].data["reason"]


@pytest.mark.asyncio
async def test_retry_budget_resets_each_round() -> None:
    # Round 0 burns 2 retries then succeeds with a tool call; round 1 must get
    # a fresh budget (another 2 retries) rather than inheriting round 0's.
    provider = make_flaky_provider(
        fail_on={1, 2, 4, 5},
        script=[{"content": "", "tool_calls": [tc("noop")]}, {"content": "done"}],
    )
    router = ToolRouter()

    async def noop() -> str:
        return "ok"

    router.register(noop)
    hooks = RetryHooks(_policy())
    loop = CoreLoop(provider, RouterToolExecutor(router), hooks=hooks)

    events = await collect(loop.run([LLMMessage.text_of("user", "go")]))

    # attempts: round0 fails x2 + success, round1 fails x2 + success = 6
    assert provider.attempts == 6
    assert events[-1].data["status"] == "completed"


@pytest.mark.asyncio
async def test_rate_limit_waits_retry_after_header() -> None:
    hooks = RetryHooks(_policy())
    ctx = type("Ctx", (), {"round_index": 0})()
    err = LLMError(
        "429", kind="rate_limit", status_code=429, retry_after_ms=30_000
    )
    action = await hooks.on_request_error(err, [], ctx)
    assert action.kind == "retry"
    assert action.delay_ms == 30_000


# ---------------------------------------------------------------------------
# Connection failures: patient backoff under a wall-clock deadline
# ---------------------------------------------------------------------------


class _Clock:
    """Monotonic stand-in so deadline tests never sleep."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _transport_hooks(clock: _Clock, **overrides: Any) -> RetryHooks:
    overrides.setdefault("jitter", False)
    policy = TransportRetryPolicy(**overrides)
    return RetryHooks(
        RetryPolicy(max_attempts=3, base_delay_ms=1, max_delay_ms=2, jitter=False),
        transport_policy=policy,
        clock=clock,
    )


def _ctx(round_index: int = 0) -> Any:
    return type("Ctx", (), {"round_index": round_index})()


def _transport_error() -> LLMError:
    return LLMError("proxy dropped the tunnel", kind="transport")


@pytest.mark.asyncio
async def test_transport_backoff_starts_at_a_second_and_doubles() -> None:
    """A dropped tunnel needs seconds, not the shared 200ms cadence."""
    clock = _Clock()
    hooks = _transport_hooks(clock)
    ctx = _ctx()

    delays = []
    for _ in range(3):
        action = await hooks.on_request_error(_transport_error(), [], ctx)
        assert action.kind == "retry"
        delays.append(action.delay_ms)
        clock.now += action.delay_ms / 1000

    assert delays == [1000, 2000, 4000]


@pytest.mark.asyncio
async def test_transport_retry_stops_at_the_deadline() -> None:
    """A long outage must surface inside the deadline, not attempt by attempt."""
    clock = _Clock()
    hooks = _transport_hooks(clock, deadline_ms=3000)
    ctx = _ctx()

    action = await hooks.on_request_error(_transport_error(), [], ctx)
    assert action.kind == "retry"
    clock.now += 1.0
    action = await hooks.on_request_error(_transport_error(), [], ctx)
    assert action.kind == "retry"
    # 1s elapsed + a 2s wait crosses the 3s deadline.
    clock.now += 1.0
    action = await hooks.on_request_error(_transport_error(), [], ctx)
    assert action.kind == "fail"
    assert "deadline" in (action.reason or "")


@pytest.mark.asyncio
async def test_transport_retry_stops_at_max_attempts() -> None:
    clock = _Clock()
    hooks = _transport_hooks(clock, max_attempts=2, deadline_ms=600_000)
    ctx = _ctx()

    assert (await hooks.on_request_error(_transport_error(), [], ctx)).kind == "retry"
    action = await hooks.on_request_error(_transport_error(), [], ctx)
    assert action.kind == "fail"
    assert "exhausted 2 attempts" in (action.reason or "")


@pytest.mark.asyncio
async def test_deadline_restarts_on_the_next_round() -> None:
    """The deadline is per request: round 9 gets its own budget."""
    clock = _Clock()
    hooks = _transport_hooks(clock, deadline_ms=3500)
    assert (
        await hooks.on_request_error(_transport_error(), [], _ctx(0))
    ).kind == "retry"
    clock.now += 1.0
    assert (
        await hooks.on_request_error(_transport_error(), [], _ctx(0))
    ).kind == "retry"
    clock.now += 2.0
    assert (
        await hooks.on_request_error(_transport_error(), [], _ctx(0))
    ).kind == "fail"

    clock.now += 60.0
    action = await hooks.on_request_error(_transport_error(), [], _ctx(1))
    assert action.kind == "retry"


@pytest.mark.asyncio
async def test_rate_limit_keeps_the_shared_policy() -> None:
    """Only connection failures get the patient cadence."""
    clock = _Clock()
    hooks = _transport_hooks(clock)
    err = LLMError("429", kind="rate_limit", status_code=429)

    action = await hooks.on_request_error(err, [], _ctx())

    assert action.kind == "retry"
    assert action.delay_ms == 1  # the shared policy's base delay


@pytest.mark.asyncio
async def test_auth_failure_is_still_immediate() -> None:
    clock = _Clock()
    hooks = _transport_hooks(clock)

    action = await hooks.on_request_error(
        LLMError("401", kind="auth", status_code=401), [], _ctx()
    )

    assert action.kind == "fail"
    assert "non-retryable" in (action.reason or "")
