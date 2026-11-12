# TypeScript Runtime Example

Drives one turn through `@steerable/agent-runtime`. The runtime owns the
sidecar lifecycle — interpreter resolution, spawn, `lifecycle.ready`, typed
event stream, graceful shutdown — so the host only supplies model settings.

This is the package an external TypeScript service or desktop host installs to
run Steerable without vendoring the framework repository.

## Run

From the framework monorepo root:

```bash
pnpm install
pnpm --filter steerable-example-ts-runtime start
```

Without credentials the example still boots the sidecar and reports its tool
count, which proves the install works. Against a provider:

```bash
STEERABLE_BASE_URL=https://api.deepseek.com \
STEERABLE_API_KEY=sk-... \
STEERABLE_MODEL=deepseek-chat \
pnpm --filter steerable-example-ts-runtime start
```

Expected output:

```
[ready] sidecar pid=12345
[tools] 2 tools registered
[turn] ready
[bye] sidecar stopped
```

## Where the interpreter comes from

`resolveRuntimePython()` tries, in order:

1. `STEERABLE_SIDECAR_PYTHON`
2. the `@steerable/runtime-<target>` package npm installed for this host
3. this checkout's `.venv` (so the example runs from source)
4. `STEERABLE_PYTHON`, then `python3`

A packed install has no checkout, so step 2 is the one that matters there.

## Notes

- `agent-shell` is the host shell (browser/desktop surfaces, storage, HTTP
  routes). This example uses `agent-runtime` alone: no storage, no UI.
- Cancel and steer are on the same handle: `runtime.cancelChat(streamId)` and
  `runtime.steerChat(streamId, text)`.
