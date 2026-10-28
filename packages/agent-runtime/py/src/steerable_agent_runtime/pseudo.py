"""Pseudo / markdown tool-call recovery.

Some models (notably local ones served via Ollama, and Claude/OpenAI when they
regress into prose) emit tool *intent* as text instead of a structured
``tool_calls`` block:

- MiniMax XML:      ``<invoke name="tool"><parameter name="k">v</parameter></invoke>``
- DeepSeek XML:     ``<function=tool><parameter=k>v</parameter></function>``
- Markdown pseudo:  ``[Tool call: NAME]\\n{"k": "v"}``
- JSON tool object: a fenced or ``<tool_call>`` ``{"name", "arguments"}``
  object (Qwen / Ollama), or a message that is only that object

If the loop treated that text as a final answer it would end the turn having
never run the tool — the model "meant" to act but the loop stopped. This module
recovers those inline calls into real ``ToolCall`` objects so the act phase
runs, and returns the surrounding narration with the pseudo blocks removed.

Recovery (not just stripping) is what lets the loop drive real local models:
stripping would discard the model's intent and end the turn tool-less.

This is a whole-text extraction applied after a full round of content is
collected. Streaming-time stripping for display cleanliness lives below
(``PseudoStreamStripper``), ported from deeppath-api's production SSE path.
"""

from __future__ import annotations

import json
import re
from typing import Any

# --- XML families -----------------------------------------------------------

_INVOKE_TAG_RE = re.compile(
    r"<invoke\s+name=[\"']([^\"']+)[\"']\s*>(.*?)</invoke>",
    re.DOTALL,
)
_FUNC_TAG_RE = re.compile(
    r"<function=([^>]+)>(.*?)</function>",
    re.DOTALL,
)
_PARAM_TAG_RE = re.compile(
    r"<parameter\s+name=[\"']([^\"']+)[\"']\s*>(.*?)</parameter>",
    re.DOTALL,
)
_PARAM_EQ_TAG_RE = re.compile(
    r"<parameter=([^>]+)>(.*?)</parameter>",
    re.DOTALL,
)

# --- Markdown pseudo --------------------------------------------------------

_PSEUDO_TOOL_CALL_HEADER_RE = re.compile(
    r"\[Tool[\s_]call:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]",
    re.IGNORECASE,
)

# --- JSON tool objects (Qwen / Ollama) --------------------------------------
#
# Small local models often answer with a markdown fence (or a <tool_call>
# wrapper, or a message that is only the object) instead of a structured
# tool_calls block:
#
#   ```json
#   {"name": "ask_user", "arguments": {"intro": "..."}}
#   ```
#
# Only a payload whose every element is {name, arguments} is a call. A fenced
# config or a JSON object mentioned inside a sentence stays text.

_TOOL_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_FENCE_RE = re.compile(r"```[^\n`]*\n?(.*?)```", re.DOTALL)
_TOOL_CALL_BLOCK_RE = re.compile(
    r"<tool_call>\s*(.*?)\s*</tool_call>",
    re.DOTALL | re.IGNORECASE,
)
_FENCE_HOLD_CAP = 8192


def _scan_balanced_json_object(text: str, start: int) -> tuple[str, int] | None:
    """Find the next ``{...}`` JSON object starting at/after ``start``.

    Returns ``(json_str, end_index_exclusive)`` or ``None``. Tracks brace depth
    and respects string literals (handles escaped quotes), so nested objects
    inside the args don't trip the scanner.
    """
    n = len(text)
    i = start
    while i < n and text[i] != "{":
        if not text[i].isspace():
            return None
        i += 1
    if i >= n:
        return None

    depth = 0
    in_string = False
    escape = False
    j = i
    while j < n:
        ch = text[j]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[i : j + 1], j + 1
        j += 1
    return None


