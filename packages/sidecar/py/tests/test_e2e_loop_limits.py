"""E2E: the harness spec's loop limits govern a real sidecar chat turn.

Layer choice: ``_build_loop_config`` (the parity change under test) runs
inside the sidecar process, so the honest observation point is the wire of
a real ``python -m steerable_sidecar``: how many LLM requests a turn makes
and how it terminates. The LLM is a loopback mock that always calls
``web_fetch`` with a literal loopback URL; the sidecar's SSRF guard rejects
the call instantly (a literal IP needs no DNS and opens no connection), so
every round costs exactly one mock request and one failed tool result and
the loop would run forever unless a limit stops it.

What is proven through the real process:

- with no explicit limits, 20 consecutive tool failures do not end the
  turn — the old shipped cap (16) would have failed it first — and the
  model can still finish;
- explicit ``maxToolErrors`` / ``maxRounds`` request params still stop
  the turn at that wall.
"""

from __future__ import annotations

import json
from typing import Any

from e2e_harness import (
    MockOpenAI,
    SidecarClient,
    sse_text,
    sse_tool_call,
)

#: The model-visible descriptor for the sidecar-registered ``web_fetch``;
#: dispatch resolves by name against the sidecar's own registry.
_WEB_FETCH_DESCRIPTOR: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_fetch",
        "description": "Fetch one public web page over http(s).",
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    },
}

#: Literal loopback URL: the SSRF guard rejects it before any I/O, so the
#: tool result is a fast, deterministic ``success: false`` every round.
_LOOPBACK_URL = "http://127.0.0.1:9/"


def _always_fetch_loopback(_body: dict[str, Any], index: int) -> list[dict[str, Any]]:
    return sse_tool_call(
        "web_fetch", {"url": _LOOPBACK_URL}, call_id=f"call_{index}"
    )


def _chat_params(mock: MockOpenAI, **extra: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "provider": "openai_compat",
        "model": "mock-e2e",
        "baseUrl": mock.base_url,
        "apiKey": "e2e-not-a-real-key",
        "messages": [
            {"role": "user", "content": "Keep fetching the status page."}
        ],
        "tools": [_WEB_FETCH_DESCRIPTOR],
        "useCoreLoop": True,
    }
    params.update(extra)
    return params


async def _run_turn(
    client: SidecarClient, mock: MockOpenAI, **extra: Any
) -> dict[str, Any]:
    result = await client.request("agent.chat.stream", _chat_params(mock, **extra))
    stream_id = result["streamId"]
    return await client.wait_for_notification(
        "stream.done",
        predicate=lambda p: p.get("streamId") == stream_id,
        timeout=120.0,
    )


def _failed_tool_results(client: SidecarClient) -> list[dict[str, Any]]:
    out = []
    for payload in client.notifications:
        if payload.get("method") != "stream.chunk":
            continue
        result = (payload.get("params") or {}).get("toolResult")
        if result is not None and result.get("success") is False:
            out.append(result)
    return out


def _fetch_then_finish(_body: dict[str, Any], index: int) -> list[dict[str, Any]]:
    """20 failing fetches, then a normal completion.

    The old shipped cap (16 consecutive tool errors) would fail the turn
    before this finish is reached.
    """
    if index >= 20:
        return sse_text("done")
    return _always_fetch_loopback(_body, index)


async def test_default_does_not_stop_at_the_old_error_cap(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    """No explicit limits: 20 consecutive tool failures do not end the turn."""
    mock = mock_openai(_fetch_then_finish)
    client = await sidecar_factory()

    done = await _run_turn(client, mock)

    assert done["ok"] is True
    assert done["status"] == "completed"
    # indices 0..19 fail, index 20 finishes.
    assert len(mock.requests) == 21
    failures = _failed_tool_results(client)
    assert len(failures) == 20
    assert all("non-public address" in (f.get("error") or "") for f in failures)


async def test_explicit_max_tool_errors_win_over_spec(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    mock = mock_openai(_always_fetch_loopback)
    client = await sidecar_factory()

    done = await _run_turn(client, mock, maxToolErrors=5)

    assert done["status"] == "failed"
    assert "too many consecutive tool errors" in done["reason"]
    assert len(mock.requests) == 5


async def test_explicit_max_rounds_win_over_spec(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    mock = mock_openai(_always_fetch_loopback)
    client = await sidecar_factory()

    done = await _run_turn(client, mock, maxRounds=2)

    assert done["ok"] is False
    assert done["status"] == "budget_exhausted"
    assert "maxRounds=2" in done["reason"]
    assert len(mock.requests) == 2


async def test_spec_max_rounds_governs_over_entrypoint_baseline(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    """An explicit error cap stops the turn; the default round cap does not.

    40 consecutive failures run to completion of that cap. The old
    hardcoded round wall (32) would have ended the turn earlier with
    ``budget_exhausted``.
    """
    mock = mock_openai(_always_fetch_loopback)
    client = await sidecar_factory()

    done = await _run_turn(client, mock, maxToolErrors=40)

    assert done["status"] == "failed"
    assert "too many consecutive tool errors" in done["reason"]
    assert len(mock.requests) == 40


async def test_every_request_carries_the_tool_result_of_the_last_round(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    """Sanity anchor for the request-count assertions above: the mock sees
    the loop actually iterate (each new request extends the transcript with
    the previous round's failed tool message)."""
    mock = mock_openai(_always_fetch_loopback)
    client = await sidecar_factory()

    done = await _run_turn(client, mock, maxToolErrors=3)

    assert done["status"] == "failed"
    assert len(mock.requests) == 3
    for index, body in enumerate(mock.requests):
        tool_messages = [m for m in body["messages"] if m.get("role") == "tool"]
        assert len(tool_messages) == index
        if tool_messages:
            last = tool_messages[-1]
            assert last.get("name") == "web_fetch"
            payload = json.loads(last["content"])
            assert payload["success"] is False
            assert "non-public address" in payload["error"]
