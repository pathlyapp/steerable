# Desktop Example

A minimal Steerable desktop application: one Tauri crate, one window, the
neutral brand. It is the starting point for shipping a product; everything
below is what you change and what you keep.

Total product code: `src-tauri/src/lib.rs` (one call) and a `tauri.conf.json`.

## Run it

```bash
cd examples/tauri-desktop/src-tauri
cargo tauri dev
```

The window loads the Node host from the product directory. The host starts the
Python sidecar, and the first screen configures a model if none is available.

## What the crate does

`steerable_agent_shell_tauri::run(context, config)` owns:

- the native window, menus, and single-instance behaviour
- the Node host process on an ephemeral loopback port, including shutdown when
  the window closes and a watchdog that restarts it once
- native dialogs, file save, screenshot clipboard transfer, and clipboard reads
- the updater plugin and its state

You supply four values:

| Value | Meaning | Example |
|---|---|---|
| `product_id` | stable identifier used in paths and update feeds | `example` |
| `product_name` | window title, menu labels, notifications | `Steerable Example` |
| `data_dir_name` | dot-directory under the user's home for chats and settings | `.steerable-example` |
| `development_root` | directory the Node host runs from | the crate's parent |

## Branding

Three layers, in order of how much you change:

1. **Strings and identifier** — the four `DesktopConfig` values, plus
   `productName` and `identifier` in `tauri.conf.json`. The bundle identifier
   must be a domain you own; the updater and single-instance lock key off it.
2. **Icon** — replace `assets/icon.png` (1024×1024) and the icon list in
   `tauri.conf.json`. Run `cargo tauri icon assets/icon.png` to regenerate the
   platform variants.
3. **Web UI brand** — a product compiles the shell's renderer through
   `createProductViteConfig` with its own brand values (display name, title,
   tagline, home hint, logo). That is where the sidebar title and the chat
   landing copy come from; the desktop crate does not carry them.

Setting `firstRunSetup: true` in the brand is the framework shell's behaviour;
a product that ships a configured model or its own onboarding leaves it off.

## Bundling the runtime

A packaged build reads everything from Tauri's resource directory, so the
packaging step has to put four things there (`<target>` is a name like
`darwin-arm64`):

```
<resources>/
  node-host/
    app-dist/          compiled Node host + product server entry
    web-dist/          the built renderer (index.html + assets)
  python-runtime/
    <target>/python/   the signed sidecar interpreter
  engine/              the Rust engine artifacts
```

The crate resolves the interpreter from `python-runtime/<target>/` and writes
`host-runtime.json` into the data directory, so the Node host finds the same
paths. A missing interpreter fails the launch with the path it looked in.

The interpreter must be the signed artifact from `sidecar-build.yml`;
`scripts/fetch_verified_artifacts.py` downloads and checks one target by name,
and the host prefers this bundled copy over any npm-installed runtime.

For an air-gapped deployment, vendor the bundle and drop the updater plugin.

## Signing and notarization

The Tauri documentation covers the platform flows. Two things to know for this
host specifically:

- macOS requires notarization for distribution outside the App Store. The app
  spawns a Node process and a Python sidecar, so the hardened runtime has to
  permit that; verify the packaged app actually launches a turn after
  notarizing, because a blocked child process only shows up at runtime.
- Windows: sign both the installer and the executable. An unsigned build
  triggers SmartScreen on first run.

Keep the updater signing key separate from the code-signing identity, and store
both outside the repository. This example ships no keys.

## What this example does not include

- Auto-update endpoints (the crate installs the plugin; you supply the feed).
- Crash reporting and telemetry.
- A custom installer UI.
- Linux desktop integration beyond the AppImage/deb Tauri produces.