def extract_inline_tool_calls(text: str) -> tuple[list[dict[str, Any]], str]:
    """Extract tool calls from inline formats some models emit as text.

    Returns ``(calls, cleaned_text)``:

    - ``calls`` is a list of ``{"name", "arguments"}`` dicts (``arguments`` is
      a ``dict``).
    - ``cleaned_text`` is the original text with the matched pseudo blocks
      removed, so genuine narration around them survives without re-displaying
      the fake call.
    """
    results: list[dict[str, Any]] = []

    for m in _INVOKE_TAG_RE.finditer(text):
        tool_name = m.group(1).strip()
        body = m.group(2)
        args: dict[str, Any] = {}
        for pm in _PARAM_TAG_RE.finditer(body):
            args[pm.group(1).strip()] = pm.group(2).strip()
        results.append({"name": tool_name, "arguments": args})

    if not results:
        for m in _FUNC_TAG_RE.finditer(text):
            tool_name = m.group(1).strip()
            body = m.group(2)
            args = {}
            for pm in _PARAM_EQ_TAG_RE.finditer(body):
                args[pm.group(1).strip()] = pm.group(2).strip()
            results.append({"name": tool_name, "arguments": args})

    if results:
        return results, text

    cleaned_segments: list[str] = []
    cursor = 0
    for m in _PSEUDO_TOOL_CALL_HEADER_RE.finditer(text):
        tool_name = m.group(1).strip()
        scanned = _scan_balanced_json_object(text, m.end())
        if scanned is None:
            results.append({"name": tool_name, "arguments": {}})
            cleaned_segments.append(text[cursor : m.start()])
            cursor = m.end()
            continue
        json_str, end_idx = scanned
        try:
            args_obj = json.loads(json_str)
            if not isinstance(args_obj, dict):
                args_obj = {}
        except json.JSONDecodeError:
            args_obj = {}
        results.append({"name": tool_name, "arguments": args_obj})
        cleaned_segments.append(text[cursor : m.start()])
        cursor = end_idx

    if not results:
        recovered = _extract_json_tool_calls(text)
        if recovered is not None:
            return recovered
        return [], text

    cleaned_segments.append(text[cursor:])
    cleaned_text = "".join(cleaned_segments)
    cleaned_text = re.sub(r"\n{3,}", "\n\n", cleaned_text).strip()
    return results, cleaned_text


def _coerce_arguments(raw: Any) -> dict[str, Any] | None:
    """Return a dict of tool arguments, parsing a JSON string when needed."""
    if raw is None:
        return {}
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return {}
        try:
            raw = json.loads(stripped)
        except json.JSONDecodeError:
            return None
    if isinstance(raw, dict):
        return raw
    return None


def _calls_from_payload(payload: Any) -> list[dict[str, Any]] | None:
    """Accept one tool-call object or a list of them. Anything else is text."""
    items = payload if isinstance(payload, list) else [payload]
    if not items:
        return None
    calls: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            return None
        name = item.get("name")
        if not isinstance(name, str) or _TOOL_NAME_RE.fullmatch(name.strip()) is None:
            return None
        arguments = _coerce_arguments(item.get("arguments", {}))
        if arguments is None:
            return None
        calls.append({"name": name.strip(), "arguments": arguments})
    return calls


def _parse_tool_call_blob(blob: str) -> list[dict[str, Any]] | None:
    """Parse a tool-call JSON blob, unwrapping one surrounding fence."""
    blob = blob.strip()
    if not blob:
        return None
    fenced = _FENCE_RE.fullmatch(blob)
    if fenced is not None:
        blob = fenced.group(1).strip()
        if not blob:
            return None
    try:
        payload = json.loads(blob)
    except json.JSONDecodeError:
        return None
    return _calls_from_payload(payload)


