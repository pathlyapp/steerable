#!/usr/bin/env python3
"""Verify a packed release batch actually installs and loads.

`tsc` inside the monorepo resolves workspace packages to `src/`, so it cannot
catch a package that imports a symbol only the next version's sibling exports.
A release was caught this way: `@steerable/agent-runtime` imported a
runtime-target constant that `@steerable/agent-protocol@0.8.5` on the registry
did not have, and the published package would have thrown
`SyntaxError: ... does not provide an export named` on first import.

The gate packs every publishable package with `pnpm pack` (which rewrites
`workspace:*` to the lockstep version), installs the whole batch once into a
temporary project, then imports each package by its published name and runs the
CLI's bin. One install, many checks: reinstalling per package made the gate slow
enough to be skipped, which is worse than not having it.

Usage:
  python scripts/check_package_install.py
  python scripts/check_package_install.py --package agent-runtime
  python scripts/check_package_install.py --keep   # leave the project on disk
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Kept identical to the package list in .github/workflows/publish-npm.yml.
# A package missing here is a package whose install is never verified.
PUBLISHABLE: dict[str, str] = {
    "agent-protocol": "packages/agent-protocol/ts",
    "agent-harness": "packages/agent-harness/ts",
    "pack-sdk": "packages/pack-sdk/ts",
    "agent-ui": "packages/agent-ui/ts",
    "agent-runtime": "packages/agent-runtime/ts",
    "agent-client": "packages/agent-client/ts",
    "agent-shell": "packages/agent-shell/ts",
    "agent-shell-web": "packages/agent-shell/web",
    "agent-cli": "packages/agent-cli/ts",
}

# A symbol each package must expose after install. A missing one is the exact
# failure this gate exists to catch. An empty string asserts only that the
# entry point resolves and exports something.
PROBES: dict[str, str] = {
    "agent-protocol": "RUNTIME_TARGETS",
    "agent-harness": "consumeBudget",
    "agent-runtime": "AgentRuntime",
    "agent-client": "createLocalClient",
    "agent-ui": "",
}

# Packages with no runnable entry point. `pack-sdk` ships `.d.ts` only;
# `agent-shell` and `agent-shell-web` expose subpaths (`./host-tools`,
# `./vite.base`) and no package root, so a bare `import` is not a supported
# use. For these the assertion is that the declared entry files are present in
# the installed tree — a tarball missing its `dist/`, `src/` or `types/` is the
# failure that matters.
FILE_ONLY: dict[str, tuple[str, ...]] = {
    "pack-sdk": ("types/index.d.ts",),
    "agent-shell": ("dist/runtime.js",),
    "agent-shell-web": ("src/auth/gate.ts",),
}

# Packages whose install scripts must run for the tarball to be usable. Kept in
# step with `onlyBuiltDependencies` in the repository's pnpm-workspace.yaml.
BUILT_DEPENDENCIES = ("better-sqlite3", "esbuild", "node-pty")

# The CLI is checked as an installed command: its bin entry point is the
# surface a user gets.
BIN_PROBES: dict[str, str] = {"agent-cli": "--version"}


# Per-step timing, printed when STEERABLE_PACK_CHECK_TIMING is set. The gate is
# slow enough that "which step" is the first question when it looks stuck.
TIMING = bool(os.environ.get("STEERABLE_PACK_CHECK_TIMING"))


def publishable_manifests() -> list[tuple[str, dict]]:
    """@returns Each publishable package's name and manifest."""
    return [(meta["name"], meta) for meta in (package_meta(ROOT / path) for path in PUBLISHABLE.values())]


def check_publish_config() -> list[str]:
    """Every published package must declare public access.

    Without it npm treats a scoped package as private and rejects the upload
    with `402 Payment Required — You must sign up for private packages`, which
    is how the first 0.9.0 publish stopped after `@steerable/agent-runtime`
    joined the release list.
    """
    failures: list[str] = []
    for name, manifest in publishable_manifests():
        access = (manifest.get("publishConfig") or {}).get("access")
        if access != "public":
            failures.append(f"{name}: publishConfig.access is {access!r}; npm will refuse to publish a scoped package")
        if manifest.get("private") is True:
            failures.append(f"{name}: private is true, so npm cannot publish it")
    return failures


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    started = time.monotonic()
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    if TIMING:
        print(f"        [{time.monotonic() - started:6.1f}s] {command[0]} {' '.join(command[1:])[:60]}", flush=True)
    return result


def package_meta(directory: Path) -> dict:
    return json.loads((directory / "package.json").read_text(encoding="utf-8"))


def pnpm_version() -> str | None:
    """@returns The pinned `packageManager` version from this repo, if any."""
    try:
        manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = manifest.get("packageManager")
    if isinstance(value, str) and value.startswith("pnpm@"):
        return value.split("@", 1)[1]
    return None


def pack(directory: Path, out: Path) -> Path:
    """Pack one workspace package; pnpm rewrites `workspace:*` to the version."""
    result = run(["pnpm", "pack", "--pack-destination", str(out)], directory)
    if result.returncode != 0:
        raise SystemExit(f"pnpm pack failed in {directory}:\n{result.stdout}\n{result.stderr}")
    tarballs = sorted(out.glob("*.tgz"))
    if not tarballs:
        raise SystemExit(f"pnpm pack produced no tarball in {out}")
    return tarballs[-1]


