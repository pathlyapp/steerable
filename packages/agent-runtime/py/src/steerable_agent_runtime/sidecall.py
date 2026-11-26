"""Controlled auxiliary side-model port (``SideCallPort``, Phase 9 R7).

Unifies out-of-band / guard / summarization micro-calls under four invariants:

1. **Fixed window + secret redaction**: slices ``user_head[:head_chars]`` (default
   2,000) and ``assistant_tail[-tail_chars:]`` (default 8,000) and scrubs explicit
   credentials plus common bearer/API-key patterns before sending upstream.
2. **Hard timeout + main-turn cancel linkage**: enforces ``spec.timeout_s`` (5s
   binary classification / 15s structured summary) and aborts immediately when
   the parent turn's ``cancel_event`` fires.
3. **Independent usage accounting**: records ``SideCallUsage(caller="sidecall:<id>")``
   separately so auxiliary tokens never pollute the main conversation context
   window estimate.
4. **Fail-safe degradation**: timeouts and upstream errors return
   ``spec.fallback_value`` without raising into ``CoreLoop``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal

from .antihallucination import detect_deferred_execution
from .hooks import CompletionAction, CompletionDraft, NoopHooks

if TYPE_CHECKING:
    from .llm import LLMMessage, LLMProvider
    from .loop import LoopContext

logger = logging.getLogger(__name__)

SideCallCaller = Literal[
    "before_completion",
    "promised_action",
    "title_refresh",
    "custom_guard",
]

DEFAULT_HEAD_CHARS = 2_000
DEFAULT_TAIL_CHARS = 8_000
FAST_DECISION_TIMEOUT_S = 5.0
SUMMARY_DECISION_TIMEOUT_S = 15.0

PROMISED_ACTION_NUDGE_MESSAGE = (
    "[system notice] You stated that you are about to invoke a tool or check a data source, "
    "but emitted zero tool_calls in this step. Emit the required tool_call now, or provide "
    "your final answer directly if no tool call is needed."
)

PROMISED_ACTION_SYSTEM_PROMPT = (
    "You are a strict turn-completion classifier. Given the user's request head and the "
    "assistant's latest reply tail (where zero tool calls were emitted), decide whether the "
    "assistant promised or narrated an immediate next tool action without actually calling it. "
    'Respond with JSON only: {"promised": true|false, "reason": "short"}'
)

_COMMON_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-+/=]{16,}"),
)


class SideCallSecretRedactor:
    """Scrubs registered secret values (raw, URL-encoded, Base64) and common API tokens."""

    def __init__(self, secrets: list[str] | None = None) -> None:
        self._variants: list[str] = []
        for s in secrets or []:
            self.register_secret(s)

    def register_secret(self, raw: str) -> None:
        trimmed = raw.strip()
        if len(trimmed) < 6:
            return
        candidates = {
            trimmed,
            urllib.parse.quote(trimmed, safe=""),
            base64.b64encode(trimmed.encode("utf-8")).decode("ascii"),
        }
        for c in candidates:
            if len(c) >= 6 and c not in self._variants:
                self._variants.append(c)
        self._variants.sort(key=len, reverse=True)

    def redact(self, text: str) -> str:
        if not text:
            return text
        out = text
        for variant in self._variants:
            if variant in out:
                out = out.replace(variant, "[REDACTED]")
        for pattern in _COMMON_SECRET_PATTERNS:
            out = pattern.sub("[REDACTED]", out)
        return out


def slice_head_tail(
    user_head: str,
    assistant_tail: str,
    *,
    head_chars: int = DEFAULT_HEAD_CHARS,
    tail_chars: int = DEFAULT_TAIL_CHARS,
) -> tuple[str, str]:
    """Slice ``user_head`` to its leading ``head_chars`` and ``assistant_tail`` to its trailing ``tail_chars``."""
    h = user_head[: max(0, head_chars)] if user_head else ""
    t = assistant_tail[-max(0, tail_chars) :] if assistant_tail and tail_chars > 0 else ""
    return h, t


@dataclass(frozen=True, slots=True)
class SideCallSpec:
    caller: SideCallCaller
    system_prompt: str
    head_chars: int = DEFAULT_HEAD_CHARS
    tail_chars: int = DEFAULT_TAIL_CHARS
    timeout_s: float = FAST_DECISION_TIMEOUT_S
    response_schema: dict[str, Any] | None = None
    fallback_value: Any = None


@dataclass(frozen=True, slots=True)
class SideCallUsage:
    caller: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: float
    status: Literal["ok", "timeout", "cancelled", "error"]


@dataclass(frozen=True, slots=True)
class SideCallOutcome:
    ok: bool
    status: Literal["ok", "timeout", "cancelled", "error"]
    raw_text: str
    value: Any
    usage: SideCallUsage


SideCallCompleter = Callable[
    [list[dict[str, str]]],
    Awaitable[tuple[str, tuple[int, int]]],
]


async def _complete_via_provider(
    provider: LLMProvider,
    messages: list[dict[str, str]],
) -> tuple[str, tuple[int, int]]:
    from .llm import LLMMessage as RuntimeLLMMessage

    typed_msgs = [RuntimeLLMMessage(role=m["role"], content=m["content"]) for m in messages]
    parts: list[str] = []
    prompt_tokens = 0
    completion_tokens = 0
    async for chunk in provider.stream(typed_msgs, tools=None):
        if chunk.delta_text:
            parts.append(chunk.delta_text)
        if chunk.usage is not None:
            prompt_tokens = getattr(chunk.usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(chunk.usage, "completion_tokens", 0) or 0
    text = "".join(parts)
    if prompt_tokens == 0:
        prompt_tokens = max(1, sum(len(m["content"]) for m in messages) // 4)
    if completion_tokens == 0 and text:
        completion_tokens = max(1, len(text) // 4)
    return text, (prompt_tokens, completion_tokens)


class SideCallPort:
    """Unified side-model execution port with windowing, redaction, cancellation, and isolated usage."""

    def __init__(
        self,
        completer: SideCallCompleter | LLMProvider,
        *,
        redactor: SideCallSecretRedactor | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> None:
        if callable(completer):
            self._completer: SideCallCompleter = completer
        else:
            provider = completer
            self._completer = lambda msgs: _complete_via_provider(provider, msgs)
        self._redactor = redactor or SideCallSecretRedactor()
        self._cancel_event = cancel_event
        self._usage_records: list[SideCallUsage] = []
        self.last_dispatched_messages: list[dict[str, str]] | None = None

    @property
    def usage_records(self) -> tuple[SideCallUsage, ...]:
        return tuple(self._usage_records)

    @property
    def redactor(self) -> SideCallSecretRedactor:
        return self._redactor

    async def invoke(
        self,
        spec: SideCallSpec,
        *,
        user_input: str,
        assistant_output: str,
        cancel_event: asyncio.Event | None = None,
    ) -> SideCallOutcome:
        effective_cancel = cancel_event or self._cancel_event
        caller_tag = f"sidecall:{spec.caller}"
        started = time.perf_counter()

        if effective_cancel is not None and effective_cancel.is_set():
            usage = SideCallUsage(
                caller=caller_tag,
                prompt_tokens=0,
                completion_tokens=0,
                latency_ms=0.0,
                status="cancelled",
            )
            self._usage_records.append(usage)
            return SideCallOutcome(
                ok=False,
                status="cancelled",
                raw_text="",
                value=spec.fallback_value,
                usage=usage,
            )

        head, tail = slice_head_tail(
            user_input,
            assistant_output,
            head_chars=spec.head_chars,
            tail_chars=spec.tail_chars,
        )
        safe_head = self._redactor.redact(head)
        safe_tail = self._redactor.redact(tail)
        safe_sys = self._redactor.redact(spec.system_prompt)
        user_payload = f"<user_head>\n{safe_head}\n</user_head>\n<assistant_tail>\n{safe_tail}\n</assistant_tail>"
        messages = [
            {"role": "system", "content": safe_sys},
            {"role": "user", "content": user_payload},
        ]
        self.last_dispatched_messages = messages

        call_task = asyncio.create_task(self._completer(messages))
        cancel_wait_task: asyncio.Task[bool] | None = None
        try:
            if effective_cancel is not None:
                cancel_wait_task = asyncio.create_task(effective_cancel.wait())
                done, _ = await asyncio.wait(
                    {call_task, cancel_wait_task},
                    timeout=spec.timeout_s,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    call_task.cancel()
                    await asyncio.gather(call_task, return_exceptions=True)
                    return self._settle_failure(caller_tag, started, "timeout", spec.fallback_value)
                if cancel_wait_task in done and not call_task.done():
                    call_task.cancel()
                    await asyncio.gather(call_task, return_exceptions=True)
                    return self._settle_failure(caller_tag, started, "cancelled", spec.fallback_value)
                raw_text, (pt, ct) = await call_task
            else:
                raw_text, (pt, ct) = await asyncio.wait_for(call_task, timeout=spec.timeout_s)
        except asyncio.TimeoutError:
            call_task.cancel()
            await asyncio.gather(call_task, return_exceptions=True)
            return self._settle_failure(caller_tag, started, "timeout", spec.fallback_value)
        except asyncio.CancelledError:
            call_task.cancel()
            await asyncio.gather(call_task, return_exceptions=True)
            return self._settle_failure(caller_tag, started, "cancelled", spec.fallback_value)
        except Exception as exc:  # noqa: BLE001 — fail-safe guardrail #4
            logger.debug("SideCallPort(%s) degraded on error: %s", caller_tag, exc)
            return self._settle_failure(caller_tag, started, "error", spec.fallback_value)
        finally:
            if cancel_wait_task is not None and not cancel_wait_task.done():
                cancel_wait_task.cancel()
                await asyncio.gather(cancel_wait_task, return_exceptions=True)

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        parsed_val = _parse_sidecall_value(raw_text, spec)
        usage = SideCallUsage(
            caller=caller_tag,
            prompt_tokens=pt,
            completion_tokens=ct,
            latency_ms=elapsed_ms,
            status="ok",
        )
        self._usage_records.append(usage)
        return SideCallOutcome(
            ok=True,
            status="ok",
            raw_text=raw_text,
            value=parsed_val,
            usage=usage,
        )

    def _settle_failure(
        self,
        caller_tag: str,
        started: float,
        status: Literal["timeout", "cancelled", "error"],
        fallback_value: Any,
    ) -> SideCallOutcome:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        usage = SideCallUsage(
            caller=caller_tag,
            prompt_tokens=0,
            completion_tokens=0,
            latency_ms=elapsed_ms,
            status=status,
        )
        self._usage_records.append(usage)
        return SideCallOutcome(
            ok=False,
            status=status,
            raw_text="",
            value=fallback_value,
            usage=usage,
        )


def _parse_sidecall_value(raw_text: str, spec: SideCallSpec) -> Any:
    stripped = raw_text.strip()
    if spec.response_schema is None:
        return stripped
    # Strip optional markdown code fences
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        parsed = json.loads(stripped)
    except ValueError:
        return spec.fallback_value
    req = spec.response_schema.get("required")
    if isinstance(req, list) and isinstance(parsed, dict):
        for key in req:
            if key not in parsed:
                return spec.fallback_value
    return parsed


@dataclass
class PromisedActionContinuationHooks(NoopHooks):
    """Single-shot ``promised_action`` continuation via ``SideCallPort`` (R7-2).

    Fires at most ONCE per ``CoreLoop.run`` invocation when the assistant emits
    non-empty text with zero ``tool_calls`` and ``SideCallPort`` confirms that
    the text promised an unexecuted tool action. Never loops a second time.
    """

    port: SideCallPort
    user_question: str = ""
    tools_available: bool = True
    timeout_s: float = FAST_DECISION_TIMEOUT_S
    require_regex_prefilter: bool = True
    _nudged_this_turn: bool = field(default=False, init=False)
    _captured_user_text: str = field(default="", init=False)

    async def pre_step(
        self, transcript: list[LLMMessage], ctx: LoopContext
    ) -> Any:
        from .hooks import PreStepAction

        for msg in reversed(transcript):
            if getattr(msg, "role", None) == "user":
                content = getattr(msg, "content", "")
                self._captured_user_text = content if isinstance(content, str) else str(content)
                break
        return PreStepAction()

    async def before_completion(
        self,
        draft: CompletionDraft,
        ctx: LoopContext,
    ) -> CompletionAction:
        if (
            self._nudged_this_turn
            or not self.tools_available
            or draft.had_tool_calls
            or not draft.content.strip()
            or draft.status != "completed"
        ):
            return CompletionAction(kind="accept")

        if self.require_regex_prefilter and not detect_deferred_execution(draft.content):
            return CompletionAction(kind="accept")

        user_text = self._captured_user_text or self.user_question

        spec = SideCallSpec(
            caller="promised_action",
            system_prompt=PROMISED_ACTION_SYSTEM_PROMPT,
            timeout_s=self.timeout_s,
            response_schema={"type": "object", "required": ["promised"]},
            fallback_value={"promised": False},
        )
        outcome = await self.port.invoke(
            spec,
            user_input=user_text,
            assistant_output=draft.content,
        )
        if isinstance(outcome.value, dict) and outcome.value.get("promised") is True:
            self._nudged_this_turn = True
            return CompletionAction(
                kind="retry",
                message=PROMISED_ACTION_NUDGE_MESSAGE,
                reason="promised_action_nudge",
            )
        return CompletionAction(kind="accept")
