# @steerable/agent-cli

Product-neutral command line for a Steerable host. Products wrap `createCli` and supply the bin name. A bare invocation opens the TUI when stdin is a terminal; `tui` opens it explicitly. Other commands are `run`, `login`, `logout`, `web`, `chat`, `skills`, `mcp`, `config`, and `doctor`.

## Install and first run

```bash
npm install -g @steerable/agent-cli
steerable-cli login                    # provider, key, model
steerable-cli run "summarize this repo"
```

The npm package installs one `@steerable/runtime-<target>` package for the host
platform; it carries the Python sidecar, the `run_code` interpreter and the
egress proxy as optional dependencies. Nothing else has to be installed.

### Platform notes

- **pnpm** does not run install scripts by default. `better-sqlite3` and
  `node-pty` need theirs, or the CLI imports and then throws. Add them to
  `onlyBuiltDependencies` in `pnpm-workspace.yaml`; npm runs them and only
  warns.
- **Windows** needs `win-spawn-helper.exe`, which the private engine release
  does not publish yet. The CLI refuses to start a turn there rather than
  spawning unsandboxed. The package picks the helper up automatically once it
  is published.
- **linux-arm64** ships without the egress proxy for the same reason. Network
  rules there are port-only, and `run` says so on its first line.

`login` verifies the key with one model-list request before saving it, and
never saves a rejected key. In scripts and CI, skip the prompt:

```bash
export DEEPSEEK_API_KEY=sk-...
steerable-cli run "summarize this repo"
```

The provider's environment variable is read when settings carry no key. It is
never written to storage, so `config get apiKey` reports where the key came from
(`config`, `env:NAME` or `missing`) with the value masked.

The saved key lives in the local database's settings table, so the database
file and its WAL sidecars are readable only by the owner (mode 0600 on POSIX;
on Windows the file inherits the user-profile ACL).

## Browser shell

`steerable-cli web` serves the neutral shell in a browser and prints its URL.
`--port` chooses the port (`0` picks a free one) and `--once` reports the URL
then stops. The first screen configures a model when no credential is
available. A packed install ships the bundle; a source checkout needs
`pnpm agent-shell:web` first.

## Before a turn starts

`run` checks the credential before creating a chat: without a usable key it
prints the three ways to configure one and exits 78 without contacting the model
service. `--no-preflight` skips the check. A missing egress proxy prints one
warning on the first line and continues with port-level network rules, because
the host allow-list is then not enforced by domain.

`doctor` prints one row per check — Node version, data directory, sidecar
Python, `run_code` Python, egress proxy, API key source, sidecar start, busy
chats — with the command that fixes a failed row. `--json` prints the same rows
as objects with stable `id` and `status` fields; `--deep` also verifies every
runtime file against its published digest.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Turn finished |
| 1 | Turn failed |
| 2 | Usage error |
| 3 | Approval denied |
| 4 | Token budget exhausted |
| 6 | Chat held by another process |
| 75 | Data written by a newer version |
| 78 | Configuration or runtime missing (no key, no runtime, Node too old) |
| 130 | Interrupted |

## Node versions

`run`, `login`, `chat`, `config`, `mcp`, `skills` and `doctor` need Node 22.19
or newer. `tui` needs Node 26.4 because `@opentui/core` does; it checks the
version itself and explains the alternative instead of failing to import.

## Tests

`pnpm test:tui` runs the deterministic renderer and interaction cases on every supported operating system. `pnpm test:tui:pty` runs the built TUI in a 100×32 tmux pane on Linux. Failed state waits write the visible frame, input trace, and environment metadata under `test-results/tui/`.
