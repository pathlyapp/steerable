# @steerable/agent-cli

## [Unreleased]

### Breaking Changes

* `run` and `tui` bind the current directory as a project. Pass `--no-project` to keep a separate workspace for each chat. `--project` and `--cwd` name the directory to bind.
* Node.js 26.4.0 is required. On an older Node, the bin, `doctor`, `tui`, and `run` print the required version and the installed version, then exit 1.

### Added

* `run` and `tui` accept `--approve deny|allow-read|allow-all`. The default is `deny`. `allow-all` prints a warning. A denied approval exits 3.
* `--trust` marks the bound project trusted and loads its rule files. It cannot be combined with `--no-project`.
* `doctor` prints whether the installed Node meets 26.4.0.
* A tool already covered by “allow for this chat” shows 本会话已允许.

### Changed

* Help text and the protected-directory message use the running command name (`aroli`, `steerable-cli`) instead of the `<product>` placeholder.
