"""Tree-wide messaging, as a tool layer any agent in the job can carry.

The spawn tree (``tree.py``) decides who is reachable; this module is what
puts that decision in front of a model. It lives apart from
``orchestration.py`` because messaging and delegating are different
permissions that happen to share a tree:

- delegating is bounded by depth — a ``max_depth=1`` child must not spawn;
- messaging is not — the whole point of a shared tree is that a worker can
  hand a finding to a sibling or answer the agent that spawned it.

Two surfaces carry it. ``OrchestrationExecutor`` answers these names where it
advertises the full family; ``PeerToolsExecutor`` wraps a child that gets no
family at all (a depth-limited worker, or a ``delegate_subagent`` child),
giving it exactly ``agent_send`` and ``agent_list``.
"""

from __future__ import annotations

import json
from typing import Any

from steerable_agent_protocol.generated import ToolCall, ToolResult

from .loop import LoopContext, ToolExecutor
from .pool import OrchestrationConfig
from .tree import AgentTree

__all__ = [
    "PeerToolsExecutor",
    "peer_schemas",
    "send_tool_descriptor",
    "tool_schema",
]


def tool_schema(
    name: str, description: str, properties: dict, required: list[str]
) -> dict[str, Any]:
    """One OpenAI function schema.

    Shared by the three tool families so their JSON has one shape — a host
    that strict-validates ``additionalProperties: false`` should not have to
    special-case which family a schema came from.
    """
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        },
    }


def send_tool_descriptor(config: OrchestrationConfig) -> dict[str, Any]:
    """Schema for ``agent_send``, described as tree-wide rather than downward.

    The description is the documentation a model actually reads: it has to say
    that a sibling and the root are addressable, or a worker will keep routing
    every fact through the parent — the behaviour this slice exists to remove.
    """
    return tool_schema(
        config.send_tool,
        "Send a message to another agent in this job. A running agent "
        "receives it at its next round boundary (steer); a finished or "
        "interrupted one is resumed with the message as a follow-up turn, "
        "keeping its prior context. Any member of the job is addressable by "
        "lineage id — `0` is the agent that started it, `0.2` a sibling, "
        "`0.2.1` a child — so workers can hand facts to each other instead of "
        "routing everything through the parent. Call agent_list to see the "
        "ids. Closed agents reject sends.",
        {
            "childId": {
                "type": "string",
                "description": "Lineage id of the target agent (`0`, `0.2`, `0.2.1`).",
            },
            "message": {"type": "string"},
        },
        ["childId", "message"],
    )


def peer_schemas(config: OrchestrationConfig) -> list[dict[str, Any]]:
    """The two schemas a leaf agent is advertised: send and list."""
    return [
        send_tool_descriptor(config),
        tool_schema(
            config.list_tool,
            "List the agents in this job with their lineage id, depth and "
            "profile — the ids `agent_send` accepts. `self` is your own id.",
            {},
            [],
        ),
    ]


class PeerToolsExecutor:
    """ToolExecutor decorator: ``agent_send`` / ``agent_list`` over a tree.

    For an agent that has no orchestration family — a depth-limited worker, or
    a ``delegate_subagent`` child — and therefore no other way to speak to a
    peer. Nested agents do not use it: their ``OrchestrationExecutor`` already
    answers both names, and wrapping twice would answer once too often.
    """

    def __init__(
        self,
        inner: ToolExecutor,
        tree: AgentTree,
        config: OrchestrationConfig,
        *,
        lineage: str,
    ) -> None:
        self._inner = inner
        self._tree = tree
        self._config = config
        #: Who this agent is on the tree, so the tree can refuse a self-send
        #: and the result can name the sender.
        self._lineage = lineage

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        if call.name == self._config.send_tool:
            return await self._send(call)
        if call.name == self._config.list_tool:
            return self._list()
        return await self._inner.execute(call, ctx)

    async def _send(self, call: ToolCall) -> ToolResult:
        target = str(call.arguments.get("childId") or "").strip()
        message = str(call.arguments.get("message") or "").strip()
        if not message:
            return ToolResult(success=False, error="empty message")
        # The tree owns reachability: its refusal already names every address
        # this agent has (and covers a self-send), which is what lets a model
        # that guessed an id correct itself in the same turn.
        verdict = await self._tree.send(self._lineage, target, message)
        if verdict.startswith("error:"):
            return ToolResult(
                success=False,
                error=verdict[len("error:"):],
                needsFollowup=True,
            )
        member = self._tree.get(target)
        return ToolResult(
            success=True,
            message=json.dumps(
                {
                    "childId": target,
                    "delivery": verdict,
                    **({"depth": member.depth} if member is not None else {}),
                }
            ),
            data={"childId": target, "delivery": verdict},
        )

    def _list(self) -> ToolResult:
        """Every live member, with this agent's own id.

        ``children`` is present and empty so a leaf and a nested agent answer
        the same tool with the same keys; a host that reads only that key sees
        an honest "none", not a missing field.
        """
        members = [member.to_wire() for member in self._tree.members()]
        return ToolResult(
            success=True,
            message=json.dumps(
                {"children": [], "members": members, "self": self._lineage}
            ),
            data={"count": 0},
        )

    def dedup_exempt(self, call: ToolCall) -> bool:
        # A send is stateful: the same message twice is two deliveries, and a
        # repeated list must observe what a send changed.
        if call.name in {self._config.send_tool, self._config.list_tool}:
            return True
        inner_exempt = getattr(self._inner, "dedup_exempt", None)
        return bool(inner_exempt and inner_exempt(call))

    def concurrency_safe(self, call: ToolCall) -> bool:
        # A send mutates another agent's inbox and, on resume, awaits its
        # first step; serial execution keeps the order the model emitted.
        if call.name in {self._config.send_tool, self._config.list_tool}:
            return False
        inner_safe = getattr(self._inner, "concurrency_safe", None)
        return bool(inner_safe and inner_safe(call))
