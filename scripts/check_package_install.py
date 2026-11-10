#!/usr/bin/env python3
"""Verify a packed tarball actually installs and loads on a clean consumer.

`tsc` inside the monorepo resolves workspace packages to `src/`, so it cannot
catch a package that imports a symbol only the next version's sibling exports.
A release caught this the hard way: `@steerable/agent-runtime` imported a
runtime-target constant that `@steerable/agent-protocol@0.8.5` on the registry
did not have. Publishing would have produced a package that throws
`SyntaxError: does not provide an export named` on first import.

This gate packs each publishable package with `pnpm pack` (which rewrites
`workspace:*` to the lockstep version), installs the tarball into a temporary
project, imports it, and checks that the module graph loads. It refuses to pass
when two packages in the same release disagree, because the release publishes
them together.

The release publishes every `@steerable/*` package at one version, so the
default check installs the batch together (`--local-siblings`). `--against-
registry` instead installs only the package and lets npm fetch its
dependencies from the registry, which is how an external user upgrading one
package at a time would experience it — that mode is expected to fail while a
release adds exports an older sibling lacks, and is reported as a warning.

Usage:
  python scripts/check_package_install.py                       # batch, together
  python scripts/check_package_install.py --package agent-runtime
  python scripts/check_package_install.py --against-registry    # warn-only mode
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Packages that are published and whose import graph must load on a clean host.
# Paths are relative to the repo root.
PUBLISHABLE: dict[str, str] = {
    "agent-protocol": "packages/agent-protocol/ts",
    "agent-harness": "packages/agent-harness/ts",
    "agent-runtime": "packages/agent-runtime/ts",
    "agent-client": "packages/agent-client/ts",
}

# The export each package must expose after install. A missing export is the
# exact failure this gate exists to catch.
PROBES: dict[str, str] = {
    "agent-protocol": "RUNTIME_TARGETS",
    "agent-harness": "consumeBudget",
    "agent-runtime": "AgentRuntime",
    "agent-client": "createLocalClient",
}


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)


def package_meta(directory: Path) -> dict:
    return json.loads((directory / "package.json").read_text(encoding="utf-8"))


def pack(directory: Path, out: Path) -> Path:
    """Pack one workspace package; pnpm rewrites `workspace:*` to the version."""
    result = run(["pnpm", "pack", "--pack-destination", str(out)], directory)
    if result.returncode != 0:
        raise SystemExit(f"pnpm pack failed in {directory}:\n{result.stdout}\n{result.stderr}")
    tarballs = sorted(out.glob("*.tgz"))
    if not tarballs:
        raise SystemExit(f"pnpm pack produced no tarball in {out}")
    return tarballs[-1]


def check_one(
    name: str,
    directory: Path,
    work: Path,
    siblings: dict[str, Path],
) -> list[str]:
    """@returns Human-readable failures; empty means the package loads."""
    failures: list[str] = []
    # One directory per package: `pnpm pack` writes into a shared destination,
    # and picking "the newest tarball" there hands the next package the
    # previous one.
    pack_dir = work / f"packed-{name}"
    pack_dir.mkdir()
    tarball = pack(directory, pack_dir)
    project = work / f"consumer-{name}"
    project.mkdir()
    (project / "package.json").write_text(
        json.dumps({"name": f"consumer-{name}", "private": True, "type": "module"}, indent=2) + "\n",
        encoding="utf-8",
    )
    # `npm install <path>` records the dependency under the tarball's file
    # name, which differs from the scoped package name (the tarball is
    # `steerable-agent-harness-x.tgz`, the package `@steerable/agent-harness`).
    # Installing through a package.json dependency keeps the real name.
    manifest = package_meta(directory)
    consumer = json.loads((project / "package.json").read_text(encoding="utf-8"))
    consumer["dependencies"] = {**siblings, manifest["name"]: f"file:{tarball}"}
    (project / "package.json").write_text(json.dumps(consumer, indent=2) + "\n", encoding="utf-8")
    installed = run(["npm", "install", "--no-audit", "--no-fund"], project)
    if installed.returncode != 0:
        failures.append(f"{name}: npm install failed\n{installed.stderr.strip()[:800]}")
        return failures
    probe = PROBES.get(name)
    script = (
        f"const m = await import({json.dumps(package_meta(directory)['name'])});\n"
        + (f"if (!({json.dumps(probe)} in m)) {{ console.error('missing export: {probe}'); process.exit(3); }}\n" if probe else "")
        + "console.log('ok');\n"
    )
    (project / "probe.mjs").write_text(script, encoding="utf-8")
    loaded = run(["node", "probe.mjs"], project)
    if loaded.returncode != 0:
        detail = (loaded.stderr or loaded.stdout).strip().splitlines()
        head = next((line for line in detail if "Error" in line or "missing export" in line), detail[0] if detail else "")
        failures.append(f"{name}: import failed — {head}")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", action="append", default=None, help="Limit to these package keys")
    parser.add_argument("--keep", action="store_true", help="Leave the temporary projects on disk")
    parser.add_argument(
        "--against-registry",
        action="store_true",
        help="Install dependencies from the registry instead of the local batch (warn-only)",
    )
    args = parser.parse_args(argv)

    selected = args.package or list(PUBLISHABLE)
    unknown = [name for name in selected if name not in PUBLISHABLE]
    if unknown:
        raise SystemExit(f"unknown package(s): {', '.join(unknown)}; known: {', '.join(PUBLISHABLE)}")

    work = Path(tempfile.mkdtemp(prefix="steerable-pack-check-"))
    failures: list[str] = []
    # The release publishes the batch together, so the default consumer gets
    # every selected sibling from this working tree. `--against-registry`
    # deliberately omits them to reproduce an upgrade from the last release.
    siblings: dict[str, str] = {}
    if not args.against_registry:
        for name, relative in PUBLISHABLE.items():
            if name in selected:
                continue
            directory = ROOT / relative
            pack_dir = work / f"packed-sibling-{name}"
            pack_dir.mkdir()
            tarball = pack(directory, pack_dir)
            siblings[package_meta(directory)["name"]] = f"file:{tarball}"
    try:
        for name in selected:
            failures.extend(check_one(name, ROOT / PUBLISHABLE[name], work, siblings))
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)

    if failures:
        if args.against_registry:
            for failure in failures:
                print(f"::warning::{failure}")
            print(
                "\nUpgrading one package alone is not supported: the release publishes the "
                "batch at one version. Bump every @steerable/* package together."
            )
            return 0
        for failure in failures:
            print(f"::error::{failure}")
        print("\nA package that cannot be imported after install must not be published.")
        return 1
    print(f"packaged install check ok: {', '.join(selected)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
