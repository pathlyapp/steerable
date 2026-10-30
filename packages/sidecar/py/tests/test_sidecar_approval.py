"""Wave 3: sidecar approval wiring — ``approval`` param on chat.stream.

``{"mode": "auto"}`` is the headless policy (safe modes auto-approve, the
rest auto-deny — the run never hangs); ``{"mode": "host"}`` asks the host UI
over the reverse channel and fails closed when the host can't answer.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime.llm import LLMStreamChunk, LLMUsage

from steerable_sidecar.sidecar import Sidecar


class _ScriptedProvider:
    name = "scripted"
    model = "scripted-model"

    def __init__(self, script: list[list[LLMStreamChunk]]):
        self._script = script
        self._round = 0
        self.seen_tools: list[object] = []

    async def complete(self, *args, **kwargs):
        raise NotImplementedError

    def stream(self, messages, **kwargs):
        self.seen_tools.append(kwargs.get("tools"))
        chunks = self._script[min(self._round, len(self._script) - 1)]
        self._round += 1

        async def _gen():
            for chunk in chunks:
                yield chunk

        return _gen()


def _text_round(text: str) -> list[LLMStreamChunk]:
    return [
        LLMStreamChunk(content_delta=text),
        LLMStreamChunk(
            finish_reason="stop",
            usage=LLMUsage(prompt_tokens=5, completion_tokens=1, total_tokens=6),
        ),
    ]


def _tool_round(call: ToolCall) -> list[LLMStreamChunk]:
    return [
        LLMStreamChunk(tool_call_delta=call),
        LLMStreamChunk(
            finish_reason="tool_calls",
            usage=LLMUsage(prompt_tokens=5, completion_tokens=1, total_tokens=6),
        ),
    ]


class _CapturingTransport:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def emit_notification(self, method: str, params: dict | None = None) -> None:
        self.events.append((method, params or {}))

    async def aclose(self) -> None:
        return None


class _HostWriter:
    """Pretends to be the Electron host: answers reverse ``tool.invoke``
    requests from a scripted table and ``approval.request`` from a decision
    table (``None`` = no handler, never responds)."""

    def __init__(self, server, results: dict[str, dict], approvals: dict | None = None):
        self._server = server
        self._results = results
        self._approvals = approvals
        self.reverse_calls: list[dict] = []
        self.approval_requests: list[dict] = []

    def write(self, data: bytes):
        payload = json.loads(data)
        if not (isinstance(payload.get("id"), str) and payload.get("method")):
            return len(data)
        if payload["method"] == "tool.invoke":
            self.reverse_calls.append(payload["params"])
            if payload["params"]["name"] not in self._results:
                return len(data)
            result = self._results[payload["params"]["name"]]
        elif payload["method"] == "approval.request":
            self.approval_requests.append(payload["params"])
            if self._approvals is None:
                return len(data)  # no handler → never responds
            result = self._approvals
        else:
            return len(data)

        async def _respond() -> None:
            await self._server.handle_frame(
                json.dumps({"jsonrpc": "2.0", "id": payload["id"], "result": result})
            )

        asyncio.ensure_future(_respond())
        return len(data)

    async def drain(self) -> None:
        return None


def _frame(method: str, params: dict | None = None) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


async def _run_stream(sidecar: Sidecar, params: dict) -> None:
    response = await sidecar.server.handle_frame(_frame("agent.chat.stream", params))
    assert "error" not in response, response
    task = sidecar._streams.get(response["result"]["streamId"])
    if task is not None:
        await task


def _base_params(**extra) -> dict:
    return {
        "provider": "openai_compat",
        "model": "fake",
        "messages": [{"role": "user", "content": "go"}],
        "useCoreLoop": True,
        "toolsViaHost": True,
        **extra,
    }


@pytest.mark.asyncio
async def test_auto_mode_denies_unsafe_tool_without_host_roundtrip() -> None:
    provider = _ScriptedProvider(
        [
            # local_exec_shell classifies as "other" → AutoApprover denies.
            _tool_round(ToolCall(id="c1", name="local_exec_shell", arguments={"command": "ls"})),
            _text_round("cannot run that"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(sidecar.server, {"local_exec_shell": {"success": True}})
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar, _base_params(approval={"mode": "auto"}, chatId="chat-auto")
    )

    # Denied before reaching the host: no tool.invoke reverse call happened.
    assert host.reverse_calls == []
    events = sidecar._transport.events  # type: ignore[attr-defined]
    results = [p for m, p in events if m == "stream.chunk" and "toolResult" in p]
    assert results[0]["toolResult"]["success"] is False
    assert results[0]["toolResult"]["error"] == "approval_denied"
    done = [p for m, p in events if m == "stream.done"]
    assert done[0]["status"] == "completed"  # denial feeds back, run continues


@pytest.mark.asyncio
async def test_auto_mode_allows_read_tool() -> None:
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="read_file", arguments={"path": "/a"})),
            _text_round("read it"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server, {"read_file": {"success": True, "data": {"value": "x"}}}
    )
    sidecar.server.attach_writer(host)

    await _run_stream(sidecar, _base_params(approval={"mode": "auto"}))

    assert [c["name"] for c in host.reverse_calls] == ["read_file"]


@pytest.mark.asyncio
async def test_host_mode_asks_and_executes_on_allow() -> None:
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="delete_file", arguments={"path": "/x"})),
            _text_round("deleted"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"delete_file": {"success": True, "data": {"value": "gone"}}},
        approvals={"kind": "allow_once", "reason": "user clicked allow"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host"},
            chatId="task:1",
            toolContext={"mode": "agent", "chatId": "chat-parent"},
        ),
    )

    assert len(host.approval_requests) == 1
    assert host.approval_requests[0]["toolName"] == "delete_file"
    assert host.approval_requests[0]["mode"] == "destructive"
    # Task streams run under task:<id>; the card belongs to the parent chat.
    assert host.approval_requests[0]["chatId"] == "chat-parent"
    assert [c["name"] for c in host.reverse_calls] == ["delete_file"]


@pytest.mark.asyncio
async def test_host_mode_skips_prompt_for_files_inside_writable_roots(tmp_path) -> None:
    project = tmp_path / "111-2"
    project.mkdir()
    pptx = project / "自我介绍.pptx"
    provider = _ScriptedProvider(
        [
            _tool_round(
                ToolCall(
                    id="c1",
                    name="present_files",
                    arguments={"files": [{"path": str(pptx)}]},
                )
            ),
            _text_round("shown"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"present_files": {"success": True, "data": {"files": []}}},
        approvals={"kind": "deny_once", "reason": "should not ask"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host"},
            execSandbox={"enabled": True, "writableRoots": [str(project)]},
        ),
    )

    assert host.approval_requests == []
    assert [c["name"] for c in host.reverse_calls] == ["present_files"]


@pytest.mark.asyncio
async def test_host_mode_still_asks_for_files_outside_writable_roots(tmp_path) -> None:
    project = tmp_path / "111-2"
    project.mkdir()
    provider = _ScriptedProvider(
        [
            _tool_round(
                ToolCall(
                    id="c1",
                    name="present_files",
                    arguments={"files": [{"path": str(tmp_path / "other.pptx")}]},
                )
            ),
            _text_round("shown"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"present_files": {"success": True, "data": {"files": []}}},
        approvals={"kind": "allow_once"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host"},
            execSandbox={"enabled": True, "writableRoots": [str(project)]},
        ),
    )

    assert len(host.approval_requests) == 1
    assert host.approval_requests[0]["toolName"] == "present_files"
    assert host.approval_requests[0]["sandboxEnforced"] is True
    assert [c["name"] for c in host.reverse_calls] == ["present_files"]


@pytest.mark.asyncio
async def test_host_mode_asks_when_a_relative_symlink_leaves_path_base(tmp_path) -> None:
    project = tmp_path / "repo"
    project.mkdir()
    outside = tmp_path / "other"
    outside.mkdir()
    (project / "escape").symlink_to(outside, target_is_directory=True)
    provider = _ScriptedProvider(
        [
            _tool_round(
                ToolCall(
                    id="c1",
                    name="present_files",
                    arguments={"files": [{"path": "escape/secret.txt"}]},
                )
            ),
            _text_round("shown"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"present_files": {"success": True, "data": {"files": []}}},
        approvals={"kind": "allow_once"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={
                "mode": "host",
                "writableRoots": [str(project)],
                "pathBase": str(project),
            },
            execSandbox={"enabled": True, "writableRoots": [str(project)]},
        ),
    )

    assert len(host.approval_requests) == 1
    assert host.approval_requests[0]["toolName"] == "present_files"
    assert [c["name"] for c in host.reverse_calls] == ["present_files"]


@pytest.mark.asyncio
async def test_host_mode_skips_in_project_files_when_exec_sandbox_is_off(tmp_path) -> None:
    project = tmp_path / "111-2"
    project.mkdir()
    provider = _ScriptedProvider(
        [
            _tool_round(
                ToolCall(
                    id="c1",
                    name="present_files",
                    arguments={"files": [{"path": str(project / "自我介绍.pptx")}]},
                )
            ),
            _text_round("shown"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"present_files": {"success": True, "data": {"files": []}}},
        approvals={"kind": "deny_once", "reason": "should not ask"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host", "writableRoots": [str(project)]},
            execSandbox={"enabled": False, "writableRoots": []},
        ),
    )

    assert host.approval_requests == []
    assert [c["name"] for c in host.reverse_calls] == ["present_files"]


@pytest.mark.asyncio
async def test_host_mode_skips_prompt_for_sandboxed_shell_inside_writable_roots(tmp_path) -> None:
    project = tmp_path / "111-2"
    (project / "notes").mkdir(parents=True)
    provider = _ScriptedProvider(
        [
            _tool_round(
                ToolCall(
                    id="c1",
                    name="local_exec_shell",
                    arguments={"command": "touch a.md", "cwd": str(project / "notes")},
                )
            ),
            _text_round("wrote"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"local_exec_shell": {"success": True, "data": {"stdout": ""}}},
        approvals={"kind": "deny_once", "reason": "should not ask"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host", "writableRoots": [str(project)]},
            execSandbox={"enabled": True, "writableRoots": [str(project)], "requireBackend": False},
        ),
    )

    assert host.approval_requests == []
    assert [c["name"] for c in host.reverse_calls] == ["local_exec_shell"]


@pytest.mark.asyncio
async def test_host_mode_still_asks_for_shell_when_exec_sandbox_is_off(tmp_path) -> None:
    project = tmp_path / "111-2"
    project.mkdir()
    provider = _ScriptedProvider(
        [
            _tool_round(
                ToolCall(
                    id="c1",
                    name="local_exec_shell",
                    arguments={"command": "ls", "cwd": str(project)},
                )
            ),
            _text_round("ran"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"local_exec_shell": {"success": True, "data": {"stdout": ""}}},
        approvals={"kind": "allow_once"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host", "writableRoots": [str(project)]},
            execSandbox={"enabled": False, "writableRoots": []},
        ),
    )

    assert len(host.approval_requests) == 1
    assert host.approval_requests[0]["toolName"] == "local_exec_shell"
    assert host.approval_requests[0]["sandboxEnforced"] is False
    assert [c["name"] for c in host.reverse_calls] == ["local_exec_shell"]


@pytest.mark.asyncio
async def test_steer_to_full_clears_sandbox_enforced_on_the_next_approval(tmp_path) -> None:
    """A mid-turn switch to full access is on the next card, not the one already sent."""
    started = asyncio.Event()
    release = asyncio.Event()
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="delete_file", arguments={"path": "/x"})),
            _tool_round(ToolCall(id="c2", name="delete_file", arguments={"path": "/y"})),
            _text_round("done"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]

    class _GateWriter(_HostWriter):
        def __init__(self) -> None:
            super().__init__(
                sidecar.server,
                {"delete_file": {"success": True}},
                approvals={"kind": "allow_once"},
            )
            self._held = False

        def write(self, data: bytes):
            payload = json.loads(data)
            if (
                not self._held
                and payload.get("method") == "tool.invoke"
                and isinstance(payload.get("id"), str)
            ):
                self._held = True
                self.reverse_calls.append(payload["params"])
                started.set()

                async def _later() -> None:
                    await release.wait()
                    await self._server.handle_frame(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": payload["id"],
                                "result": {"success": True},
                            }
                        )
                    )

                asyncio.ensure_future(_later())
                return len(data)
            return super().write(data)

    host = _GateWriter()
    sidecar.server.attach_writer(host)
    project = tmp_path / "proj"
    project.mkdir()
    response = await sidecar.server.handle_frame(
        _frame(
            "agent.chat.stream",
            _base_params(
                approval={"mode": "host", "writableRoots": [str(project)]},
                execSandbox={"enabled": True, "writableRoots": [str(project)]},
            ),
        )
    )
    assert "error" not in response, response
    stream_id = response["result"]["streamId"]
    task = sidecar._streams.get(stream_id)
    assert task is not None
    await asyncio.wait_for(started.wait(), timeout=2)
    assert host.approval_requests[0]["sandboxEnforced"] is True
    steer = await sidecar.server.handle_frame(
        _frame(
            "agent.chat.steer",
            {"streamId": stream_id, "content": "改成完整权限", "execPolicy": "full"},
        )
    )
    assert steer["result"] == {"ok": True}
    release.set()
    await task
    assert [item["sandboxEnforced"] for item in host.approval_requests] == [True, False]


@pytest.mark.asyncio
async def test_host_mode_denial_skips_execution() -> None:
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="delete_file", arguments={"path": "/x"})),
            _text_round("ok, keeping it"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"delete_file": {"success": True}},
        approvals={"kind": "deny_once", "reason": "user said no"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(sidecar, _base_params(approval={"mode": "host"}))

    assert host.reverse_calls == []
    events = sidecar._transport.events  # type: ignore[attr-defined]
    results = [p for m, p in events if m == "stream.chunk" and "toolResult" in p]
    assert results[0]["toolResult"]["error"] == "approval_denied"


@pytest.mark.asyncio
async def test_host_mode_unreachable_host_fails_closed() -> None:
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="delete_file", arguments={"path": "/a"})),
            _text_round("denied anyway"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    # No approval handler on the host → the request is never answered.
    host = _HostWriter(
        sidecar.server, {"delete_file": {"success": True}}, approvals=None
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(approval={"mode": "host", "timeoutMs": 100}),
    )

    # A call that still prompts fails closed when the host never answers.
    # Declared or name-inferred read tools do not ask, so they are not this case.
    assert host.reverse_calls == []
    events = sidecar._transport.events  # type: ignore[attr-defined]
    results = [p for m, p in events if m == "stream.chunk" and "toolResult" in p]
    assert results[0]["toolResult"]["error"] == "approval_denied"


@pytest.mark.asyncio
async def test_session_decision_carries_across_turns_of_one_chat() -> None:
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="delete_file", arguments={"path": "/a"})),
            _text_round("done one"),
            _tool_round(ToolCall(id="c2", name="delete_file", arguments={"path": "/b"})),
            _text_round("done two"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"delete_file": {"success": True, "data": {"value": "gone"}}},
        approvals={"kind": "allow_for_session"},
    )
    sidecar.server.attach_writer(host)

    params = _base_params(approval={"mode": "host"}, chatId="chat-session")
    await _run_stream(sidecar, params)
    await _run_stream(sidecar, params)

    # Both turns executed the tool, but the host was asked only once — the
    # second turn's decision came from the chat's session cache.
    assert [c["name"] for c in host.reverse_calls] == ["delete_file", "delete_file"]
    assert len(host.approval_requests) == 1
    assert host.approval_requests[0]["chatId"] == "chat-session"


@pytest.mark.asyncio
async def test_no_approval_param_keeps_legacy_behavior() -> None:
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="delete_file", arguments={"path": "/x"})),
            _text_round("done"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(sidecar.server, {"delete_file": {"success": True}})
    sidecar.server.attach_writer(host)

    await _run_stream(sidecar, _base_params())

    # No approval layer: the call goes straight to the host, no ask.
    assert [c["name"] for c in host.reverse_calls] == ["delete_file"]
    assert host.approval_requests == []


# ─── W2.4: policy rules + amendments ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_policy_rule_allows_without_host_roundtrip(tmp_path) -> None:
    """A matching allow rule decides; the host is never asked."""
    import json as _json

    policy_file = tmp_path / "policy.json"
    policy_file.write_text(
        _json.dumps(
            {
                "version": 1,
                "rules": [
                    {
                        "tool": "shell",
                        "decision": "allow",
                        "commandPrefix": ["echo"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="shell", arguments={"command": "echo hi"})),
            _text_round("done"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"shell": {"success": True, "data": {"value": "hi"}}},
        approvals={"kind": "deny_once", "reason": "host would deny — must not be asked"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(approval={"mode": "host", "policyPath": str(policy_file)}),
    )

    assert host.approval_requests == []  # rule short-circuited the prompt
    assert [c["name"] for c in host.reverse_calls] == ["shell"]  # executed


@pytest.mark.asyncio
async def test_policy_rule_denies_without_host_roundtrip(tmp_path) -> None:
    import json as _json

    policy_file = tmp_path / "policy.json"
    policy_file.write_text(
        _json.dumps(
            {
                "version": 1,
                "rules": [{"tool": "shell", "decision": "deny", "commandPrefix": ["rm"]}],
            }
        ),
        encoding="utf-8",
    )
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="shell", arguments={"command": "rm -rf /x"})),
            _text_round("ok, not deleting"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"shell": {"success": True, "data": {"value": "deleted"}}},
        approvals={"kind": "allow_once"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(approval={"mode": "host", "policyPath": str(policy_file)}),
    )

    assert host.approval_requests == []
    assert host.reverse_calls == []  # never executed


@pytest.mark.asyncio
async def test_host_amendment_persists_and_applies_within_the_run(tmp_path) -> None:
    """The host approves with an amendment; the next matching call in the
    SAME run is not re-asked, and the rule lands on disk for future runs."""
    import json as _json

    policy_file = tmp_path / "policy.json"
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="shell", arguments={"command": "echo one"})),
            _tool_round(ToolCall(id="c2", name="shell", arguments={"command": "echo two"})),
            _text_round("done"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {"shell": {"success": True, "data": {"value": "ok"}}},
        approvals={
            "kind": "allow_once",
            "amendment": {"decision": "allow", "commandPrefix": ["echo"]},
        },
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(approval={"mode": "host", "policyPath": str(policy_file)}),
    )

    # Asked once (first echo); the amendment covered the second.
    assert len(host.approval_requests) == 1
    assert [c["name"] for c in host.reverse_calls] == ["shell", "shell"]

    persisted = _json.loads(policy_file.read_text(encoding="utf-8"))
    assert persisted["rules"] == [
        {"tool": "shell", "decision": "allow", "commandPrefix": ["echo"]}
    ]


def _browser_tools() -> list[dict]:
    return [
        {
            "type": "function",
            "function": {"name": "browser_navigate", "parameters": {}},
            "mode": "external",
            "approvalCategory": "browser",
        },
        {
            "type": "function",
            "function": {"name": "browser_click", "parameters": {}},
            "mode": "external",
            "approvalCategory": "browser",
        },
        {
            "type": "function",
            "function": {"name": "browser_scroll", "parameters": {}},
            "mode": "read",
            "approvalCategory": "browser",
        },
        {
            "type": "function",
            "function": {"name": "local_read_file", "parameters": {}},
            "mode": "read",
        },
    ]


@pytest.mark.asyncio
async def test_host_mode_shares_declared_category_and_skips_read(tmp_path) -> None:
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="browser_scroll", arguments={})),
            _tool_round(ToolCall(id="c2", name="browser_navigate", arguments={"url": "https://example.com"})),
            _tool_round(ToolCall(id="c3", name="browser_click", arguments={})),
            _tool_round(ToolCall(id="c4", name="mystery_tool", arguments={})),
            _tool_round(
                ToolCall(id="c5", name="local_read_file", arguments={"path": str(tmp_path / "id_rsa")})
            ),
            _text_round("done"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {
            "browser_scroll": {"success": True},
            "browser_navigate": {"success": True},
            "browser_click": {"success": True},
            "mystery_tool": {"success": True},
            "local_read_file": {"success": True},
        },
        approvals={"kind": "allow_for_session", "reason": "ok"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host", "writableRoots": [str(tmp_path / "repo")]},
            tools=_browser_tools(),
            chatId="chat-declared",
        ),
    )

    assert [item["toolName"] for item in host.approval_requests] == [
        "browser_navigate",
        "mystery_tool",
        "local_read_file",
    ]
    assert host.approval_requests[0]["mode"] == "external"
    assert host.approval_requests[0]["category"] == "browser"
    assert host.approval_requests[1]["mode"] == "other"
    assert host.approval_requests[1]["category"] == "mystery_tool"
    assert host.approval_requests[2]["mode"] == "read"
    assert host.approval_requests[2]["category"] == "local_read_file"
    assert [call["name"] for call in host.reverse_calls] == [
        "browser_scroll",
        "browser_navigate",
        "browser_click",
        "mystery_tool",
        "local_read_file",
    ]
    sent = provider.seen_tools[0]
    assert isinstance(sent, list)
    assert all("mode" not in tool and "approvalCategory" not in tool for tool in sent)


@pytest.mark.asyncio
async def test_listed_tools_without_fields_keep_name_inference() -> None:
    """An old host omits ``mode`` and ``approvalCategory``.

    ``read_`` still skips the card. ``delete_file`` asks as destructive under
    its own name. A declared ``external`` mode without a category uses the
    tool name. The model does not see those fields.
    """
    tools = [
        {"type": "function", "function": {"name": "read_notes", "parameters": {}}},
        {"type": "function", "function": {"name": "delete_file", "parameters": {}}},
        {
            "type": "function",
            "function": {"name": "get_secret", "parameters": {}},
            "mode": "external",
        },
    ]
    provider = _ScriptedProvider(
        [
            _tool_round(ToolCall(id="c1", name="read_notes", arguments={})),
            _tool_round(ToolCall(id="c2", name="delete_file", arguments={})),
            _tool_round(ToolCall(id="c3", name="get_secret", arguments={})),
            _text_round("done"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {
            "read_notes": {"success": True},
            "delete_file": {"success": True},
            "get_secret": {"success": True},
        },
        approvals={"kind": "allow_once", "reason": "ok"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(approval={"mode": "host"}, tools=tools, chatId="chat-legacy-tools"),
    )

    assert [(item["toolName"], item["mode"], item["category"]) for item in host.approval_requests] == [
        ("delete_file", "destructive", "delete_file"),
        ("get_secret", "external", "get_secret"),
    ]
    assert [call["name"] for call in host.reverse_calls] == [
        "read_notes",
        "delete_file",
        "get_secret",
    ]
    sent = provider.seen_tools[0]
    assert isinstance(sent, list)
    assert all("mode" not in tool and "approvalCategory" not in tool for tool in sent)


@pytest.mark.asyncio
async def test_subagent_scroll_skips_the_card_and_navigate_asks() -> None:
    """A child loop uses the same approval executor as the parent.

    ``browser_scroll`` is a declared read with no path, so it runs without a
    card. ``browser_navigate`` is external and still asks. The child model
    sees the tools with the approval fields already removed.
    """
    provider = _ScriptedProvider(
        [
            _tool_round(
                ToolCall(id="d1", name="delegate_subagent", arguments={"task": "看页面"})
            ),
            _tool_round(ToolCall(id="c1", name="browser_scroll", arguments={})),
            _tool_round(
                ToolCall(
                    id="c2",
                    name="browser_navigate",
                    arguments={"url": "https://example.com"},
                )
            ),
            _text_round("child done"),
            _text_round("parent done"),
        ]
    )
    sidecar = Sidecar(llm_provider_factory=lambda _params: provider)
    sidecar._transport = _CapturingTransport()  # type: ignore[attr-defined]
    host = _HostWriter(
        sidecar.server,
        {
            "browser_scroll": {"success": True},
            "browser_navigate": {"success": True},
        },
        approvals={"kind": "allow_once", "reason": "ok"},
    )
    sidecar.server.attach_writer(host)

    await _run_stream(
        sidecar,
        _base_params(
            approval={"mode": "host"},
            tools=_browser_tools(),
            chatId="chat-child-browser",
            subagent=True,
        ),
    )

    assert [item["toolName"] for item in host.approval_requests] == ["browser_navigate"]
    assert host.approval_requests[0]["mode"] == "external"
    assert host.approval_requests[0]["category"] == "browser"
    assert [call["name"] for call in host.reverse_calls] == [
        "browser_scroll",
        "browser_navigate",
    ]
    child_tools = provider.seen_tools[1]
    assert isinstance(child_tools, list)
    names = [tool["function"]["name"] for tool in child_tools]
    assert "browser_scroll" in names
    assert "browser_navigate" in names
    assert "delegate_subagent" not in names
    assert all(
        "mode" not in tool and "approvalCategory" not in tool for tool in child_tools
    )
