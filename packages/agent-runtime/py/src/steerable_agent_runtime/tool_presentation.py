"""Declared presentation for first-party tools.

The card and the argument that becomes the title are named here. Callers
do not infer a card from the tool-name prefix. Names absent from this table
stay undeclared; the host renders those as a generic card.

The desktop host keeps the same names in
``packages/agent-shell/ts/src/tool-presentation.ts`` and stamps the view
onto ``executed_actions``.
"""

from __future__ import annotations

from typing import Any

# card is one of generic | terminal | diff | search | read | web.
# kind is one of read | edit | delete | move | search | execute | fetch | other.
# title_from names the argument whose string value is the row title.
BUILTIN_PRESENTATIONS: dict[str, dict[str, str]] = {
    "bash": {"card": "terminal", "kind": "execute", "title_from": "command"},
    "pwsh": {"card": "terminal", "kind": "execute", "title_from": "command"},
    "bash_session": {"card": "terminal", "kind": "execute", "title_from": "command"},
    "write_stdin": {"card": "terminal", "kind": "execute", "title_from": "chars"},
    "local_exec_shell": {"card": "terminal", "kind": "execute", "title_from": "command"},
    "local_run_snippet": {"card": "terminal", "kind": "execute", "title_from": "code"},
    "local_run_script": {"card": "terminal", "kind": "execute", "title_from": "scriptId"},
    "run_code": {"card": "generic", "kind": "execute", "title_from": "description"},
    "run_js": {"card": "generic", "kind": "execute", "title_from": "description"},
    "wait_js": {"card": "generic", "kind": "execute", "title_from": "id"},
    "read_file": {"card": "read", "kind": "read", "title_from": "path"},
    "local_read_file": {"card": "read", "kind": "read", "title_from": "path"},
    "view_image": {"card": "read", "kind": "read", "title_from": "path"},
    "capture_display": {"card": "read", "kind": "read", "title_from": "target"},
    "local_list_scripts": {"card": "read", "kind": "read", "title_from": ""},
    "write_file": {"card": "diff", "kind": "edit", "title_from": "path"},
    "local_write_file": {"card": "diff", "kind": "edit", "title_from": "path"},
    "edit_file": {"card": "diff", "kind": "edit", "title_from": "path"},
    "local_edit_file": {"card": "diff", "kind": "edit", "title_from": "path"},
    "apply_patch": {"card": "diff", "kind": "edit", "title_from": ""},
    "grep": {"card": "search", "kind": "search", "title_from": "pattern"},
    "glob": {"card": "search", "kind": "search", "title_from": "pattern"},
    "tool_search": {"card": "search", "kind": "search", "title_from": "query"},
    "web_search": {"card": "web", "kind": "search", "title_from": "query"},
    "web_fetch": {"card": "web", "kind": "fetch", "title_from": "url"},
    "task_run": {"card": "generic", "kind": "other", "title_from": "task"},
    "task_send": {"card": "generic", "kind": "other", "title_from": "message"},
    "task_status": {"card": "generic", "kind": "read", "title_from": "taskId"},
    "task_result": {"card": "generic", "kind": "read", "title_from": "taskId"},
    "job_list": {"card": "generic", "kind": "read", "title_from": ""},
    "job_output": {"card": "generic", "kind": "read", "title_from": "job_id"},
    "job_kill": {"card": "generic", "kind": "delete", "title_from": "job_id"},
    "worktree_create": {"card": "generic", "kind": "other", "title_from": "name"},
    "worktree_list": {"card": "read", "kind": "read", "title_from": ""},
    "worktree_remove": {"card": "generic", "kind": "delete", "title_from": "name"},
    "get_goal": {"card": "generic", "kind": "read", "title_from": ""},
    "create_goal": {"card": "generic", "kind": "other", "title_from": "objective"},
    "update_goal": {"card": "generic", "kind": "other", "title_from": "action"},
    "present_files": {"card": "generic", "kind": "other", "title_from": ""},
    "local_open_path": {"card": "generic", "kind": "other", "title_from": "target"},
    "todo_write": {"card": "generic", "kind": "other", "title_from": ""},
    "ask_user": {"card": "generic", "kind": "other", "title_from": "intro"},
    "skill": {"card": "generic", "kind": "read", "title_from": "name"},
    "delegate_subagent": {"card": "generic", "kind": "other", "title_from": "task"},
    "mcp_list_tools": {"card": "generic", "kind": "fetch", "title_from": ""},
    "mcp_tool_exec": {"card": "generic", "kind": "fetch", "title_from": "toolName"},
    "plugin_list": {"card": "generic", "kind": "read", "title_from": ""},
    "plugin_enable": {"card": "generic", "kind": "other", "title_from": "name"},
    "plugin_disable": {"card": "generic", "kind": "delete", "title_from": "name"},
    "plugin_reload": {"card": "generic", "kind": "other", "title_from": "name"},
}

_CARDS = frozenset({"generic", "terminal", "diff", "search", "read", "web"})
_KINDS = frozenset({"read", "edit", "delete", "move", "search", "execute", "fetch", "other"})


def builtin_presentation(name: str) -> dict[str, Any] | None:
    """Return the declared view spec for ``name``, or None when undeclared."""
    spec = BUILTIN_PRESENTATIONS.get(name)
    if spec is None:
        return None
    return {**spec, "declared": True}


def present_call(
    name: str,
    arguments: dict[str, Any] | None,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the row view from a declaration. Undeclared names stay generic."""
    spec = None
    if metadata is not None:
        stored = metadata.get("presentation")
        if isinstance(stored, dict):
            spec = stored
    if spec is None:
        spec = builtin_presentation(name)
    if not spec:
        return {"card": "generic", "kind": "other", "title": name, "declared": False}
    key = spec.get("title_from")
    raw = arguments.get(key) if isinstance(key, str) and key and isinstance(arguments, dict) else None
    title = raw.strip() if isinstance(raw, str) and raw.strip() else name
    if len(title) > 80:
        title = title[:79] + "…"
    return {
        "card": spec["card"],
        "kind": spec["kind"],
        "title": title,
        "declared": True,
    }
