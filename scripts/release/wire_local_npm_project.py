#!/usr/bin/env python3
"""Wire a fresh project to every tarball in a directory.

Internal packages declare each other as registry dependencies (pnpm rewrites
`workspace:*` to the lockstep version when packing), and a local batch is not on
the registry. So the project needs both: each package as a `file:` dependency,
and the same map as pnpm overrides so transitive references resolve locally.
Overrides live in `pnpm-workspace.yaml`; pnpm 10 stopped reading a `pnpm` field
in `package.json`.

Usage:
  wire_local_npm_project.py <tarball-dir> <package.json-path>
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tarfile


def manifest_of(tarball: pathlib.Path) -> dict:
    with tarfile.open(tarball) as archive:
        handle = archive.extractfile("package/package.json")
        if handle is None:
            raise SystemExit(f"{tarball} has no package/package.json")
        return json.load(handle)


def pnpm_version() -> str | None:
    """@returns The pinned `packageManager` version from this repo, if any."""
    try:
        manifest = json.loads((pathlib.Path(__file__).resolve().parents[2] / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = manifest.get("packageManager")
    if isinstance(value, str) and value.startswith("pnpm@"):
        return value.split("@", 1)[1]
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        raise SystemExit(__doc__)
    dist = pathlib.Path(argv[0])
    out = pathlib.Path(argv[1])
    deps: dict[str, str] = {}
    paths: dict[str, str] = {}
    for tarball in sorted(dist.glob("*.tgz")):
        manifest = manifest_of(tarball)
        name = manifest.get("name")
        if not isinstance(name, str):
            raise SystemExit(f"{tarball} has no package name")
        resolved = str(tarball.resolve())
        deps[name] = f"file:{resolved}"
        paths[name] = resolved
    if not deps:
        raise SystemExit(f"no tarballs in {dist}")
    manifest: dict[str, object] = {
        "name": "verify",
        "private": True,
        "type": "module",
        "dependencies": deps,
    }
    pinned = pnpm_version()
    if pinned:
        # Without this, corepack resolves the newest pnpm in the scratch
        # directory and behaviours differ (overrides moved out of package.json
        # in pnpm 10).
        manifest["packageManager"] = f"pnpm@{pinned}"
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # pnpm 10 moved overrides out of `package.json`: the `pnpm` field is no
    # longer read, and without them a transitive `@steerable/...@<version>`
    # reference is fetched from the registry, where a local batch does not
    # exist yet.
    workspace = out.parent / "pnpm-workspace.yaml"
    # Overrides take a bare path/version spec; a `file:` prefix is read as part
    # of the path here (`ENOENT ... /file:/...`).
    lines = ["overrides:"] + [f'  "{name}": "{path}"' for name, path in sorted(paths.items())]
    workspace.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"    {len(deps)} local packages wired")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
