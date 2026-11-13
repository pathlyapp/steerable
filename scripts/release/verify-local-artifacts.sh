#!/usr/bin/env bash
# Install dist/* artifacts into throwaway envs and run minimal real code.
#
# Two npm modes matter here and both have caught real defects:
#  * internal packages declare each other as registry dependencies, so this
#    batch is installed through `pnpm.overrides` pointing at the local tarballs;
#  * the check imports every package by name, because `tsc` in the monorepo
#    resolves workspace packages to `src/` and cannot see a symbol missing from
#    a published tarball.
set -euo pipefail

cd "$(dirname "$0")/../.."
DIST="$(pwd)/dist"

if [[ ! -d "$DIST/py" || ! -d "$DIST/npm" ]]; then
  echo "ERROR: $DIST not populated. Run ./scripts/release/build-local-artifacts.sh first." >&2
  exit 1
fi

VENV=/tmp/steerable-verify-py
NPMDIR=/tmp/steerable-verify-npm

echo "== 1/3  Python wheels into clean venv"
rm -rf "$VENV"
uv venv "$VENV" --python 3.12 >/dev/null
uv pip install --python "$VENV/bin/python" \
    "$DIST"/py/steerable_agent_protocol-*.whl \
    "$DIST"/py/steerable_agent_harness-*.whl \
    "$DIST"/py/steerable_agent_runtime-*.whl \
    "$DIST"/py/steerable_sidecar-*.whl >/dev/null
if compgen -G "$DIST/native/steerable_agent_runtime_native-*.whl" > /dev/null; then
  uv pip install --python "$VENV/bin/python" \
      "$DIST"/native/steerable_agent_runtime_native-*.whl >/dev/null
fi

"$VENV/bin/python" - <<'PY'
import asyncio
from steerable_agent_protocol import ToolCall
from steerable_agent_harness import decide_tool_mode, is_terminal_result
from steerable_agent_runtime import ToolRouter, tool

router = ToolRouter()
@tool(router=router)
async def hello(name: str = "world") -> dict:
    return {"greeting": f"Hello, {name}!"}

async def main():
    assert decide_tool_mode("read_file") == "read"
    r = await router.dispatch(ToolCall(id="c1", name="hello", arguments={"name": "Steerable"}))
    assert r.success and r.data["value"]["greeting"] == "Hello, Steerable!"
    assert not is_terminal_result(r.model_dump())
    print("PY OK:", r.data["value"])

asyncio.run(main())

try:
    import steerable_agent_runtime_native as native
except ImportError:
    print("NATIVE SKIP: host wheel not installed")
else:
    assert native.run_turn is not None
    print("NATIVE OK:", native.__version__)
PY

echo "    Sidecar boot/ping/shutdown..."
timeout 15 "$VENV/bin/python" - <<'PY'
import asyncio, json, sys
async def main():
    p = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "steerable_sidecar",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    while True:
        line = (await p.stderr.readline()).decode().rstrip()
        if line.startswith("__SIDECAR_READY__:"):
            print("    READY:", json.loads(line.split(":",1)[1])["version"])
            break
    p.stdin.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"system.ping"}).encode()+b"\n")
    await p.stdin.drain()
    while True:
        f = json.loads(await p.stdout.readline())
        if f.get("id") == 1:
            print("    PING:", f["result"]["status"]); break
    p.stdin.write(json.dumps({"jsonrpc":"2.0","id":2,"method":"system.shutdown"}).encode()+b"\n")
    await p.stdin.drain()
    await p.wait()
asyncio.run(main())
PY

echo
echo "== 2/3  npm tarballs into a clean project"
rm -rf "$NPMDIR"
mkdir -p "$NPMDIR"

# Every publishable tarball in this batch, by package name. The dependency map
# is also the override map: internal packages name each other by version, and
# this batch is not on the registry yet.
python3 scripts/release/wire_local_npm_project.py "$DIST/npm" "$NPMDIR/package.json"

( cd "$NPMDIR" && pnpm install --no-frozen-lockfile >/dev/null )

cp scripts/release/verify_npm_smoke.mjs "$NPMDIR/smoke.mjs"
( cd "$NPMDIR" && node smoke.mjs )

echo
echo "== 3/3  packed CLI loads and reports its version"
# The CLI declares internal packages as dependencies, so it only installs in
# this batch. `--version` proves the bin wiring; `--help` proves the whole
# import chain (including the renderer-free module graph) loads.
( cd "$NPMDIR" && node node_modules/@steerable/agent-cli/dist/bin.js --version )
( cd "$NPMDIR" && node node_modules/@steerable/agent-cli/dist/bin.js --help | head -3 )

echo
echo "All artifact smoke-tests passed."
