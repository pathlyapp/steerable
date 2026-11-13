"""`completed_turn_prefix`: the fork seed primitive.

A fork seed must be a transcript a provider accepts and a loop can replay.
The one thing that breaks that is a **dangling tool call**, so the cut is
placed at the last assistant message whose calls are all answered.

The tests also pin the choice that differs from DSH's "drop the last turn":
a Steerable turn is one user request containing many tool rounds, so dropping
it would discard exactly the investigation a child is asked to continue.
"""

from __future__ import annotations

from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime.history import completed_turn_prefix
from steerable_agent_runtime.llm import LLMMessage


def _user(text: str) -> LLMMessage:
    return LLMMessage.text_of("user", text)


def _assistant(text: str) -> LLMMessage:
    return LLMMessage.text_of("assistant", text)


def _call(call_id: str, name: str = "work") -> LLMMessage:
    return LLMMessage.text_of(
        "assistant",
        "",
        tool_calls=[ToolCall(id=call_id, name=name, arguments={})],
    )


def _result(call_id: str, text: str = "ok") -> LLMMessage:
    return LLMMessage.text_of("tool", text, tool_call_id=call_id)


def _roles(messages: list[LLMMessage]) -> list[str]:
    return [m.role for m in messages]


def test_empty_transcript_yields_an_empty_seed() -> None:
    assert completed_turn_prefix([]) == []


def test_a_plain_conversation_is_kept_whole() -> None:
    messages = [_user("hi"), _assistant("hello"), _user("again"), _assistant("sure")]
    assert completed_turn_prefix(messages) == messages


def test_a_dangling_tool_call_is_dropped_with_its_round() -> None:
    """The in-flight round is what cannot be replayed; the work before it can."""
    messages = [
        _user("investigate"),
        _call("c1"),
        _result("c1"),
        _assistant("first finding"),
        _call("c2"),  # never answered — the turn is still running
    ]

    prefix = completed_turn_prefix(messages)

    assert _roles(prefix) == ["user", "assistant", "tool", "assistant"]
    # The seed ends on an answer, not on the dangling round.
    assert prefix[-1].role == "assistant"
    # Answered tool calls stay: they are the investigation the child continues.
    assert any(m.tool_calls for m in prefix)
    # What must not survive is an unanswered call.
    answered = {m.tool_call_id for m in prefix if m.role == "tool"}
    for message in prefix:
        for call in message.tool_calls or []:
            assert call.id in answered


def test_an_unanswered_call_inside_the_log_ends_the_prefix() -> None:
    """A later pair cannot resurrect a transcript with a hole in it."""
    messages = [
        _user("go"),
        _call("c1"),  # unanswered
        _result("c1"),
        _assistant("ok"),
    ]
    # The result *does* answer c1, so this is balanced and fully kept.
    assert completed_turn_prefix(messages) == messages

    holed = [
        _user("go"),
        _call("c1"),
        _assistant("skipping the result"),  # c1 never answered
        _result("c1"),
        _assistant("done"),
    ]
    # Nothing from the unanswered call onward may enter a seed, and what
    # remains ends on a user message — so there is no completed turn at all.
    assert completed_turn_prefix(holed) == []


def test_a_result_for_an_unknown_call_does_not_balance_the_message() -> None:
    messages = [_user("go"), _call("c1"), _result("other")]
    # c1 is still unanswered, and the only thing before it is a question.
    assert completed_turn_prefix(messages) == []


def test_trailing_non_assistant_messages_are_excluded() -> None:
    """A user message with no answer yet is not part of a completed prefix."""
    messages = [_user("go"), _assistant("answer"), _user("next question")]
    assert completed_turn_prefix(messages) == [_user("go"), _assistant("answer")]


def test_a_transcript_with_no_completed_assistant_turn_is_empty() -> None:
    """No completed turn means the fork has nothing to inherit."""
    messages = [_user("go"), _call("c1")]
    assert completed_turn_prefix(messages) == []


def test_max_turns_keeps_only_the_trailing_requests() -> None:
    messages = [
        _user("first"),
        _assistant("a1"),
        _user("second"),
        _assistant("a2"),
        _user("third"),
        _assistant("a3"),
    ]

    trimmed = completed_turn_prefix(messages, max_turns=2)

    assert trimmed == [_user("second"), _assistant("a2"), _user("third"), _assistant("a3")]


def test_max_turns_zero_yields_an_empty_seed() -> None:
    messages = [_user("go"), _assistant("answer")]
    assert completed_turn_prefix(messages, max_turns=0) == []


def test_max_turns_beyond_the_transcript_keeps_everything() -> None:
    messages = [_user("go"), _assistant("answer")]
    assert completed_turn_prefix(messages, max_turns=9) == messages


def test_a_steer_injection_does_not_break_the_balance() -> None:
    """Steering appends a user message mid-turn; the prefix must still close
    on an answered assistant message rather than on the injection."""
    messages = [
        _user("go"),
        _call("c1"),
        _result("c1"),
        _user("also check the version"),
        _assistant("checked"),
    ]
    assert completed_turn_prefix(messages) == messages


def test_the_seed_is_a_prefix_of_the_input() -> None:
    """A seed must be the transcript's own opening span, never a reshuffle."""
    messages = [
        _user("a"),
        _call("c1"),
        _result("c1"),
        _assistant("b"),
        _user("c"),
        _call("c2"),
    ]
    prefix = completed_turn_prefix(messages)
    assert prefix == messages[: len(prefix)]
