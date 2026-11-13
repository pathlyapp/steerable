"""Parent-side delivery of child-agent terminal notices.

A parent that spawned children has two ways to learn one finished: poll
``agent_wait``, or be told. Polling costs a whole model round per check and,
worse, the model has to *remember* to look. This hook closes that gap: when a
child of this pool settles, the notice is appended to the parent's transcript
at its next round boundary.

Design notes that matter for correctness:

- The notice is a **system-role** message with its own record kind
  (``subagent.notice``). It is not a user message: nothing about it came from
  the user, and a model that treats it as an instruction from the user would
  be misreading the conversation.
- The notice carries **no child text**. The answer still comes from
  ``agent_wait``; putting the answer here would duplicate the child's output
  into the parent's context on every finish, and the parent may never read it.
- Delivery is idempotent per child: each notice is drained exactly once, so a
  settled child cannot re-notify on every later step.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .hooks import NoopHooks, PreStepAction, TranscriptAppend
from .llm import LLMMessage

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .loop import LoopContext
    from .pool import AgentPool

__all__ = ["CHILD_NOTICE_KIND", "ChildNoticeHooks"]

#: Record kind for the injected notice. ``<feature>.<name>`` like the other
#: injected fragments (``skills.catalog``, ``world_state.patch``), so a replay
#: can tell it apart from anything the user or the model said.
CHILD_NOTICE_KIND = "subagent.notice"


class ChildNoticeHooks(NoopHooks):
    """``pre_step``: append notices for children that settled since last step.

    One instance per parent loop. Wrap it in a ``ChainHooks`` with whatever
    else the host installs — this hook only ever appends; it never rewrites,
    never rejects, and never changes tool choice.
    """

    def __init__(self, pool: AgentPool) -> None:
        self._pool = pool

    async def pre_step(
        self, transcript: list[LLMMessage], ctx: "LoopContext"
    ) -> PreStepAction:
        notices = self._pool.drain_notices()
        if not notices:
            return PreStepAction(kind="proceed")
        appends = [
            TranscriptAppend(
                message=LLMMessage.text_of("system", render_child_notice(*notice)),
                kind=CHILD_NOTICE_KIND,
            )
            for notice in notices
        ]
        return PreStepAction(
            kind="proceed",
            appends=appends,
            append_action="child_notice",
        )


def render_child_notice(child_id: str, status: str, answer: str) -> str:
    """The notice text.

    A system message, so it reads as harness bookkeeping rather than as either
    party speaking. The one line of guidance matters: without it a model that
    sees "child 0.2 completed" tends to narrate the completion instead of
    collecting the answer.
    """
    settled = "finished" if status == "completed" else f"ended with status {status}"
    return (
        f"[sub-agent notice] Sub-agent {child_id} {settled}. "
        "Its answer is not included here; call agent_wait to read it."
    )
