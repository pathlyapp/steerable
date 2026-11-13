"""A fork that runs on another model: allowed, but its cost is stated.

Running a child on a cheaper model while it inherits the parent's findings is
the case this exists for. It is also the case where the parent's prompt cache
is worthless — the cache key is bound to the model — so the spawn result has
to say `cacheNote: "cold"` rather than let the turn look as cheap as a
same-model fork.

The rejected alternative is Codex's: changing model forces
`fork_turns="none"`, which throws away the context that made the fork worth
doing.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import CoreLoop, LoopConfig, RouterToolExecutor, ToolRouter
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk
from steerable_agent_runtime.orchestration import (
    OrchestrationConfig,
    OrchestrationExecutor,
)

PARENT = "chat/p"


class _NamingProvider:
    """Answers with its own model name, so the child's route is observable."""

    name = "fake"

    def __init__(self, model: str) -> None:
        self.model = model

    async def complete(self, messages: Any, *, tools: Any = None, **kw: Any):  # pragma: no cover
        raise NotImplementedError

    def stream(self, messages: Any, *, tools: Any = None, **kw: Any) -> AsyncIterator[LLMStreamChunk]:
        model = self.model

        async def _gen() -> AsyncIterator[LLMStreamChunk]:
            yield LLMStreamChunk(content_delta=f"answered by {model}")

        return _gen()


def _transcript() -> list[LLMMessage]:
    return [
        LLMMessage.text_of("user", "which keel version is pinned?"),
        LLMMessage.text_of("assistant", "keel is pinned at 1.0.8."),
    ]


def _executor(
    provider: Any,
    *,
    factory: Any = None,
    parent_model: str | None = "deepseek-chat",
) -> OrchestrationExecutor:
    return OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        provider,
        OrchestrationConfig(),
        parent_projection=_transcript,
        parent_route=lambda: (parent_model, None),
        provider_factory=factory,
    )


