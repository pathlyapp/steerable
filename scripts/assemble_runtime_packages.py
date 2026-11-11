#!/usr/bin/env python3
"""Assemble the per-platform runtime npm packages.

The published CLI has no framework checkout and no packaged ``python-runtime/``
directory, so the interpreter and the egress proxy ship as optional npm
dependencies keyed by platform: ``@steerable/runtime-<target>``. npm installs
the one whose ``os``/``cpu`` match the host, so a single ``npm install -g`` is
enough on every supported platform.

Inputs are the artifacts CI already builds and signs:

  * ``steerable-sidecar-<target>/``  (``sidecar-build.yml``)
  * ``steerable-egress-proxy-bin-<version>-<target>`` (Rust release asset)
  * ``rust-artifacts.lock.json`` (pins the engine version)

Each package carries a ``runtime.json`` descriptor with package-relative paths
and SHA-256 digests. ``packages/agent-shell/ts/src/sidecar/platform-runtime.ts``
is the only reader; it verifies the two executables on first use and every
declared file under ``doctor --deep``.

Usage:
  python scripts/assemble_runtime_packages.py \
      --sidecar-root artifacts --egress-root artifacts --out dist/runtime

  --dry-run assembles everything and reports sizes without writing package
  metadata, so a release rehearsal can run before the artifacts exist.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# target → (npm os, npm cpu)
PLATFORM_FIELDS: dict[str, tuple[str, str]] = {
    "darwin-arm64": ("darwin", "arm64"),
    "darwin-x64": ("darwin", "x64"),
    "linux-x64": ("linux", "x64"),
    "linux-arm64": ("linux", "arm64"),
    "win32-x64": ("win32", "x64"),
}

# Files worth hashing up front: the executables the boot path runs. Everything
# under these trees is still listed, so `--deep` can verify the whole bundle.
HASHED_EXECUTABLES = ("sidecarPython", "runCodePython", "egressProxy", "winSpawnHelper")

DEFAULT_BUDGET_MB = 320


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_version(root: Path) -> str:
    lock = json.loads((root / "rust-artifacts.lock.json").read_text(encoding="utf-8"))
    version = lock.get("artifactVersion")
    if not isinstance(version, str) or not version:
        raise SystemExit("rust-artifacts.lock.json has no artifactVersion")
    return version


def package_version(root: Path) -> str:
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    return str(manifest["version"])


def find_egress(egress_root: Path, version: str, target: str) -> Path | None:
    suffix = ".exe" if target == "win32-x64" else ""
    candidate = egress_root / f"steerable-egress-proxy-bin-{version}-{target}{suffix}"
    if candidate.is_file():
        return candidate
    # `fetch_verified_artifacts.py egress` writes the binary under the cache
    # directory name it prints; accept that layout too.
    for path in sorted(egress_root.glob(f"*{target}*")):
        if path.is_file() and path.name.startswith("steerable-egress-proxy"):
            return path
    return None


def declared_files(package_dir: Path) -> list[dict[str, str]]:
    """Every shipped file except the descriptor itself, with its digest."""
    rows: list[dict[str, str]] = []
    for path in sorted(package_dir.rglob("*")):
        if not path.is_file() or path.name == "runtime.json":
            continue
        rows.append({"path": path.relative_to(package_dir).as_posix(), "sha256": sha256_file(path)})
    return rows


def sidecar_layout(bundle: Path) -> tuple[str, str]:
    """Relative interpreter paths inside a built sidecar bundle."""
    for python in ("python/bin/python3", "python/python3", "python/python.exe", "bin/python3"):
        if (bundle / python).is_file():
            return python, python
    raise SystemExit(
        f"sidecar bundle {bundle} has no python interpreter "
        "(looked for python/bin/python3, python/python3, python/python.exe, bin/python3)"
    )


def sidecar_bundle(sidecar_root: Path, target: str) -> Path | None:
    """@returns The built bundle directory for one target, or None."""
    for candidate in (sidecar_root / f"steerable-sidecar-{target}", sidecar_root / target):
        if candidate.is_dir():
            return candidate
    return None


def build_package(
    *,
    root: Path,
    target: str,
    sidecar_root: Path,
    egress_root: Path,
    out: Path,
    version: str,
    engine_version: str,
    budget_mb: int,
) -> dict:
    os_name, cpu = PLATFORM_FIELDS[target]
    bundle = sidecar_bundle(sidecar_root, target)
    if bundle is None:
        raise SystemExit(f"missing sidecar bundle for {target} (looked in {sidecar_root})")
    sidecar_python, run_code_python = sidecar_layout(bundle)

    package_dir = out / f"runtime-{target}"
    if package_dir.exists():
        shutil.rmtree(package_dir)
    package_dir.mkdir(parents=True)
    shutil.copytree(bundle, package_dir / "python-runtime")

    egress = find_egress(egress_root, engine_version, target)
    egress_relative: str | None = None
    if egress is not None:
        bin_dir = package_dir / "bin"
        bin_dir.mkdir()
        egress_name = "steerable-egress-proxy.exe" if target == "win32-x64" else "steerable-egress-proxy"
        shutil.copy2(egress, bin_dir / egress_name)
        (bin_dir / egress_name).chmod(0o755)
        egress_relative = f"bin/{egress_name}"

    total = sum(path.stat().st_size for path in package_dir.rglob("*") if path.is_file())
    total_mb = total / 1024 / 1024
    if total_mb > budget_mb:
        raise SystemExit(f"{target}: {total_mb:.1f} MB exceeds the {budget_mb} MB budget")

    descriptor = {
        "schemaVersion": 1,
        "target": target,
        "engineVersion": engine_version,
        "packageVersion": version,
        "sidecarPython": f"python-runtime/{sidecar_python}",
        "runCodePython": f"python-runtime/{run_code_python}",
        "egressProxy": egress_relative,
        "winSpawnHelper": None,
        "files": declared_files(package_dir),
    }
    (package_dir / "runtime.json").write_text(
        json.dumps(descriptor, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (package_dir / "package.json").write_text(
        json.dumps(
            {
                "name": f"@steerable/runtime-{target}",
                "version": version,
                "description": f"Steerable runtime bundle for {target}: Python sidecar and egress proxy.",
                "license": "Apache-2.0",
                "homepage": "https://steerableframework.com/",
                "repository": {
                    "type": "git",
                    "url": "git+https://github.com/pathlyapp/steerable.git",
                    "directory": "packages/agent-shell/ts",
                },
                "os": [os_name],
                "cpu": [cpu],
                "files": ["runtime.json", "python-runtime", "bin"],
                "publishConfig": {"access": "public", "provenance": True},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {
        "target": target,
        "package": f"@steerable/runtime-{target}",
        "sizeMb": round(total_mb, 1),
        "egressProxy": egress_relative is not None,
        "files": len(descriptor["files"]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar-root", type=Path, default=ROOT / "artifacts")
    parser.add_argument("--egress-root", type=Path, default=ROOT / "artifacts")
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "runtime")
    parser.add_argument("--version", default=None, help="npm package version; defaults to the repo version")
    parser.add_argument("--engine-version", default=None, help="Rust artifact version; defaults to the lock")
    parser.add_argument("--budget-mb", type=int, default=DEFAULT_BUDGET_MB)
    parser.add_argument(
        "--target",
        action="append",
        default=None,
        help="Build only this target (repeatable); defaults to every published target",
    )
    parser.add_argument("--dry-run", action="store_true", help="Assemble and report, then delete the output")
    args = parser.parse_args(argv)

    version = args.version or package_version(ROOT)
    engine_version = args.engine_version or artifact_version(ROOT)
    targets = args.target or list(PLATFORM_FIELDS)

    for target in targets:
        if target not in PLATFORM_FIELDS:
            raise SystemExit(f"unknown target {target}; known: {', '.join(PLATFORM_FIELDS)}")

    # Report every missing bundle at once. CI logs are read on failure, and one
    # target per run means one pipeline re-run per missing platform.
    absent = [target for target in targets if sidecar_bundle(args.sidecar_root, target) is None]
    if absent:
        print(f"::error::missing sidecar bundles for: {', '.join(absent)}", file=sys.stderr)
        print(f"  looked in {args.sidecar_root}", file=sys.stderr)
        print("  the release builds them with .github/workflows/sidecar-build.yml", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    reports = []
    for target in targets:
        reports.append(
            build_package(
                root=ROOT,
                target=target,
                sidecar_root=args.sidecar_root,
                egress_root=args.egress_root,
                out=args.out,
                version=version,
                engine_version=engine_version,
                budget_mb=args.budget_mb,
            )
        )
        report = reports[-1]
        egress = "with egress proxy" if report["egressProxy"] else "NO egress proxy"
        print(f"::notice title=runtime package {target}::{report['sizeMb']} MB, {egress}")
    print(json.dumps({"version": version, "engineVersion": engine_version, "packages": reports}, indent=2))

    if args.dry_run:
        shutil.rmtree(args.out, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
