# Steerable Tauri host

Reusable native desktop host shipped inside the `@steerable/agent-shell` npm
package. Consuming products keep a thin `src-tauri` crate that supplies Tauri
configuration and calls `steerable_agent_shell_tauri::run`.

The host supervises the product's compiled Node BS entry on an ephemeral
loopback port. Node continues to own storage, PTY, tools, approvals, packs,
and CoreLoop sidecars. Rust owns the native window, menus, dialogs,
single-instance behavior, screenshot clipboard transfer, process containment,
resource paths, and updates.

The crate is source-distributed with the npm package and is not published to
crates.io.

Packaged products place the complete portable Python sidecar at
`python-runtime/<platform>` and the verified egress proxy at
`engine/steerable-egress-proxy`. The Python runtime contains the native Rust
CoreLoop engine. An optional `engine/python-runner` is only a child interpreter
for `run_code`; it never hosts the sidecar. Products may set `pythonRunner` to `sidecar`, `bundle`,
or `download` in `product.json`. Sidecar mode runs `run_code` with the packaged sidecar interpreter
instead of a second CPython; the child stays confined by the `run_code` sandbox, but it can import the
sidecar's installed packages. Download mode starts the product without an interpreter and
lets the settings UI install one in the background. The default
python-build-standalone archive is checked against the packaged SHA-256; users
may instead choose an unverified custom archive URL or an existing Python 3.9+
executable. Download progress is emitted to the renderer, and the selected
interpreter is passed as `STEERABLE_PYTHON` on the next application start.
