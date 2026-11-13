"""``describe_transport_error`` — keep an empty httpx message diagnosable.

Regression: a proxy that accepts ``CONNECT`` and then drops the tunnel
surfaces as ``httpx.ConnectError('')``; httpcore raised it from an empty
``anyio.EndOfStream``, whose own cause is the ``ssl.SSLEOFError`` that says
what happened. Formatting ``{exc}`` alone logged ``transport error: `` and
left nothing to act on (observed as the whole failure text in the desktop
log), so the chain is what the message must carry.
"""

from __future__ import annotations

import itertools
import socket

import httpx
import pytest
from steerable_agent_runtime.llm.errors import describe_transport_error


def _chained(*exceptions: BaseException) -> BaseException:
    """Link ``exceptions`` outer→inner through ``__cause__``."""
    for outer, inner in itertools.pairwise(exceptions):
        outer.__cause__ = inner
    return exceptions[0]


def _gaierror() -> BaseException:
    return socket.gaierror(8, "nodename nor servname provided, or not known")


def test_empty_message_reports_the_cause_that_explains_it() -> None:
    inner = EOFError("")
    inner.__cause__ = ConnectionResetError("[SSL: UNEXPECTED_EOF_WHILE_READING] EOF")
    outer = httpx.ConnectError("")
    outer.__cause__ = inner

    described = describe_transport_error(outer)

    assert described.startswith("ConnectError")
    assert "EOFError" in described
    assert "UNEXPECTED_EOF_WHILE_READING" in described


def test_ordinary_messages_keep_their_text_and_class() -> None:
    described = describe_transport_error(
        httpx.ConnectError("All connection attempts failed")
    )
    assert described == "ConnectError: All connection attempts failed"


def test_no_message_anywhere_still_names_the_classes() -> None:
    """Silence must not come back: class names are the fallback."""
    described = describe_transport_error(
        _chained(httpx.ReadTimeout(""), TimeoutError(""))
    )
    assert described == "ReadTimeout <- TimeoutError"


def test_cycle_terminates() -> None:
    first = httpx.ConnectError("outer")
    second = EOFError("inner")
    first.__cause__ = second
    second.__cause__ = first
    assert describe_transport_error(first) == "ConnectError: outer <- EOFError: inner"


def test_depth_is_bounded() -> None:
    """A long chain is truncated, not concatenated without limit."""
    hops = [httpx.ConnectError(f"hop {index}") for index in range(20)]
    for outer, inner in itertools.pairwise(hops):
        outer.__cause__ = inner
    described = describe_transport_error(hops[0])
    assert described.count(" <- ") == 5


def test_adjacent_empty_hops_of_one_class_collapse() -> None:
    """httpcore re-wraps its own ConnectError on the proxy path."""
    inner = httpx.ConnectError("")
    inner.__cause__ = EOFError("peer closed the tunnel")
    outer = httpx.ConnectError("")
    outer.__cause__ = inner

    assert describe_transport_error(outer) == (
        "ConnectError <- EOFError: peer closed the tunnel"
    )


def test_same_class_with_a_message_is_kept() -> None:
    """Collapsing applies to nameless hops only; text is always kept."""
    inner = httpx.ConnectError("inner detail")
    outer = httpx.ConnectError("outer detail")
    outer.__cause__ = inner

    assert describe_transport_error(outer) == (
        "ConnectError: outer detail <- ConnectError: inner detail"
    )


def test_suppressed_context_is_not_reported() -> None:
    """``raise ... from None`` means the hidden exception stays hidden."""
    outer = httpx.ReadTimeout("no response")
    outer.__context__ = _gaierror()
    outer.__suppress_context__ = True

    assert "nodename" not in describe_transport_error(outer)


def test_context_is_followed_when_cause_is_absent() -> None:
    outer = httpx.ReadTimeout("no response")
    outer.__context__ = _gaierror()
    outer.__suppress_context__ = False

    assert "nodename nor servname" in describe_transport_error(outer)


@pytest.mark.parametrize("attribute", ["__cause__", "__context__"])
def test_implicit_context_is_followed(attribute: str) -> None:
    """A path that sets only ``__context__`` must still explain itself."""
    outer = httpx.WriteTimeout("")
    setattr(outer, attribute, _gaierror())
    assert "nodename nor servname" in describe_transport_error(outer)