def _extract_json_tool_calls(text: str) -> tuple[list[dict[str, Any]], str] | None:
    """Recover fenced / ``<tool_call>`` / whole-message JSON tool calls.

    Returns ``None`` when the text is not this format, so the caller can
    leave it untouched.
    """
    results: list[dict[str, Any]] = []
    spans: list[tuple[int, int]] = []

    def take(match: re.Match[str], blob: str) -> None:
        if any(match.start() < end and match.end() > start for start, end in spans):
            return
        calls = _parse_tool_call_blob(blob)
        if not calls:
            return
        results.extend(calls)
        spans.append(match.span())

    for match in _TOOL_CALL_BLOCK_RE.finditer(text):
        take(match, match.group(1))
    for match in _FENCE_RE.finditer(text):
        take(match, match.group(1))
    if not results:
        unclosed = re.search(r"```[^\n`]*\n(.*)\Z", text, re.DOTALL)
        if unclosed is not None:
            calls = _parse_tool_call_blob(unclosed.group(1))
            if calls:
                results.extend(calls)
                spans.append(unclosed.span())
    if not results:
        stripped = text.strip()
        if stripped[:1] in "{[":
            calls = _parse_tool_call_blob(stripped)
            if calls:
                return calls, ""
        return None

    cleaned = text
    for start, end in sorted(spans, reverse=True):
        cleaned = cleaned[:start] + cleaned[end:]
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return results, cleaned


# ---------------------------------------------------------------------------
# Streaming-time stripping (display path)
# ---------------------------------------------------------------------------
#
# Ported from deeppath-api's production SSE filters
# (``_strip_pseudo_fn_chunk`` / ``_strip_pseudo_md_tool_call_chunk`` /
# ``_strip_pseudo_fn_final`` / ``_split_trailing_high_surrogate``). Recovery
# above decides what *executes*; this filter decides what the *user sees* —
# pseudo blocks and self-echoed fake tool results are swallowed before they
# leak into the display stream.

#: Echo-block openers a model may emit when it regresses into simulating both
#: sides of the tool conversation (Claude context overflow, HF/OpenAI
#: fine-tuning dataset convention). Both halves are stripped so the user
#: never sees fabricated "tool" output that never ran.
_PSEUDO_FN_OPEN_TAGS: tuple[str, ...] = (
    "<function_results>",
    "<function_calls>",
    "<tool_call>",
    "<tool_response>",
)
_PSEUDO_FN_CLOSE_TAGS: tuple[str, ...] = (
    "</function_results>",
    "</function_calls>",
    "</tool_call>",
    "</tool_response>",
)
_PSEUDO_FN_MAX_OPEN_LEN = max(len(t) for t in _PSEUDO_FN_OPEN_TAGS)
_PSEUDO_FN_MAX_CLOSE_LEN = max(len(t) for t in _PSEUDO_FN_CLOSE_TAGS)
#: Safety belt: never swallow forever — past this many swallowed chars, give
#: up and release the buffer (duplicate echo beats vanished output).
_PSEUDO_FN_SWALLOW_HARD_CAP = 32_000

_PSEUDO_MD_OPEN = "[Tool call:"
#: Release if no closing ``}`` arrives within this many swallowed chars.
_PSEUDO_MD_HARD_CAP = 4096

_PSEUDO_FN_FINAL_RE = re.compile(
    r"<(?:function_results|function_calls|tool_call|tool_response)>"
    r"[\s\S]*?"
    r"(?:</(?:function_results|function_calls|tool_call|tool_response)>|$)",
    re.IGNORECASE,
)


def split_trailing_high_surrogate(text: str, carry: str) -> tuple[str, str]:
    """Hold back a half-emoji split across stream chunk boundaries.

    Providers occasionally chop a 4-byte UTF-8 emoji mid-pair, handing us a
    string ending in a *high* UTF-16 surrogate (``U+D800–U+DBFF``) without
    its low half; encoding that with strict UTF-8 raises and tears down the
    stream. The fix: keep the trailing high surrogate in ``carry`` and
    prepend it to the next chunk, reconstructing the pair losslessly.
    """

    combined = (carry or "") + (text or "")
    if combined and 0xD800 <= ord(combined[-1]) <= 0xDBFF:
        return combined[:-1], combined[-1]
    return combined, ""


