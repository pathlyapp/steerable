# @steerable/agent-cli

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
