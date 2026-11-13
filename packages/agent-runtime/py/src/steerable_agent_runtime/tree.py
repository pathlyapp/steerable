"""Tree-wide addressing: any agent in one spawn tree can message another.

Up to now ``agent_send`` only reached an executor's **own** children — a pool
sees exactly the loops it built. That makes collaboration strictly downward:
a sibling, or the parent itself, is unaddressable no matter how the parent
choreographed the work. Real "split this refactor across four agents" needs
the other direction: an implementer telling the researcher what it found, a
reviewer asking the implementer why a test changed, a worker reporting to the
agent that spawned it.

This module is the addressing layer for that. One ``AgentTree`` per root turn
holds every addressable member, and each member is registered by the executor
that **owns** it — the only thing that can steer or resume it. So ``send``
resolves a lineage id across the whole tree and then delegates to that owner;
nothing here pokes at another agent's loop directly.

Why an explicit tree instead of "walk up and ask": resume is a parent
operation (only the owning pool holds the loop, its schemas and its budget
line), so a peer message must arrive at the owner anyway. Holding the owner's
delivery callback at registration makes that one hop instead of a recursive
search that could deadlock against a parent waiting on its child.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

__all__ = ["AgentTree", "TreeMember"]

logger = logging.getLogger(__name__)

#: Delivers a message to one member, returning the same ``steered`` /
#: ``resumed`` / ``error:*`` vocabulary ``AgentPool.send`` already uses. The
#: owner decides what a message means for its agent (steer while running,
#: resume when settled); the tree does not know.
Deliver = Callable[[str], Awaitable[str]]


@dataclass(frozen=True, slots=True)
class TreeMember:
    """One addressable agent.

    ``lineage`` is the tree id (``0`` is the root, ``0.2.1`` a grandchild), so
    a sender can name any relative: ``0`` for the agent that started
    everything, ``0.1`` for a sibling, ``0.2.1`` for a grandchild.
    """

    lineage: str
    depth: int
    parent: str | None
    profile: str | None = None

    def to_wire(self) -> dict[str, object]:
        """Camel-case payload for a tool result."""
        return {
            "childId": self.lineage,
            "depth": self.depth,
            **({"parentId": self.parent} if self.parent is not None else {}),
            **({"profile": self.profile} if self.profile else {}),
        }


class AgentTree:
    """Every addressable member of one spawn tree.

    Registration is the authorization: an agent is reachable exactly while its
    owner keeps it registered, so closing a child unregisters it and the
    address stops resolving. There is no separate permission table to drift.

    The root registers itself through ``register_root``; every other member
    registers at spawn. Membership is scoped to the tree object, which is why
    a message cannot escape into an unrelated conversation's agents.
    """

    def __init__(self) -> None:
        self._deliver: dict[str, Deliver] = {}
        self._members: dict[str, TreeMember] = {}

    # -- registration --------------------------------------------------

    def register_root(self, deliver: Deliver) -> TreeMember:
        """Make the root agent (``0``) addressable.

        Children need this to report to whoever spawned them — without it the
        only upward channel is the completion notice, which carries a status
        and no reply path.
        """
        return self._register(TreeMember(lineage="0", depth=0, parent=None), deliver)

    def register(self, member: TreeMember, deliver: Deliver) -> TreeMember:
        """Make one child addressable for as long as its owner keeps it so."""
        return self._register(member, deliver)

    def _register(self, member: TreeMember, deliver: Deliver) -> TreeMember:
        self._members[member.lineage] = member
        self._deliver[member.lineage] = deliver
        return member

    def unregister(self, lineage: str) -> None:
        """Stop resolving one address; a later send reports it as unknown."""
        self._members.pop(lineage, None)
        self._deliver.pop(lineage, None)

    # -- addressing ----------------------------------------------------

    def get(self, lineage: str) -> TreeMember | None:
        """The member at ``lineage``, or ``None`` when it is not reachable."""
        return self._members.get(lineage)

    def members(self) -> list[TreeMember]:
        """Every reachable member, root first then in registration order."""
        return sorted(self._members.values(), key=lambda m: (m.depth, m.lineage))

    def resolve(self, sender: str, target: str) -> TreeMember | None:
        """The member ``target`` names, if ``sender`` may address it.

        Two refusals, both structural rather than policy:

        - the target must be registered (an unknown or closed agent has no
          owner to deliver to);
        - a member cannot address itself — that is a no-op the model would
          read as a delivered message.

        Everything else is allowed on purpose. Siblings, parent and children
        are all in one tree because one agent created the work, and a worker
        that cannot tell a sibling what it found falls back to routing every
        fact through the parent, which is the cost this exists to remove.
        """
        if target == sender:
            return None
        return self._members.get(target)

    async def send(self, sender: str, target: str, message: str) -> str:
        """Deliver ``message`` from ``sender`` to ``target``.

        Returns the owner's delivery verdict (``steered`` / ``resumed`` /
        ``error:*``). An unaddressable target reports ``error:unknown_member``
        with the reachable ids, so a model that guessed a name can correct
        itself instead of retrying the same call.
        """
        member = self.resolve(sender, target)
        deliver = self._deliver.get(target)
        if member is None or deliver is None:
            known = ", ".join(m.lineage for m in self.members()) or "(none)"
            return (
                f"error:unknown_member: {target!r} is not reachable from this "
                f"tree; reachable: {known}"
            )
        try:
            return await deliver(message)
        except Exception as exc:  # noqa: BLE001 — a peer failure is data
            logger.warning("peer send %s -> %s failed: %s", sender, target, exc)
            return f"error:delivery_failed: {target!r}: {exc}"
