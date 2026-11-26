"""Token estimation — CJK-aware heuristic with per-model calibration.

Used where a real tokenizer is unavailable (compaction pressure trigger).
Providers report true usage for the budget axis; this only needs to be
proportionally right so thresholds trip at the same relative fill level.

Base heuristic:
- CJK unified ideographs + CJK punctuation + fullwidth forms ≈ 0.6 token/char
  (empirically close for modern BPE tokenizers on Chinese text);
- everything else ≈ 0.25 token/char (the classic ~4 chars/token rule);
- +8 per message for role/framing overhead.

Per-model calibration: ``MODEL_TOKEN_FACTORS`` maps a model-name prefix to a
multiplicative factor over the base estimate (first prefix match wins).
Defaults are conservative (1.0 = uncalibrated); measure with your provider's
``usage`` reports and ``register_model_factor`` the result — the factor is
``observed_tokens / base_estimate`` over a representative transcript sample.
"""

from __future__ import annotations

import base64
import json
import math
import os
from collections.abc import Sequence
from typing import Any

from .llm import ImagePart, LLMMessage, TextPart
from .model_info import DEFAULT_CONTEXT_WINDOW, MODEL_INFOS, resolve_model_info

#: CJK char → token, everything else → token (TS parity: 0.6 / 0.25).
_CJK_FACTOR = 0.6
_OTHER_FACTOR = 0.25
_MESSAGE_OVERHEAD = 8
#: Baseline per-image estimate (order of magnitude of a standard image tile
#: set; used when dimensions cannot be inspected). Shared by the recording
#: layer's per-item cap heuristic.
IMAGE_PART_TOKEN_ESTIMATE = 1024
#: Default wire-request byte budget (4 MiB) so reverse proxies (OpenResty /
#: Nginx / Envoy) do not reject multimodal or tool-heavy requests with 413
#: before model token thresholds trip.
DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024
_WIRE_MESSAGE_FRAMING_BYTES = 48
_WIRE_IMAGE_FRAMING_BYTES = 64


def resolve_max_request_bytes(explicit: int | None = None) -> int | None:
    """Resolve the HTTP request byte budget (`None` disables byte gating)."""
    if explicit is not None:
        return explicit if explicit > 0 else None
    raw = os.environ.get("STEERABLE_MAX_REQUEST_BYTES", "").strip()
    if raw:
        try:
            parsed = int(raw)
        except ValueError:
            parsed = DEFAULT_MAX_REQUEST_BYTES
        return parsed if parsed > 0 else None
    return DEFAULT_MAX_REQUEST_BYTES


