"""E2E: `stream.done` reports the whole turn tree's token spend.

Layer choice: the tree budget is assembled inside the sidecar process (the
request's ``budgetTokens`` becomes one counter shared by the parent and every
child), so the honest observation point is the wire of a real
``python -m steerable_sidecar``.

What is proven through the real process:

- without ``budgetTokens`` there is no ``treeUsage`` at all — a host must be
  able to tell "no limit" from "zero spent";
- with it, ``stream.done`` carries the limit and the spend, attributed to the
  parent, so a host can show the turn's real cost without walking the registry.
"""

from __future__ import annotations

import json
from typing import Any

from e2e_harness import MockOpenAI, SidecarClient


def _greeting(_body: dict[str, Any], _index: int) -> list[dict[str, Any]]:
    """One short answer with a token bill attached.

    The bill matters here: without one the tree has nothing to charge and
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


async def test_stream_done_omits_tree_usage_without_budget_tokens(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    mock = mock_openai(_greeting)
    client = await sidecar_factory()

    done = await _run_turn(client, mock)

    assert done["ok"] is True
    assert done["status"] == "completed"
    # No limit was asked for, so there is nothing to report. A zeroed object
    # here would read as "spent nothing", a different claim from "no budget".
    assert "treeUsage" not in done


async def test_stream_done_reports_the_tree_limit_and_spend(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    mock = mock_openai(_greeting)
    client = await sidecar_factory()

    done = await _run_turn(client, mock, budgetTokens=100_000)

    assert done["status"] == "completed"
    tree = done["treeUsage"]
    assert tree["limit"] == 100_000
    # The parent's own request is charged, so the spend is non-zero and
    # attributed to the parent agent.
    assert tree["spent"] > 0
    assert tree["byAgent"].get("parent", 0) > 0


async def test_tree_usage_is_json_and_within_its_own_limit(
    e2e_gate: None, sidecar_factory: Any, mock_openai: Any
) -> None:
    mock = mock_openai(_greeting)
    client = await sidecar_factory()

    done = await _run_turn(client, mock, budgetTokens=100_000)

    tree = done["treeUsage"]
    # It crossed the wire, so it is JSON by construction; assert it survives a
    # round trip unchanged rather than merely being serialisable.
    assert json.loads(json.dumps(tree)) == tree
    assert tree["spent"] <= tree["limit"]
