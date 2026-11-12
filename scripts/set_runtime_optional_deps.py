#!/usr/bin/env python3
"""Point the published CLI at the platform runtime packages.

The repository keeps `@steerable/agent-cli` free of `optionalDependencies`
entries for packages that only exist after a release build: a `workspace:*`
specifier cannot resolve to something npm will install from the registry, and a
pinned version would break `pnpm install` on a fresh clone. This script writes
those entries just before publishing, and `check` verifies what a tarball would
declare.

Usage:
  python scripts/set_runtime_optional_deps.py prepare --version 0.9.0
  python scripts/set_runtime_optional_deps.py check --version 0.9.0
  python scripts/set_runtime_optional_deps.py restore
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGETS = ("darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64")
PACKAGES = (
    ROOT / "packages" / "agent-cli" / "ts" / "package.json",
    ROOT / "packages" / "agent-runtime" / "ts" / "package.json",
)


def runtime_deps(version: str) -> dict[str, str]:
    """@returns One optional dependency per published platform, pinned exactly."""
    return {f"@steerable/runtime-{target}": version for target in TARGETS}


def write(path: pathlib.Path, deps: dict[str, str] | None) -> None:
    """Adds or removes the platform dependencies without touching other bytes.

    The manifest is rewritten only when its dependency map actually changes, and
    only the `optionalDependencies` member is spliced in: re-serialising the
    whole file changes unrelated escapes (`\u2014` becomes a literal em dash)
    and leaves a diff in a file the release did not mean to edit.
    """
    text = path.read_text(encoding="utf-8")
    data = json.loads(text)
    if deps is None:
        if "optionalDependencies" not in data:
            return
        # Drop the member by round-tripping, then restore the original escapes
        # by re-encoding ASCII-only: this file has no non-ASCII payload, and
        # `json.dumps` with `ensure_ascii=True` reproduces `\uXXXX` as written.
        data.pop("optionalDependencies")
        path.write_text(json.dumps(data, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        return
    if data.get("optionalDependencies") == dict(sorted(deps.items())):
        return
    data["optionalDependencies"] = dict(sorted(deps.items()))
    path.write_text(json.dumps(data, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check", "restore"))
    parser.add_argument("--version", default=None)
    args = parser.parse_args(argv)

    if args.action == "restore":
        for path in PACKAGES:
            write(path, None)
            print(f"restored {path.relative_to(ROOT)}")
        return 0

    if not args.version:
        print("::error::--version is required for prepare and check", file=sys.stderr)
        return 2

    expected = runtime_deps(args.version)
    if args.action == "prepare":
        for path in PACKAGES:
            write(path, expected)
            print(f"prepared {path.relative_to(ROOT)} with {len(expected)} optional dependencies")
        return 0

    failures = 0
    for path in PACKAGES:
        data = json.loads(path.read_text(encoding="utf-8"))
        actual = data.get("optionalDependencies") or {}
        if actual != expected:
            print(
                f"::error::{path.relative_to(ROOT)} does not declare the platform runtimes",
                file=sys.stderr,
            )
            print(f"  expected {expected}", file=sys.stderr)
            print(f"  actual   {actual}", file=sys.stderr)
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