@pytest.mark.asyncio
async def test_a_cross_model_fork_reports_a_cold_cache() -> None:
    child: list[str] = []

    def factory(model: str | None, effort: str | None):
        child.append(f"{model}/{effort}")
        return _NamingProvider(str(model))

    executor = _executor(_NamingProvider("deepseek-chat"), factory=factory)

    result = await executor.execute(
        ToolCall(
            id="s1",
            name="agent_spawn",
            arguments={
                "task": "confirm the version",
                "context": "fork",
                "model": "glm-5.3-flash",
            },
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.pool.wait("0.1", 5)
    await executor.shutdown()

    assert result.success is True, result.error
    payload = json.loads(result.message or "{}")
    assert payload["cacheNote"] == "cold"
    assert payload["forkRoute"]["parentModel"] == "deepseek-chat"
    assert payload["forkRoute"]["childModel"] == "glm-5.3-flash"
    # The child really ran on the other model, and inherited the findings.
    assert child == ["glm-5.3-flash/None"]
    handle = executor.pool.get("0.1")
    assert handle is not None
    assert handle.outcome is not None
    assert "answered by glm-5.3-flash" in handle.outcome.answer


@pytest.mark.asyncio
async def test_a_same_route_fork_carries_no_cache_note() -> None:
    """Naming the parent's own model must not claim a cache miss."""
    executor = _executor(
        _NamingProvider("deepseek-chat"),
        factory=lambda model, effort: _NamingProvider(str(model)),
    )

    result = await executor.execute(
        ToolCall(
            id="s1",
            name="agent_spawn",
            arguments={
                "task": "confirm",
                "context": "fork",
                "model": "deepseek-chat",
            },
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.pool.wait("0.1", 5)
    await executor.shutdown()

    payload = json.loads(result.message or "{}")
    assert "cacheNote" not in payload
    assert "forkRoute" not in payload


@pytest.mark.asyncio
async def test_changing_the_route_without_a_fork_is_refused() -> None:
    """A fresh child has no parent route to diverge from."""
    executor = _executor(
        _NamingProvider("deepseek-chat"),
        factory=lambda model, effort: _NamingProvider(str(model)),
    )

    result = await executor.execute(
        ToolCall(
            id="s1",
            name="agent_spawn",
            arguments={"task": "t", "model": "glm-5.3-flash"},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert 'context="fork"' in (result.error or "")


@pytest.mark.asyncio
async def test_changing_the_route_without_a_factory_is_refused() -> None:
    """Not silently ignored: the caller asked for something this host cannot do."""
    executor = _executor(_NamingProvider("deepseek-chat"))

    result = await executor.execute(
        ToolCall(
            id="s1",
            name="agent_spawn",
            arguments={
                "task": "t",
                "context": "fork",
                "model": "glm-5.3-flash",
            },
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.shutdown()

    assert result.success is False
    assert "provider" in (result.error or "")


@pytest.mark.asyncio
async def test_a_fork_child_records_the_seed_provenance() -> None:
    """The child's own record must explain where its opening context came from.

    Written as one `seed` entry with `source_record_id`, so `agent.session.tree`
    reads a fork child edge the same way it reads a branch fork.
    """
    from steerable_agent_runtime import ChildRegistry
    from steerable_agent_runtime.storage import InMemoryStorage

    store = InMemoryStorage()
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _NamingProvider("deepseek-chat"),
        OrchestrationConfig(),
        registry=ChildRegistry(store),
        parent_record_id=PARENT,
        history_store=store,
        parent_projection=_transcript,
        parent_route=lambda: ("deepseek-chat", None),
    )

    await executor.execute(
        ToolCall(
            id="s1",
            name="agent_spawn",
            arguments={"task": "confirm", "context": "fork"},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.pool.wait("0.1", 5)
    await executor.shutdown()

    record_id = f"{PARENT}:child:0.1"
    entries = await store.list_history(record_id)
    seeds = [entry for entry in entries if entry.get("entry") == "seed"]
    assert len(seeds) == 1, entries
    assert seeds[0]["source_record_id"] == PARENT
    assert seeds[0]["source_model"] == "deepseek-chat"
    assert seeds[0]["messages"], "the seeded prefix must be non-empty"


@pytest.mark.asyncio
async def test_a_fresh_child_writes_no_seed_entry() -> None:
    """Nothing was inherited, so there is no provenance to record."""
    from steerable_agent_runtime import ChildRegistry
    from steerable_agent_runtime.storage import InMemoryStorage

    store = InMemoryStorage()
    executor = OrchestrationExecutor(
        RouterToolExecutor(ToolRouter()),
        _NamingProvider("deepseek-chat"),
        OrchestrationConfig(),
        registry=ChildRegistry(store),
        parent_record_id=PARENT,
        history_store=store,
        parent_projection=_transcript,
    )

    await executor.execute(
        ToolCall(id="s1", name="agent_spawn", arguments={"task": "t"}),
        None,  # type: ignore[arg-type]
    )
    await executor.pool.wait("0.1", 5)
    await executor.shutdown()

    entries = await store.list_history(f"{PARENT}:child:0.1")
    assert [entry for entry in entries if entry.get("entry") == "seed"] == []


@pytest.mark.asyncio
async def test_a_pinned_provider_keeps_the_child_off_the_parent_model() -> None:
    """The spawn must actually use the rebuilt provider, not the parent's."""
    seen: list[str] = []

    class _Strict(_NamingProvider):
        def stream(self, messages: Any, *, tools: Any = None, **kw: Any):
            seen.append(self.model)
            return super().stream(messages, tools=tools, **kw)

    executor = _executor(
        _Strict("parent-model"),
        factory=lambda model, effort: _Strict(str(model)),
    )

    await executor.execute(
        ToolCall(
            id="s1",
            name="agent_spawn",
            arguments={"task": "t", "context": "fork", "model": "child-model"},
        ),
        None,  # type: ignore[arg-type]
    )
    await executor.pool.wait("0.1", 5)
    await executor.shutdown()

    assert seen == ["child-model"]
