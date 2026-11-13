"""E2E: `stream.done` reports the whole turn tree's token spend.

Layer choice: the tree counter is assembled inside the sidecar process (one
per turn, shared by the parent and every child), so the honest observation
point is the wire of a real ``python -m steerable_sidecar``.

What is proven through the real process:

- every turn carries ``treeUsage`` with the spend attributed to the parent, so
  a host can show the turn's real cost without walking the registry;
- there is no limit in the object, and none is enforced: a turn that spends a
  lot is reported, not stopped. This used to be gated on the request's
  ``budgetTokens``; the gate is gone because stopping a task partway through
  costs the work already done.
"""

from __future__ import annotations

import json
from typing import Any

from e2e_harness import MockOpenAI, SidecarClient


def _greeting(_body: dict[str, Any], _index: int) -> list[dict[str, Any]]:
    """One short answer with a token bill attached.

    The bill matters here: without one the tree has nothing to record and
    `spent > 0` would be unprovable rather than wrong.
    """
    return [
        {"choices": [{"index": 0, "delta": {"content": "hello"}}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": 120, "completion_tokens": 8, "total_tokens": 128}},
    ]


def _params(mock: MockOpenAI, **extra: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "provider": "openai_compat",
        "model": "mock-e2e",
        "baseUrl": mock.base_url,
        "apiKey": "e2e-not-a-real-key",
        "messages": [{"role": "user", "content": "hi"}],
        "useCoreLoop": True,
    }
    params.update(extra)
    return params


async def _run_turn(
    client: SidecarClient, mock: MockOpenAI, **extra: Any
) -> dict[str, Any]:
    result = await client.request("agent.chat.stream", _params(mock, **extra))
    stream_id = result["streamId"]
    return await client.wait_for_notification(
        "stream.done",
        predicate=lambda p: p.get("streamId") == stream_id,
        timeout=60.0,
    )


async def test_stream_done_reports_the_tree_spend(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    mock = mock_openai(_greeting)
    client = await sidecar_factory()

    done = await _run_turn(client, mock)

    assert done["ok"] is True
    assert done["status"] == "completed"
    tree = done["treeUsage"]
    # The parent's own request is recorded, so the spend is non-zero and
    # attributed to the parent agent.
    assert tree["spent"] > 0
    assert tree["byAgent"].get("parent", 0) > 0


async def test_tree_usage_carries_no_limit(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    """The number is for display; a limit field would imply enforcement.

    ``budgetTokens`` may still be present in the request (it bounds the single
    run, a separate mechanism), but it must not surface as a tree-level cap —
    nothing compares the spend against it.
    """
    mock = mock_openai(_greeting)
    client = await sidecar_factory()

    done = await _run_turn(client, mock)

    assert "limit" not in done["treeUsage"]


async def test_tree_usage_is_json(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    mock = mock_openai(_greeting)
    client = await sidecar_factory()

    done = await _run_turn(client, mock)

    tree = done["treeUsage"]
    # It crossed the wire, so it is JSON by construction; assert it survives a
    # round trip unchanged rather than merely being serialisable.
    assert json.loads(json.dumps(tree)) == tree
