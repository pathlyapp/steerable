"""A scripted ACP agent, used as the external-engine peer in tests.

The point of an ACP child is that the peer is *not* ours: it decides its own
tool calls, asks for permission in its own words, and may stop early. Testing
that against the real `steerable-sidecar-acp` would tie the assertions to a
provider key; this fixture is the smallest peer that exercises every path the
client must handle — answer text, reasoning, a tool call, a permission request
that can be allowed or rejected, and a requested stop.

Run as a process (how it is spawned in tests)::

    python -m tests.acp_peer --mode allow
    python -e ACP_PEER_MODE=reject python -m tests.acp_peer

Modes:

- ``plain`` (default): one tool call, then an answer. No permission request.
- ``ask_exec``: asks permission for an ``execute`` tool before answering.
- ``ask_read``: asks permission for a ``read`` tool before answering.
- ``stop``: stops with ``refusal`` instead of finishing.
- ``slow``: never answers, so a timeout can be observed.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

import acp


def _mode() -> str:
    import os

    return os.environ.get("ACP_PEER_MODE", "plain")


class ScriptedAgent(acp.Agent):
    """An agent that follows the mode's script."""

    def __init__(self, mode: str) -> None:
        self._mode = mode
        self._connection: Any = None

    def on_connect(self, connection: Any) -> None:
        self._connection = connection

    async def initialize(self, protocol_version: int, **kwargs: Any):
        return acp.InitializeResponse(protocol_version=protocol_version)

    async def new_session(self, cwd: str, **kwargs: Any):
        return acp.NewSessionResponse(session_id="peer-session-1")

    async def authenticate(self, method_id: str, **kwargs: Any):
        return None

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any):
        task = "".join(
            getattr(part, "text", "") for part in prompt if getattr(part, "text", None)
        )
        if self._mode == "slow":
            # No answer, ever: the client's timeout is what must fire.
            await asyncio.sleep(3600)

        await self._emit_reasoning("thinking about the task")

        if self._mode in ("ask_exec", "ask_read"):
            kind = "execute" if self._mode == "ask_exec" else "read"
            decision = await self._ask_permission(kind)
            if decision == "reject":
                # The peer gives up on the call the client refused. That is
                # the behaviour the policy's `reject` path must produce.
                await self._emit_text(f"blocked: {kind}")
                return acp.PromptResponse(stop_reason="refusal")

        await self._emit_tool_call("tool-1")

        if self._mode == "stop":
            return acp.PromptResponse(stop_reason="refusal")

        await self._emit_text(f"answer to: {task.strip()}")
        return acp.PromptResponse(stop_reason="end_turn")

    async def _emit_text(self, text: str) -> None:
        await self._connection.session_update(
            "peer-session-1",
            acp.schema.AgentMessageChunk(
                session_update="agent_message_chunk",
                message_id="msg-1",
                content=acp.schema.TextContentBlock(type="text", text=text),
            ),
        )

    async def _emit_reasoning(self, text: str) -> None:
        await self._connection.session_update(
            "peer-session-1",
            acp.schema.AgentThoughtChunk(
                session_update="agent_thought_chunk",
                message_id="thought-1",
                content=acp.schema.TextContentBlock(type="text", text=text),
            ),
        )

    async def _emit_tool_call(self, tool_id: str) -> None:
        await self._connection.session_update(
            "peer-session-1",
            acp.schema.ToolCallStart(
                session_update="tool_call",
                tool_call_id=tool_id,
                title="peer's own tool title",
                kind="execute",
                status="pending",
            ),
        )

    async def _ask_permission(self, kind: str) -> str:
        """Ask the client, in this peer's own words, and read its answer.

        The option labels are deliberately unlike anything Steerable writes:
        the policy must decide from `kind`, and the labels must never appear in
        the parent's record.
        """
        response = await self._connection.request_permission(
            session_id="peer-session-1",
            tool_call=acp.schema.ToolCallUpdate(
                tool_call_id="perm-1",
                kind=kind,
                title="peer wants to run something",
                status="pending",
            ),
            options=[
                acp.schema.PermissionOption(
                    option_id="opt-allow", name="Sure, go ahead", kind="allow_once"
                ),
                acp.schema.PermissionOption(
                    option_id="opt-deny", name="No thanks", kind="reject_once"
                ),
            ],
        )
        outcome = getattr(response, "outcome", None)
        return "allow" if getattr(outcome, "outcome", "") == "selected" else "reject"


def main() -> None:
    asyncio.run(acp.run_agent(ScriptedAgent(_mode())))


if __name__ == "__main__":
    sys.exit(main())