def wire_project(project: Path, tarballs: dict[str, Path]) -> None:
    """Point a clean project at the batch, directly and through overrides."""
    deps = {name: f"file:{path}" for name, path in tarballs.items()}
    manifest: dict[str, object] = {
        "name": "release-check",
        "private": True,
        "type": "module",
        "dependencies": deps,
    }
    pinned = pnpm_version()
    if pinned:
        manifest["packageManager"] = f"pnpm@{pinned}"
    (project / "package.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # Transitively a tarball asks for `@steerable/<sibling>@<version>`, which the
    # registry does not have until this release publishes. Overrides in
    # `pnpm-workspace.yaml` rewrite those to the local tarballs; pnpm 10 stopped
    # reading a `pnpm` field in package.json.
    lines = ["overrides:"] + [f'  "{name}": "{path}"' for name, path in sorted(tarballs.items())]
    # Native packages build from source on install. pnpm 10 refuses to run their
    # scripts without an allow-list here, and a skipped build leaves a module
    # that imports and then throws at first use. The repository has its own
    # list; the throwaway project needs the same one, or the gate fails on a
    # configuration gap rather than on the package.
    lines.append("onlyBuiltDependencies:")
    lines.extend(f"  - {name}" for name in BUILT_DEPENDENCIES)
    (project / "pnpm-workspace.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def check_import(project: Path, name: str, package: str, probe: str) -> list[str]:
    script = [f"const m = await import({json.dumps(package)});"]
    if probe:
        script.append(f"if (!({json.dumps(probe)} in m)) {{ console.error('missing export: {probe}'); process.exit(3); }}")
    else:
        script.append("if (Object.keys(m).length === 0) { console.error('module exports nothing'); process.exit(4); }")
    script.append("console.log('ok');")
    # Importing a package can open handles (the host client binds storage and a
    # lock file), so the probe has to exit rather than wait for the event loop
    # to drain. Without this the check hangs on `agent-client` and looks like a
    # deadlock.
    script.append("process.exit(0);")
    (project / "probe.mjs").write_text("\n".join(script) + "\n", encoding="utf-8")
    loaded = run(["node", "probe.mjs"], project)
    if loaded.returncode == 0:
        return []
    detail = (loaded.stderr or loaded.stdout).strip().splitlines()
    head = next((line for line in detail if "Error" in line or "missing export" in line), detail[0] if detail else "")
    return [f"{name}: import failed — {head}"]


def check_files(project: Path, name: str, package: str, required: tuple[str, ...]) -> list[str]:
    root = project / "node_modules" / package
    missing = [entry for entry in required if not (root / entry).is_file()]
    if missing:
        return [f"{name}: installed package is missing {', '.join(missing)}"]
    return []


def check_bin(project: Path, name: str, package: str, flag: str) -> list[str]:
    binary = project / "node_modules" / package / "dist" / "bin.js"
    if not binary.is_file():
        return [f"{name}: dist/bin.js is missing from the tarball"]
    invoked = run(["node", str(binary), flag], project)
    if invoked.returncode == 0:
        return []
    detail = (invoked.stderr or invoked.stdout).strip().splitlines()
    return [f"{name}: `{flag}` exited {invoked.returncode} — {detail[0] if detail else ''}"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", action="append", default=None, help="Limit the checks to these keys")
    parser.add_argument("--keep", action="store_true", help="Leave the temporary project on disk")
    args = parser.parse_args(argv)

    selected = args.package or list(PUBLISHABLE)
    unknown = [name for name in selected if name not in PUBLISHABLE]
    if unknown:
        raise SystemExit(f"unknown package(s): {', '.join(unknown)}; known: {', '.join(PUBLISHABLE)}")

    config_failures = check_publish_config()
    if config_failures:
        for failure in config_failures:
            print(f"::error::{failure}")
        return 1

    work = Path(tempfile.mkdtemp(prefix="steerable-pack-check-"))
    project = work / "consumer"
    project.mkdir()
    failures: list[str] = []
    try:
        tarballs: dict[str, Path] = {}
        for name, relative in PUBLISHABLE.items():
            directory = ROOT / relative
            pack_dir = work / f"packed-{name}"
            pack_dir.mkdir()
            tarballs[package_meta(directory)["name"]] = pack(directory, pack_dir)
        print(f"    packed {len(tarballs)} packages")

        print("    wiring project", flush=True)
        wire_project(project, tarballs)
        print("    installing (first run downloads the whole dependency tree)", flush=True)
        installed = run(["pnpm", "install", "--no-frozen-lockfile"], project)
        if installed.returncode != 0:
            detail = (installed.stdout + "\n" + installed.stderr).strip()
            print(f"::error::installing the release batch failed\n{detail[:1500]}")
            return 1

        print("    installed; checking", flush=True)
        for name in selected:
            print(f"      {name}", flush=True)
            package = package_meta(ROOT / PUBLISHABLE[name])["name"]
            if name in BIN_PROBES:
                failures.extend(check_bin(project, name, package, BIN_PROBES[name]))
            elif name in FILE_ONLY:
                failures.extend(check_files(project, name, package, FILE_ONLY[name]))
            else:
                failures.extend(check_import(project, name, package, PROBES.get(name, "")))
    finally:
        if args.keep:
            print(f"kept {project}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    if failures:
        for failure in failures:
            print(f"::error::{failure}")
        print("\nA package that cannot be imported after install must not be published.")
        return 1
    print(f"packaged install check ok: {', '.join(selected)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