def strip_pseudo_fn_final(text: str) -> str:
    """Belt-and-suspenders cleanup for the joined assistant text.

    Catches echo blocks that slipped past the streaming filter (model never
    emitted a closing tag, or a non-streamed call produced the same noise).
    """

    if not text:
        return text
    return _PSEUDO_FN_FINAL_RE.sub("", text)


class _FnEchoFilter:
    """Stateful filter dropping ``<function_results>``-family echo blocks."""

    def __init__(self) -> None:
        self._swallow = False
        self._buf = ""
        self._swallowed = 0

    def _reset(self) -> None:
        self._swallow = False
        self._buf = ""
        self._swallowed = 0

    def feed(self, chunk: str) -> str:
        buf = self._buf + (chunk or "")
        out: list[str] = []
        while True:
            if self._swallow:
                close_idx, close_len = -1, 0
                for tag in _PSEUDO_FN_CLOSE_TAGS:
                    idx = buf.find(tag)
                    if idx >= 0 and (close_idx < 0 or idx < close_idx):
                        close_idx, close_len = idx, len(tag)
                if close_idx < 0:
                    tail_keep = _PSEUDO_FN_MAX_CLOSE_LEN - 1
                    if len(buf) > tail_keep:
                        self._swallowed += len(buf) - tail_keep
                        buf = buf[-tail_keep:]
                    if self._swallowed >= _PSEUDO_FN_SWALLOW_HARD_CAP:
                        out.append(buf)
                        self._reset()
                        return "".join(out)
                    self._buf = buf
                    return "".join(out)
                self._swallowed += close_idx
                buf = buf[close_idx + close_len :]
                self._swallow = False
                self._swallowed = 0
                continue

            open_idx, open_len = -1, 0
            for tag in _PSEUDO_FN_OPEN_TAGS:
                idx = buf.find(tag)
                if idx >= 0 and (open_idx < 0 or idx < open_idx):
                    open_idx, open_len = idx, len(tag)
            if open_idx >= 0:
                if open_idx > 0:
                    out.append(buf[:open_idx])
                buf = buf[open_idx + open_len :]
                self._swallow = True
                continue

            # No full opener: hold back a tail that might be a partial opener
            # straddling chunk boundaries (cheap fast path when no '<').
            if "<" not in buf:
                out.append(buf)
                self._reset()
                return "".join(out)
            tail_keep = _PSEUDO_FN_MAX_OPEN_LEN - 1
            if len(buf) > tail_keep:
                out.append(buf[:-tail_keep])
                buf = buf[-tail_keep:]
            self._buf = buf
            return "".join(out)

    def flush(self) -> str:
        # Still inside an unclosed block at stream end: drop the remainder —
        # a half-echo adds zero value.
        if self._swallow:
            self._reset()
            return ""
        tail = self._buf
        self._reset()
        return tail


class _MdCallFilter:
    """Stateful filter dropping ``[Tool call: name]\\n{json}`` blocks.

    Caveat (ported): assumes the JSON args are a single flat object — no
    nested ``}`` before the real closing brace. The hard cap protects the
    worst case.
    """

    def __init__(self) -> None:
        self._swallow = False
        self._buf = ""
        self._swallowed = 0

    def _reset(self) -> None:
        self._swallow = False
        self._buf = ""
        self._swallowed = 0

    def feed(self, chunk: str) -> str:
        buf = self._buf + (chunk or "")
        out: list[str] = []
        while True:
            if self._swallow:
                close_idx = buf.find("}")
                if close_idx < 0:
                    if len(buf) > 64:
                        self._swallowed += len(buf) - 64
                        buf = buf[-64:]
                    if self._swallowed >= _PSEUDO_MD_HARD_CAP:
                        out.append(buf)
                        self._reset()
                        return "".join(out)
                    self._buf = buf
                    return "".join(out)
                after = close_idx + 1
                if after < len(buf) and buf[after] == "\n":
                    after += 1
                buf = buf[after:]
                self._swallow = False
                self._swallowed = 0
                continue

            open_idx = buf.find(_PSEUDO_MD_OPEN)
            if open_idx >= 0:
                if open_idx > 0:
                    out.append(buf[:open_idx])
                buf = buf[open_idx + len(_PSEUDO_MD_OPEN) :]
                self._swallow = True
                continue

            if "[" not in buf:
                out.append(buf)
                self._reset()
                return "".join(out)
            keep = len(_PSEUDO_MD_OPEN) - 1
            if len(buf) > keep:
                out.append(buf[:-keep])
                buf = buf[-keep:]
            self._buf = buf
            return "".join(out)

    def flush(self) -> str:
        if self._swallow:
            self._reset()
            return ""
        tail = self._buf
        self._reset()
        return tail


