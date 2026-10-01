# @steerable/agent-cli

Product-neutral command line for a Steerable host. Products wrap `createCli` and supply the bin name. A bare invocation opens the TUI when stdin is a terminal; `tui` opens it explicitly. Other commands are `run`, `chat`, `skills`, `mcp`, `config`, and `doctor`.

`pnpm test:tui` runs the deterministic renderer and interaction cases on every supported operating system. `pnpm test:tui:pty` runs the built TUI in a 100×32 tmux pane on Linux. Failed state waits write the visible frame, input trace, and environment metadata under `test-results/tui/`.
