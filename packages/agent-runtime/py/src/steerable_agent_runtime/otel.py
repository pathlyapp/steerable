"""OTel export — convert a persisted HarnessTrace into OTLP/HTTP JSON.

Stdlib-only: builds the ``ExportTraceServiceRequest`` payload by hand and
POSTs it to a collector's ``/v1/traces`` endpoint. No opentelemetry-sdk
dependency — the runtime stays lean, and any OTLP/HTTP-JSON collector
(Jaeger, Tempo, otel-collector, Honeycomb…) can ingest the result.

Mapping:
- the HarnessTrace becomes the root span (``coreloop.run``);
- each tool TraceSpan becomes a child span (``tool.<name>``); ``llm`` and
  ``approval`` spans (W2.7.2) keep their semantic names (``llm.request``,
  ``approval.wait``), the latter nested under its tool span;
- TraceEvents become span events on the root (payload fields as attributes).

ID encoding: OTel wants 32-hex trace IDs and 16-hex span IDs. Framework
trace IDs are ``trace_<uuid4hex>`` (already 32 hex chars); anything else is
hashed deterministically (sha256, truncated) so re-exports are idempotent.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from datetime import datetime, timezone
from typing import Any, Iterable, Literal

from steerable_agent_protocol.generated import HarnessTrace, TraceEvent, TraceSpan
from steerable_agent_harness.tracing import sanitize_for_trace

_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_HEX16 = re.compile(r"^[0-9a-f]{16}$")

#: Privacy modes control how much content leaves the process (W6-6).
#:
#: - ``"full"``: event payloads and span attributes are included, but always
#:   passed through ``sanitize_for_trace`` first (the redaction waterfall —
#:   the recorder already redacts at write time; the exporter redacts again so
#:   a trace recorded by an older/non-conforming path still can't leak a key).
#: - ``"metadata"``: only structural/timing/status fields are exported. Event
#:   payload bodies and free-form/error attributes — anything that could carry
#:   user content — are dropped. This is the privacy-conscious default for
#:   deployments that want observability without content egress.
#:
#: ``"off"`` is not a mode here: it is the caller deciding not to export at
#: all (the desktop gates the whole export on a user-configured collector).
PrivacyMode = Literal["full", "metadata"]

#: Span attribute keys always safe to export (ids, kinds, timing, status).
_SAFE_SPAN_ATTR_KEYS = frozenset(
    {"steerable.span_id", "steerable.kind", "toolCallId", "durationMs", "status"}
)


def _trace_id(raw: str) -> str:
    candidate = raw.removeprefix("trace_").lower()
    if _HEX32.match(candidate):
        return candidate
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _span_id(raw: str, *, salt: str = "") -> str:
    candidate = raw.removeprefix("span_").lower()
    if _HEX16.match(candidate):
        return candidate
    return hashlib.sha256(f"{salt}:{raw}".encode()).hexdigest()[:16]


def _ns(ms: int | None) -> str:
    """Epoch milliseconds → OTLP nanoseconds-since-epoch string."""
    return str((ms or 0) * 1_000_000)


def _iso_ms(iso: str | None) -> int:
    if not iso:
        return 0
    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)


def _attr_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, (dict, list)):
        return {"stringValue": json.dumps(value, ensure_ascii=False)}
    return {"stringValue": str(value)}


def _attrs(mapping: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"key": k, "value": _attr_value(v)} for k, v in mapping.items()]


def to_otlp_json(
    trace: HarnessTrace,
    spans: Iterable[TraceSpan],
    events: Iterable[TraceEvent],
    *,
    service_name: str = "steerable-agent",
    privacy_mode: PrivacyMode = "full",
) -> dict[str, Any]:
    """Build an OTLP ``ExportTraceServiceRequest`` dict from a stored trace.

    ``privacy_mode`` controls content egress (see ``PrivacyMode``); payloads
    and attributes are always secret-redacted via ``sanitize_for_trace``.
    """

    otel_trace_id = _trace_id(trace.traceId)
    root_span_id = _span_id(trace.traceId, salt="root")

    start_ms = _iso_ms(trace.createdAt)
    end_ms = start_ms + (trace.durationMs or 0)

    span_events = []
    for event in sorted(events, key=lambda e: e.sequence):
        if privacy_mode == "metadata":
            # Drop the payload body — keep only the status, which carries no
            # user content.
            attributes = {}
            if event.status:
                attributes["status"] = event.status
        else:
            attributes = dict(sanitize_for_trace(dict(event.payload or {})))
            if event.status:
                attributes.setdefault("status", event.status)
        span_events.append(
            {
                "timeUnixNano": _ns(event.timestampMs),
                "name": f"{event.kind}:{event.name}",
                "attributes": _attrs(attributes),
            }
        )

    root_span: dict[str, Any] = {
        "traceId": otel_trace_id,
        "spanId": root_span_id,
        "name": "coreloop.run",
        "kind": 1,  # SPAN_KIND_INTERNAL
        "startTimeUnixNano": _ns(start_ms),
        "endTimeUnixNano": _ns(end_ms),
        "attributes": _attrs(
            {
                "steerable.trace_id": trace.traceId,
                **({"steerable.chat_id": trace.chatId} if trace.chatId else {}),
                **({"steerable.session_id": trace.sessionId} if trace.sessionId else {}),
                **({"steerable.user_id": trace.userId} if trace.userId else {}),
                "steerable.event_count": trace.eventCount or 0,
                "steerable.span_count": trace.spanCount or 0,
            }
        ),
        "events": span_events,
        "status": (
            {"code": 2, "message": trace.status}  # STATUS_CODE_ERROR
            if trace.hadError
            else {"code": 1}  # STATUS_CODE_OK
        ),
    }

    child_spans = []
    for span in spans:
        if privacy_mode == "metadata":
            span_attrs = {
                k: v for k, v in (span.attrs or {}).items() if k in _SAFE_SPAN_ATTR_KEYS
            }
        else:
            span_attrs = dict(sanitize_for_trace(dict(span.attrs or {})))
        child_spans.append(
            {
                "traceId": otel_trace_id,
                "spanId": _span_id(span.spanId, salt=trace.traceId),
                # W2.7.2: approval.wait spans nest under their tool span;
                # everything else hangs off the root.
                "parentSpanId": (
                    _span_id(span.parentSpanId, salt=trace.traceId)
                    if span.parentSpanId
                    else root_span_id
                ),
                # Tool spans keep the legacy `tool.<name>` shape; llm /
                # approval spans carry their OTel-semantic name directly.
                "name": (
                    f"tool.{span.name}" if span.kind == "tool" else span.name
                ),
                "kind": 1,
                "startTimeUnixNano": _ns(span.startMs),
                "endTimeUnixNano": _ns(span.endMs),
                "attributes": _attrs(
                    {
                        "steerable.span_id": span.spanId,
                        "steerable.kind": span.kind,
                        **span_attrs,
                    }
                ),
                "status": {"code": 2} if span.status == "error" else {"code": 1},
            }
        )

    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": _attrs({"service.name": service_name}),
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "steerable-agent-runtime"},
                        "spans": [root_span, *child_spans],
                    }
                ],
            }
        ]
    }


def export_otlp_http(
    payload: dict[str, Any],
    endpoint: str,
    *,
    timeout_s: float = 10.0,
    headers: dict[str, str] | None = None,
) -> int:
    """POST an OTLP/HTTP JSON payload to ``endpoint`` (e.g.
    ``http://localhost:4318/v1/traces``). Returns the HTTP status code."""

    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return response.status


def export_trace(
    trace: HarnessTrace,
    spans: Iterable[TraceSpan],
    events: Iterable[TraceEvent],
    endpoint: str,
    *,
    privacy_mode: PrivacyMode = "metadata",
    service_name: str = "steerable-agent",
    timeout_s: float = 10.0,
    headers: dict[str, str] | None = None,
) -> int:
    """One-call export: build the OTLP payload (privacy-filtered + redacted)
    and POST it to the collector. ``privacy_mode`` defaults to ``"metadata"``
    here — the safe choice for a host that just wants observability without
    content egress; pass ``"full"`` only when the collector is trusted with
    (redacted) payloads."""
    payload = to_otlp_json(
        trace, spans, events, service_name=service_name, privacy_mode=privacy_mode
    )
    return export_otlp_http(payload, endpoint, timeout_s=timeout_s, headers=headers)


# ---------------------------------------------------------------------------
# Metrics — counters for the reliability statistics (phase 2, R4)
# ---------------------------------------------------------------------------

#: Metrics are deliberately separate from traces: a collector that only knows
#: ``/v1/traces`` keeps working, and a collector that wants counts subscribes
#: to ``/v1/metrics``. The names follow the OTel naming convention (dots,
#: no unit suffix — the unit rides in `unit`).
_TURN_COUNTER = "steerable.turn.outcome"
_ATTEMPT_COUNTER = "steerable.turn.attempts"


def to_otlp_metrics_json(
    samples: Iterable[dict[str, Any]],
    *,
    service_name: str = "steerable-agent",
    now_ms: int | None = None,
) -> dict[str, Any]:
    """Build an ``ExportMetricsServiceRequest`` from recorded turn outcomes.

    Each sample is one finished turn:

    - ``outcome``: ``completed`` | ``failed`` | ``cancelled``
    - ``failureKind``: provider classification, only meaningful when failed
    - ``retries``: retries spent in the turn
    - ``usedDirect``: whether the model request skipped the proxy
    - ``attempts``: model requests issued

    Nothing here identifies the conversation, the prompt, or the model: the
    payload is labels and counts, which is what an operator needs to see
    whether reconnecting works and what the failure rate is. That also means
    the payload is privacy-safe by construction rather than by filtering —
    there is no free-form field to filter.

    Labels are ordered so repeated exports are byte-identical for the same
    input, which keeps collector-side series stable.
    """

    timestamp = now_ms if now_ms is not None else int(datetime.now(timezone.utc).timestamp() * 1000)
    turn_counts: dict[tuple[tuple[str, str], ...], int] = {}
    attempt_counts: dict[tuple[tuple[str, str], ...], int] = {}

    for sample in samples:
        labels: list[tuple[str, str]] = [
            ("outcome", str(sample.get("outcome") or "unknown")),
        ]
        failure_kind = sample.get("failureKind")
        if failure_kind:
            labels.append(("failure_kind", str(failure_kind)))
        labels.append(("used_direct", "true" if sample.get("usedDirect") else "false"))
        key = tuple(labels)
        turn_counts[key] = turn_counts.get(key, 0) + 1
        attempts = int(sample.get("attempts") or 0)
        if attempts > 0:
            attempt_counts[key] = attempt_counts.get(key, 0) + attempts

    def datapoints(counts: dict[tuple[tuple[str, str], ...], int]) -> list[dict[str, Any]]:
        points: list[dict[str, Any]] = []
        for key in sorted(counts):
            points.append(
                {
                    "asInt": str(counts[key]),
                    "startTimeUnixNano": str(timestamp * 1_000_000),
                    "timeUnixNano": str(timestamp * 1_000_000),
                    "attributes": _attrs(dict(key)),
                }
            )
        return points

    # Sums (monotonic counters) rather than gauges: these count events since
    # the process started, and a collector aggregates them across exports.
    metrics: list[dict[str, Any]] = []
    if turn_counts:
        metrics.append(
            {
                "name": _TURN_COUNTER,
                "description": "Agent turns by terminal outcome.",
                "unit": "1",
                "sum": {
                    "aggregationTemporality": 2,  # cumulative
                    "isMonotonic": True,
                    "dataPoints": datapoints(turn_counts),
                },
            }
        )
    if attempt_counts:
        metrics.append(
            {
                "name": _ATTEMPT_COUNTER,
                "description": "Model requests issued on finished turns, retries included.",
                "unit": "1",
                "sum": {
                    "aggregationTemporality": 2,
                    "isMonotonic": True,
                    "dataPoints": datapoints(attempt_counts),
                },
            }
        )
    return {
        "resourceMetrics": [
            {
                "resource": {"attributes": _attrs({"service.name": service_name})},
                "scopeMetrics": [
                    {"scope": {"name": "steerable-agent-runtime"}, "metrics": metrics}
                ],
            }
        ]
    }


def export_metrics(
    samples: Iterable[dict[str, Any]],
    endpoint: str,
    *,
    service_name: str = "steerable-agent",
    timeout_s: float = 10.0,
    headers: dict[str, str] | None = None,
) -> int:
    """POST turn-outcome counters to a collector's ``/v1/metrics`` URL.

    Returns the HTTP status. Callers treat failure as non-fatal: a turn that
    completed must not fail because its telemetry could not be delivered.
    """
    payload = to_otlp_metrics_json(samples, service_name=service_name)
    return export_otlp_http(payload, endpoint, timeout_s=timeout_s, headers=headers)