def _split_partial_backticks(buf: str) -> tuple[str, str]:
    """Hold a trailing 1-2 backticks that may still become a fence opener."""
    hold = 0
    for char in reversed(buf):
        if char != "`" or hold == 2:
            break
        hold += 1
    if hold == 0:
        return buf, ""
    return buf[:-hold], buf[-hold:]


def _opened_fence_body(held: str) -> str | None:
    """Body of a span that starts with an opening fence.

    ``held`` includes the closing fence when the span is complete. An
    unclosed span returns the text after the language line.
    """
    if not held.startswith("```"):
        return None
    if held.endswith("```") and len(held) >= 6:
        match = _FENCE_RE.fullmatch(held)
        if match is None:
            return None
        return match.group(1)
    rest = held[3:]
    newline = rest.find("\n")
    if newline < 0:
        return rest
    return rest[newline + 1 :]


class _JsonFenceFilter:
    """Hold a ``` fence and drop it only when the body is a tool-call object.

    A code sample or a JSON config is released unchanged, including when the
    fence never closes. A fence larger than ``_FENCE_HOLD_CAP`` is released
    so a long code block is not stuck in the filter.
    """

    def __init__(self) -> None:
        self._buf = ""
        self._open = False
        self._held = ""

    def feed(self, chunk: str) -> str:
        buf = self._buf + (chunk or "")
        self._buf = ""
        out: list[str] = []
        while True:
            if self._open:
                close = buf.find("```")
                if close < 0:
                    self._held += buf
                    if len(self._held) > _FENCE_HOLD_CAP:
                        out.append(self._held)
                        self._held = ""
                        self._open = False
                    break
                self._held += buf[: close + 3]
                buf = buf[close + 3 :]
                released = self._release_held()
                if released:
                    out.append(released)
                continue
            opener = buf.find("```")
            if opener >= 0:
                if opener:
                    out.append(buf[:opener])
                buf = buf[opener + 3 :]
                self._open = True
                self._held = "```"
                continue
            emit, hold = _split_partial_backticks(buf)
            if emit:
                out.append(emit)
            self._buf = hold
            break
        return "".join(out)

    def _release_held(self) -> str:
        held = self._held
        self._held = ""
        self._open = False
        body = _opened_fence_body(held)
        if body is not None and _parse_tool_call_blob(body):
            return ""
        return held

    def flush(self) -> str:
        if self._open:
            self._held += self._buf
            self._buf = ""
            return self._release_held()
        tail = self._buf
        self._buf = ""
        return tail


class PseudoStreamStripper:
    """Display-path filter chaining the fn-echo, JSON-fence, and markdown filters.

    Usage: ``feed`` each raw content delta, emit what comes back; at stream
    end, ``flush`` once and emit the tail. Text held back to detect markers
    split across chunks is released on the next feed or at flush.
    """

    def __init__(self) -> None:
        self._fn = _FnEchoFilter()
        self._fence = _JsonFenceFilter()
        self._md = _MdCallFilter()

    def feed(self, chunk: str) -> str:
        return self._md.feed(self._fence.feed(self._fn.feed(chunk)))

    def flush(self) -> str:
        mid = self._fence.feed(self._fn.flush()) + self._fence.flush()
        return self._md.feed(mid) + self._md.flush()
