"""First-party tools declare a card. Registration copies it onto the tool."""

import re
from pathlib import Path

from steerable_agent_runtime.tool_presentation import (
    BUILTIN_PRESENTATIONS,
    present_call,
)
from steerable_agent_runtime.tools import ToolRouter

_TS_PRESENTATION = (
    Path(__file__).resolve().parents[4]
    / "packages/agent-shell/ts/src/tool-presentation.ts"
)


def test_builtin_table_uses_closed_card_and_kind_values():
    cards = {"generic", "terminal", "diff", "search", "read", "web"}
    kinds = {"read", "edit", "delete", "move", "search", "execute", "fetch", "other"}
    assert len(BUILTIN_PRESENTATIONS) >= 40
    for name, spec in BUILTIN_PRESENTATIONS.items():
        assert spec["card"] in cards, name
        assert spec["kind"] in kinds, name
        assert "title_from" in spec, name


def test_present_call_uses_the_declared_argument_and_not_the_name_prefix():
    view = present_call("bash", {"command": "pytest -q"})
    assert view == {
        "card": "terminal",
        "kind": "execute",
        "title": "pytest -q",
        "declared": True,
    }
    # A read-looking name that was never declared stays generic.
    undeclared = present_call("get_weather", {"city": "Shanghai"})
    assert undeclared["declared"] is False
    assert undeclared["card"] == "generic"
    assert undeclared["title"] == "get_weather"


def test_register_stores_the_declaration_on_metadata():
    router = ToolRouter()

    def bash(command: str) -> str:
        return command

    registered = router.register(bash, name="bash", mode="other", description="run")
    assert registered.metadata["presentation"]["card"] == "terminal"
    assert registered.metadata["presentation"]["declared"] is True

    def plugin_echo() -> str:
        return "ok"

    plugin = router.register(plugin_echo, name="plugin_echo", mode="read")
    assert "presentation" not in plugin.metadata


def test_caller_presentation_is_kept():
    router = ToolRouter()

    def bash(command: str) -> str:
        return command

    registered = router.register(
        bash,
        name="bash",
        mode="other",
        metadata={
            "presentation": {
                "card": "read",
                "kind": "read",
                "title_from": "path",
                "declared": True,
            }
        },
    )
    assert registered.metadata["presentation"]["card"] == "read"
    assert registered.metadata["presentation"]["title_from"] == "path"


def test_present_call_clips_long_titles_and_falls_back_to_the_name():
    long = present_call("bash", {"command": "x" * 100})
    assert long["declared"] is True
    assert len(long["title"]) == 80
    assert long["title"].endswith("…")

    goal = present_call("get_goal", {})
    assert goal == {
        "card": "generic",
        "kind": "read",
        "title": "get_goal",
        "declared": True,
    }
    assert present_call("bash", None)["title"] == "bash"


def test_python_and_typescript_tables_declare_the_same_cards():
    text = _TS_PRESENTATION.read_text()
    block = text.split("const PRESENTERS", 1)[1].split("export function presentToolCall", 1)[0]
    parts = re.split(r"(?m)^  ([a-z0-9_]+): ", block)
    typescript: dict[str, tuple[str, str]] = {}
    iterator = iter(parts[1:])
    for name, body in zip(iterator, iterator):
        card = re.search(r"card: '(\w+)'", body)
        kind = re.search(r"kind: '(\w+)'", body)
        assert card is not None and kind is not None, name
        typescript[name] = (card.group(1), kind.group(1))

    assert set(typescript) == set(BUILTIN_PRESENTATIONS)
    for name, spec in BUILTIN_PRESENTATIONS.items():
        assert typescript[name] == (spec["card"], spec["kind"]), name