@pytest.mark.asyncio
async def test_provider_surfaces_the_chain_to_the_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The provider's ``LLMError`` is what the sidecar logs and the host shows."""
    from steerable_agent_runtime.llm import LLMMessage
    from steerable_agent_runtime.llm.errors import LLMError
    from steerable_agent_runtime.llm.openai_compat import OpenAICompatProvider

    def handler(_request: httpx.Request) -> httpx.Response:
        tunnel = httpx.ConnectError("")
        tunnel.__cause__ = _gaierror()
        raise tunnel

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )

    provider = OpenAICompatProvider("openai_compat", "m", "https://example.invalid/v1")
    with pytest.raises(LLMError) as caught:
        async for _chunk in provider.stream([LLMMessage.text_of("user", "hi")]):
            pass

    message = str(caught.value)
    assert caught.value.kind == "transport"
    assert message.startswith("openai_compat: transport error: ConnectError")
    assert "nodename nor servname" in message


@pytest.mark.asyncio
async def test_provider_reports_the_proxy_the_request_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The failure names the hop so a support report can name it too."""
    from steerable_agent_runtime.llm import LLMMessage
    from steerable_agent_runtime.llm.errors import LLMError
    from steerable_agent_runtime.llm.openai_compat import OpenAICompatProvider

    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    monkeypatch.setattr(
        "steerable_agent_runtime.llm.openai_compat.egress_path",
        lambda _url: _EgressPath(proxy="http://127.0.0.1:7890"),
    )

    provider = OpenAICompatProvider("openai_compat", "m", "https://example.invalid/v1")
    with pytest.raises(LLMError) as caught:
        async for _chunk in provider.stream([LLMMessage.text_of("user", "hi")]):
            pass

    assert caught.value.proxy == "http://127.0.0.1:7890"


class _EgressPath:
    def __init__(self, proxy: str | None) -> None:
        self.proxy = proxy


@pytest.mark.asyncio
async def test_direct_requests_report_no_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from steerable_agent_runtime.llm import LLMMessage
    from steerable_agent_runtime.llm.errors import LLMError
    from steerable_agent_runtime.llm.openai_compat import OpenAICompatProvider

    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    monkeypatch.setattr(
        "steerable_agent_runtime.llm.openai_compat.egress_path",
        lambda _url: _EgressPath(proxy=None),
    )

    provider = OpenAICompatProvider("openai_compat", "m", "https://example.invalid/v1")
    with pytest.raises(LLMError) as caught:
        async for _chunk in provider.stream([LLMMessage.text_of("user", "hi")]):
            pass

    assert caught.value.proxy is None


def test_message_never_ends_at_an_empty_class_name_when_a_cause_exists() -> None:
    """The failure mode that started this: `transport error: ` with nothing after.

    A proxy that accepts CONNECT and drops the tunnel produces an outer
    `ConnectError('')` whose cause chain names the real problem. Whatever the
    chain looks like, the text must not stop at the outer hop.
    """
    outer = httpx.ConnectError("")
    middle = httpx.ConnectError("")
    inner = ConnectionResetError("[Errno 54] Connection reset by peer")
    middle.__cause__ = inner
    outer.__cause__ = middle

    described = describe_transport_error(outer)

    assert "ConnectError" in described
    assert "ConnectionResetError" in described
    assert "[Errno 54]" in described


@pytest.mark.asyncio
async def test_force_direct_provider_keeps_the_proxy_out_of_its_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A direct-connection provider must not report a hop it did not take."""
    from steerable_agent_runtime.llm import LLMMessage
    from steerable_agent_runtime.llm.errors import LLMError
    from steerable_agent_runtime.llm.openai_compat import OpenAICompatProvider

    captured: dict[str, object] = {}

    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client(**kwargs: object) -> httpx.AsyncClient:
        captured.update(kwargs)
        return real_client(transport=transport, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7890")

    provider = OpenAICompatProvider(
        "openai_compat",
        "m",
        "https://example.invalid/v1",
        force_direct=True,
    )
    with pytest.raises(LLMError) as caught:
        async for _chunk in provider.stream([LLMMessage.text_of("user", "hi")]):
            pass

    assert captured.get("mounts") == {"all://example.invalid": None}
    assert caught.value.proxy is None
