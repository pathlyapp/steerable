"""Tree-wide addressing: any agent in one job can message any other.

The failure this removes: ``agent_send`` only reached an executor's own
children, so collaboration was strictly downward. Four agents splitting one
refactor could not tell each other anything — every fact went back through the
parent, which is the context that fills up first on a job big enough to need
four agents.

Two properties are load-bearing:

- **Registration is the authorization.** An agent is reachable exactly while
  its owner kept it registered, so closing a child makes its address stop
  resolving instead of resuming something the owner gave up on.
- **Delivery goes through the owner**, because only the owning pool holds the
  loop it must steer or resume. The tree resolves an id; it never touches
  another agent's loop.
"""

from __future__ import annotations

import pytest

from steerable_agent_runtime.tree import AgentTree, TreeMember


def _tree() -> tuple[AgentTree, list[tuple[str, str]]]:
    """A root plus two children, recording every delivery."""
    delivered: list[tuple[str, str]] = []

    def make(name: str):
        async def deliver(message: str) -> str:
            delivered.append((name, message))
            return "steered"

        return deliver

    tree = AgentTree()
    tree.register_root(make("0"))
    tree.register(TreeMember(lineage="0.1", depth=1, parent="0", profile="coder"), make("0.1"))
    tree.register(TreeMember(lineage="0.2", depth=1, parent="0"), make("0.2"))
    return tree, delivered


@pytest.mark.asyncio
async def test_a_child_reaches_its_parent() -> None:
    """The upward direction was the missing one: only notices went up."""
    tree, delivered = _tree()

    verdict = await tree.send("0.1", "0", "found the config flag")

    assert verdict == "steered"
    assert delivered == [("0", "found the config flag")]


@pytest.mark.asyncio
async def test_siblings_reach_each_other() -> None:
    """The case the whole slice exists for: two workers handing off facts."""
    tree, delivered = _tree()

    assert await tree.send("0.1", "0.2", "the parser lives in lex.py") == "steered"
    assert await tree.send("0.2", "0.1", "thanks, tests pass") == "steered"
    assert delivered == [
        ("0.2", "the parser lives in lex.py"),
        ("0.1", "thanks, tests pass"),
    ]


@pytest.mark.asyncio
async def test_an_unknown_member_names_what_is_reachable() -> None:
    """A model that guessed an id can correct itself in the same turn."""
    tree, delivered = _tree()

    verdict = await tree.send("0.1", "0.9", "hello")

    assert verdict.startswith("error:unknown_member")
    assert "0.1" in verdict and "0.2" in verdict
    assert delivered == []


@pytest.mark.asyncio
async def test_an_agent_cannot_message_itself() -> None:
    """A self-send would read as delivered work that never happened."""
    tree, delivered = _tree()

    verdict = await tree.send("0.1", "0.1", "note to self")

    assert verdict.startswith("error:unknown_member")
    assert delivered == []


@pytest.mark.asyncio
async def test_closing_a_child_makes_its_address_stop_resolving() -> None:
    """Closing is the owner's "never again"; the address must follow."""
    tree, delivered = _tree()

    tree.unregister("0.2")
    verdict = await tree.send("0.1", "0.2", "still there?")

    assert verdict.startswith("error:unknown_member")
    assert delivered == []


@pytest.mark.asyncio
async def test_a_failing_delivery_reports_the_reason() -> None:
    """A peer failure is data for the sender, not an exception up the stack."""
    tree = AgentTree()
    tree.register_root(lambda _message: _boom())

    verdict = await tree.send("0.1", "0", "hi")

    assert verdict.startswith("error:delivery_failed")
    assert "boom" in verdict


async def _boom() -> str:
    raise RuntimeError("boom")


def test_members_are_listed_root_first() -> None:
    tree, _ = _tree()
    tree.register(TreeMember(lineage="0.1.1", depth=2, parent="0.1"), lambda _m: _boom())

    assert [m.lineage for m in tree.members()] == ["0", "0.1", "0.2", "0.1.1"]


def test_registration_returns_the_member_for_the_owner_to_keep() -> None:
    tree = AgentTree()
    member = tree.register(
        TreeMember(lineage="0.3", depth=1, parent="0"), lambda _m: _boom()
    )

    assert member.to_wire() == {"childId": "0.3", "depth": 1, "parentId": "0"}
    assert tree.get("0.3") is member
