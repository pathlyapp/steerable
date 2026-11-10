# @steerable/agent-cli

## [Unreleased]

### Added

* `login` and `logout`. `login` picks a provider, verifies the key with one model-list request, and saves it; a rejected key is never saved. `tui` exposes the same flow as `/login`.
* A turn checks the credential first. Without a usable key `run` prints the three ways to configure one and exits 78 before creating a chat; `--no-preflight` skips the check. `--stream-json` reports `missing_api_key`.
* `doctor` prints one row per check with the command that fixes a failed row, `--json` for scripts and `--deep` to verify every runtime file against its published digest.
* A missing egress proxy warns on the first line of `run` instead of only appearing in `doctor`.
* `config get apiKey` reports where the key came from and masks it.
* Turn failures print what happened, the command that fixes it, and the provider's own text indented below.
* `examples/ts-runtime` drives one turn through `@steerable/agent-runtime`.

### Changed

* The npm package installs the platform runtime (`@steerable/runtime-<target>`) as an optional dependency, so a global install needs no Python setup. The interpreter resolves from an explicit variable, the packaged directory, the platform package, then a repository virtualenv.
* `run`, `login`, `chat`, `config`, `mcp`, `skills` and `doctor` need Node 22.19 instead of 26.4. `tui` still needs 26.4 for its renderer and says so instead of failing to import.
* Exit codes are named and documented in `--help`: 78 for a missing configuration or runtime, 3 for a denied approval.
* No command prints a stack trace by default; `--verbose` or `STEERABLE_DEBUG=1` prints it with the log path.

## [0.7.4]

### Fixed

* An unattended `allow_once` marks the tool row, and that mark stays after the turn is reloaded. A failed tool does not get the mark.
* An allowed network egress grant shows the host, omits ports 80 and 443, and remains when the chat is opened again.
* The ask row title is the first question. An unattended answer is stored with the tool call.
* A shell command the executor will block does not open an approval card.
* The approval card for opening a page says so.

## [0.7.3]

### Fixed

* Python packages were published. The npm publish stopped because the command-line package did not typecheck.

## [0.7.2]

### Changed

* The CoreLoop native wheel pin is 1.0.5.

## [0.7.1]

### Fixed

* Web package tests typecheck in the release build.

## [0.7.0]

### Breaking Changes

* `run` and `tui` bind the current directory as a project. Pass `--no-project` to keep a separate workspace for each chat. `--project` and `--cwd` name the directory to bind.
* Node.js 26.4.0 is required. On an older Node, the bin, `doctor`, `tui`, and `run` print the required version and the installed version, then exit 1.

### Added

* `run` and `tui` accept `--approve deny|allow-read|allow-all`. The default is `deny`. `allow-all` prints a warning. A denied approval exits 3.
* `--trust` marks the bound project trusted and loads its rule files. It cannot be combined with `--no-project`.
* `doctor` prints whether the installed Node meets 26.4.0.
* A tool already covered by “allow for this chat” shows 本会话已允许.

### Changed

* Help text and the protected-directory message use the running command name (`agent`, `steerable-cli`) instead of the `<product>` placeholder.
