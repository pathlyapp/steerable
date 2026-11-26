# `steerable-cli` Reference

`steerable-cli` provides interactive TUI, headless automation, out-of-tree scenario pack authoring, dual-layer memory management, and air-gapped field deployment diagnostics.

## Commands

<!-- cli-commands-start -->
| Command | Purpose |
| --- | --- |
| `run` | Execute a single non-interactive agent turn |
| `tui` | Launch the interactive terminal workbench (default when no subcommand is given) |
| `web` | Serve the browser shell locally |
| `chat` | List, inspect, export, or delete conversations |
| `children` | Inspect or answer delegated child/subagent sessions |
| `skills` | List or inspect installed skills |
| `mcp` | List or manage MCP servers |
| `app` | List, switch (`use`), or reset (`reset`) the active `ApplicationManifest` |
| `memory` | Inspect (`list`), update (`edit`), `withdraw`, or `clear` host-isolated `MEMORY.md` notes |
| `pack` | Scaffold (`init`), AST-validate (`test`), and sign/archive (`bundle`) `.spack.tgz` scenario packs |
| `preflight` | Run air-gapped CPU (`x86-64-v2`), sandbox, disk, TLS certificate, binary, and font readiness checks |
| `diag-bundle` | Export a credential-scrubbed and content-redacted `.tgz` diagnostic bundle |
| `site-eval` | Run offline private-model tool-calling, pseudo-tool recovery, and HTTP 400 compatibility evaluation |
| `config` | Read or update local runtime settings |
| `doctor` | Check local runtime, sidecar, and model connectivity |
| `login` | Verify and store an API key interactively |
| `logout` | Remove the stored API key |
<!-- cli-commands-end -->

## Flags

<!-- cli-flags-start -->
| Flag | Type | Description |
| --- | --- | --- |
| `--help` | boolean (`-h`) | Print command or subcommand usage |
| `--version` | boolean (`-v`) | Print CLI package version |
| `--chat` | string | Target conversation ID (`run`, `diag-bundle`) |
| `--approve` | string | Approval policy (`ask`, `auto`, `read-only`, `never`) |
| `--json` | boolean | Emit machine-readable JSON output |
| `--stream-json` | boolean | Emit newline-delimited JSON events during `run` |
| `--cwd` | string | Working directory override |
| `--project` | string | Explicit project root directory |
| `--no-project` | boolean | Run unbound without attaching a project workspace |
| `--trust` | boolean | Trust the target project directory non-interactively |
| `--timeout` | string | Per-turn timeout duration |
| `--data-dir` | string | Host user-data directory override |
| `--agent` | string | Agent profile ID or slug for `run` |
| `--file` | string (repeatable) | Attach one or more input files |
| `--format` | string | Export format (`md` or `json`) |
| `--no-preflight` | boolean | Skip API-key preflight check before `run` |
| `--deep` | boolean | Run deep live probe in `doctor` |
| `--verbose` | boolean | Show debug logs on stderr |
| `--port` | string | HTTP port for `web` (0 selects an ephemeral port) |
| `--once` | boolean | Start `web`, print URL, and exit immediately |
| `--session` | string | Parent session ID for `children` |
| `--child` | string | Child lineage ID (e.g. `0.1`) for `children` |
| `--active` | boolean | Filter `children` to active runs only |
| `--wait` | boolean | Wait until answered child reaches a terminal state |
| `--scope` | string | Memory scope (`user`, `workspace`, or `tenant`) |
| `--text` | string | Markdown text payload for `memory edit` |
| `--id` | string | Scenario pack identifier for `pack init` |
| `--out` | string | Output file path for `pack bundle`, `diag-bundle`, or `site-eval` |
| `--signing-key-env` | string | Environment variable holding hex Ed25519 signing key for `pack bundle` |
| `--profile` | string | Target profile (`server` or `desktop`) for `preflight` |
| `--manifest` | string | JSON manifest of required commands, fonts, and TLS cert for `preflight` |
| `--redact-content` | boolean | Redact user/assistant/document prose to length + SHA-256 summaries (default on) |
| `--no-redact-content` | boolean | Preserve raw prose in `diag-bundle` (credentials are still scrubbed) |
| `--suite` | string | Path to evaluation case directory or JSON file for `site-eval` |
| `--model` | string | Target model identifier for `site-eval` |
| `--base-url` | string | OpenAI-compatible private model gateway URL for `site-eval` |
<!-- cli-flags-end -->