def _read_raster_dimensions(raw: bytes) -> tuple[int, int] | None:
    """Extract `(width, height)` from PNG, JPEG, or WebP header bytes."""
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        width = int.from_bytes(raw[16:20], "big")
        height = int.from_bytes(raw[20:24], "big")
        if width > 0 and height > 0:
            return (width, height)
        return None
    if len(raw) >= 30 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        chunk = raw[12:16]
        if chunk == b"VP8X" and len(raw) >= 30:
            width = 1 + int.from_bytes(raw[24:27], "little")
            height = 1 + int.from_bytes(raw[27:30], "little")
            return (width, height)
        if chunk == b"VP8 " and len(raw) >= 30 and raw[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(raw[26:28], "little") & 0x3FFF
            height = int.from_bytes(raw[28:30], "little") & 0x3FFF
            if width > 0 and height > 0:
                return (width, height)
        if chunk == b"VP8L" and len(raw) >= 25 and raw[20] == 0x2F:
            bits = int.from_bytes(raw[21:25], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            return (width, height)
        return None
    if len(raw) >= 4 and raw[0] == 0xFF and raw[1] == 0xD8:
        offset = 2
        while offset + 9 <= len(raw):
            if raw[offset] != 0xFF:
                break
            marker = raw[offset + 1]
            if marker in (0xD8, 0xD9):
                offset += 2
                continue
            length = int.from_bytes(raw[offset + 2 : offset + 4], "big")
            if length < 2 or offset + 2 + length > len(raw):
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                height = int.from_bytes(raw[offset + 5 : offset + 7], "big")
                width = int.from_bytes(raw[offset + 7 : offset + 9], "big")
                if width > 0 and height > 0:
                    return (width, height)
                break
            offset += 2 + length
    return None


def _inspect_base64_dimensions(source: str) -> tuple[int, int] | None:
    """Decode only a small prefix of base64 image data to inspect header dims."""
    if not source:
        return None
    payload = source
    if payload.startswith("data:"):
        comma = payload.find(",")
        if comma < 0:
            return None
        payload = payload[comma + 1 :]
    # 16 KiB of base64 (~12 KiB decoded) covers EXIF/APP markers before JPEG SOF.
    sample = "".join(payload[:16384].split())
    pad = (-len(sample)) % 4
    if pad:
        sample += "=" * pad
    try:
        raw = base64.b64decode(sample, validate=False)
    except Exception:  # noqa: BLE001
        return None
    return _read_raster_dimensions(raw)


def estimate_image_tokens(part: ImagePart) -> int:
    """Tile-aware vision token estimate with 1024-token floor for compatibility."""
    if not part.is_url or part.source.startswith("data:"):
        dims = _inspect_base64_dimensions(part.source)
        if dims is not None:
            width, height = dims
            tiles = math.ceil(width / 512) * math.ceil(height / 512)
            return max(IMAGE_PART_TOKEN_ESTIMATE, tiles * 170 + 85)
        if len(part.source) > 512 * 1024:
            return max(
                IMAGE_PART_TOKEN_ESTIMATE,
                min(4096, math.ceil(len(part.source) / 1024)),
            )
    return IMAGE_PART_TOKEN_ESTIMATE


def estimate_wire_bytes(
    messages: Sequence[LLMMessage],
    tools: Sequence[dict[str, Any]] | None = None,
) -> int:
    """Estimate serialized HTTP JSON request body size in UTF-8 bytes."""
    total = 64  # top-level JSON envelope overhead
    for m in messages:
        total += _WIRE_MESSAGE_FRAMING_BYTES
        if m.name:
            total += len(m.name.encode("utf-8")) + 12
        if m.tool_call_id:
            total += len(m.tool_call_id.encode("utf-8")) + 20
        for part in m.content:
            if isinstance(part, TextPart):
                total += len(part.text.encode("utf-8")) + 16
            elif isinstance(part, ImagePart):
                total += len(part.source.encode("utf-8")) + len(part.media_type) + _WIRE_IMAGE_FRAMING_BYTES
            else:
                total += len(str(getattr(part, "text", "")).encode("utf-8")) + 16
        if m.tool_calls:
            for call in m.tool_calls:
                total += len(call.id.encode("utf-8")) + len(call.name.encode("utf-8")) + 40
                args = json.dumps(
                    call.arguments or {}, ensure_ascii=False, separators=(",", ":")
                )
                total += len(args.encode("utf-8"))
        if m.reasoning_details:
            details_json = json.dumps(
                m.reasoning_details, ensure_ascii=False, separators=(",", ":")
            )
            total += len(details_json.encode("utf-8")) + 24
        elif m.reasoning:
            total += len(m.reasoning.encode("utf-8")) + 18
    if tools:
        tools_json = json.dumps(list(tools), ensure_ascii=False, separators=(",", ":"))
        total += len(tools_json.encode("utf-8")) + 16
    return total


def _is_cjk(code: int) -> bool:
    return (
        0x4E00 <= code <= 0x9FFF  # CJK unified ideographs
        or 0x3000 <= code <= 0x303F  # CJK punctuation
        or 0xFF00 <= code <= 0xFFEF  # fullwidth forms
    )


def estimate_text_tokens(text: str) -> int:
    """CJK-aware token estimate for a single string."""
    if not text:
        return 0
    cjk = sum(1 for ch in text if _is_cjk(ord(ch)))
    other = len(text) - cjk
    return math.ceil(cjk * _CJK_FACTOR + other * _OTHER_FACTOR)


#: model-name prefix → multiplicative calibration factor (first match wins).
#: 1.0 = base heuristic. Extend at runtime via ``register_model_factor``.
#:
#: ``deepseek`` 0.71: calibrated 2026-08-26 against production MySQL
#: (llmusagedaily ⋈ chatmessage, service='harness_loop', 6,605 single-model
#: user-day buckets, 99.8% modelId='default' → deepseek-v4). Aggregate
#: regression gave Σ(actual completionTokens) / Σ(base heuristic estimate)
#: = 0.708 — the base heuristic overestimates DeepSeek-tokenizer completion
#: tokens by ~41% on real CJK-heavy traffic, so compaction thresholds trip
#: earlier than intended. The cjk/other per-char split is NOT identifiable
#: from day-level aggregates (corr(cjk, other) = 0.88), so the correction is
#: applied as a single global factor; per-char refinement needs per-request
#: estimated/observed pairs from sidecar self-recording.
MODEL_TOKEN_FACTORS: dict[str, float] = {"deepseek": 0.71}


def register_model_factor(prefix: str, factor: float) -> None:
    """Calibrate estimates for models whose name starts with ``prefix``.

    ``factor`` = observed_provider_tokens / base_estimate, measured over a
    representative transcript. Must be positive.
    """
    if not prefix:
        raise ValueError("prefix must be non-empty")
    if factor <= 0:
        raise ValueError("factor must be positive")
    MODEL_TOKEN_FACTORS[prefix.lower()] = factor


def factor_for_model(model: str | None) -> float:
    """Calibration factor for ``model`` (longest matching prefix wins)."""
    if not model:
        return 1.0
    name = model.lower()
    best = ""
    factor = 1.0
    for prefix, f in MODEL_TOKEN_FACTORS.items():
        if name.startswith(prefix) and len(prefix) > len(best):
            best, factor = prefix, f
    return factor


def estimate_tokens(messages: Sequence[LLMMessage], model: str | None = None) -> int:
    """Estimate total tokens for a transcript, calibrated for ``model``.

    Tool-call arguments are serialized compactly (no spaces, no ASCII
    escaping) to match what actually goes over the wire.
    """
    total = 0
    for m in messages:
        total += _MESSAGE_OVERHEAD
        total += estimate_text_tokens(m.content_text)
        for part in m.content:
            if isinstance(part, ImagePart):
                total += estimate_image_tokens(part)
            elif not isinstance(part, TextPart):
                total += IMAGE_PART_TOKEN_ESTIMATE
        if m.tool_calls:
            for call in m.tool_calls:
                total += estimate_text_tokens(call.name)
                args = json.dumps(
                    call.arguments or {}, ensure_ascii=False, separators=(",", ":")
                )
                total += estimate_text_tokens(args)
        # Match the wire: OpenRouter gets details XOR plaintext, not both.
        if m.reasoning_details:
            total += estimate_text_tokens(
                json.dumps(m.reasoning_details, ensure_ascii=False, separators=(",", ":"))
            )
        elif m.reasoning:
            total += estimate_text_tokens(m.reasoning)
    return math.ceil(total * factor_for_model(model))


#: model-name prefix → provider context window in tokens (longest match wins).
#: Derived from the structured capability table (``model_info.MODEL_INFOS``,
#: W6-8) so window/modality/reasoning/tool-format stay a single source of
#: truth. Unknown models fall back to ``DEFAULT_CONTEXT_WINDOW``.
#:
#: Caveat: for a LOCAL Ollama daemon the effective window is the daemon's
#: ``num_ctx`` (default 4096), not the model's native window — pass an
#: explicit ``maxContextTokens`` for local-model deployments.
MODEL_CONTEXT_WINDOWS: dict[str, int] = {
    info.pattern: info.context_window for info in MODEL_INFOS
}


def resolve_context_window(
    model: str | None,
    explicit: int | None = None,
    *,
    provider: str | None = None,
    base_url: str | None = None,
) -> int:
    """Context window for ``model``: explicit config wins, then the catalog
    (provider/base_url scoped when given), then the legacy table, then the
    conservative fallback.

    Compaction thresholds derive from this (``threshold_ratio * window``), so
    a fixed default would either waste small-window models or — as with the
    old fixed 60k against 131k models — compact far earlier than the provider
    requires.
    """
    return resolve_model_info(
        model,
        provider=provider,
        base_url=base_url,
        context_window_override=explicit,
    ).context_window
