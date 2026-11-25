#!/usr/bin/env python3
"""Generate, validate, and extract lockstep release notes for Steerable.

Stdlib-only (Python 3.11+) so release-prepare.yml, bump_to.sh, and release.yml
can run without installing workspace dependencies.

Subcommands:
  update     Insert ## [X.Y.Z] into CHANGELOG.md (promotes [Unreleased] if
             populated, otherwise aggregates git commits since the previous v*
             tag with optional OpenAI-compatible LLM rewriting) and sync
             docs/changelog.md.
  extract    Print or write the body of ## [X.Y.Z]; exit 1 if missing/empty.
  sync-docs  Copy CHANGELOG.md to docs/changelog.md (or --check for CI drift).
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
REPO_URL = "https://github.com/pathlyapp/steerable"

SEMVER_TAG_RE = re.compile(
    r"^v(?P<ver>[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)$"
)
HEADING_RE = re.compile(
    r"^## \[(?P<version>[^\]]+)\](?:\([^)]*\))?(?:\s*-\s*(?P<date>\d{4}-\d{2}-\d{2})|\s*\((?P<pdate>\d{4}-\d{2}-\d{2})\))?\s*$",
    re.MULTILINE,
)
CONVENTIONAL_RE = re.compile(
    r"^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]+)\))?(?P<breaking>!)?:\s*(?P<subject>.+)$"
)

SKIP_TYPES = frozenset({"ci", "test", "style", "build"})
SECTION_ORDER = ("Breaking Changes", "Added", "Changed", "Fixed")

# Guard against negative-capability trigger words enforced by check_doc_anchors.py
# and private downstream literals enforced by check_public_exposure.py.
FORBIDDEN_LLM_PATTERNS = re.compile(
    r"未实现|刻意推迟|计划中|尚未(?:实现|接线)"
    r"|\bunimplemented\b|\bnot implemented\b|\bno implementation yet\b"
    r"|\bdeliberately (?:deferred|unimplemented)\b"
    r"|\b(?:is|are) planned\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CommitEntry:
    sha: str
    subject: str
    body: str
    commit_type: str
    scope: str
    description: str
    breaking: bool


@dataclass(frozen=True)
class ChangelogSection:
    version: str
    release_date: str | None
    heading_line: str
    body: str


def normalize_version(raw: str) -> str:
    ver = raw.strip()
    if ver.startswith("v"):
        ver = ver[1:]
    if not re.match(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$", ver):
        raise ValueError(f"Invalid semver version: {raw!r}")
    return ver


def _semver_key(ver: str) -> tuple[int, int, int, int, str]:
    core, _, rest = ver.partition("-")
    core, _, _build = core.partition("+")
    parts = [int(p) for p in core.split(".")]
    # Stable releases sort above prereleases of the same X.Y.Z.
    is_stable = 1 if not rest else 0
    return (parts[0], parts[1], parts[2], is_stable, rest)


def parse_sections(markdown: str) -> tuple[str, list[ChangelogSection]]:
    matches = list(HEADING_RE.finditer(markdown))
    if not matches:
        return markdown.strip(), []
    preamble = markdown[: matches[0].start()].rstrip()
    sections: list[ChangelogSection] = []
    for idx, match in enumerate(matches):
        body_start = match.end()
        body_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(markdown)
        sections.append(
            ChangelogSection(
                version=match.group("version").strip(),
                release_date=match.group("date") or match.group("pdate"),
                heading_line=match.group(0).strip(),
                body=markdown[body_start:body_end].strip(),
            )
        )
    return preamble, sections


def has_meaningful_notes(body: str) -> bool:
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("<!--"):
            continue
        return True
    return False


def extract_version_notes(markdown: str, version: str) -> str:
    target = normalize_version(version)
    _preamble, sections = parse_sections(markdown)
    for section in sections:
        if section.version == target:
            if not has_meaningful_notes(section.body):
                raise ValueError(f"CHANGELOG section ## [{target}] is empty.")
            return section.body
    raise ValueError(f"CHANGELOG is missing section ## [{target}].")


def summarize_notes(notes: str, max_chars: int = 700) -> str:
    lines: list[str] = []
    current_group = ""
    for raw in notes.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("### "):
            current_group = line[4:].strip()
            continue
        if line.startswith(("* ", "- ")):
            item = line[2:].strip()
            prefix = f"[{current_group}] " if current_group else ""
            lines.append(f"• {prefix}{item}")
        else:
            lines.append(line)
    if not lines:
        return ""
    out: list[str] = []
    total = 0
    for idx, line in enumerate(lines):
        projected = total + len(line) + (1 if out else 0)
        if projected > max_chars and out:
            remaining = len(lines) - idx
            out.append(f"• … (+{remaining} more)")
            break
        out.append(line)
        total = projected
    return "\n".join(out)


def find_previous_tag(repo_root: Path, target_version: str) -> str | None:
    proc = subprocess.run(
        ["git", "tag", "-l", "v*"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    target_key = _semver_key(target_version)
    candidates: list[tuple[tuple[int, int, int, int, str], str]] = []
    for raw_tag in proc.stdout.splitlines():
        tag = raw_tag.strip()
        match = SEMVER_TAG_RE.match(tag)
        if not match:
            continue
        ver = match.group("ver")
        key = _semver_key(ver)
        if key < target_key:
            candidates.append((key, tag))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[-1][1]


def parse_commit(sha: str, subject: str, body: str) -> CommitEntry | None:
    subj = subject.strip()
    if not subj or subj.startswith("Merge "):
        return None
    match = CONVENTIONAL_RE.match(subj)
    if match:
        ctype = match.group("type").lower()
        scope = (match.group("scope") or "").strip()
        desc = match.group("subject").strip()
        breaking = bool(match.group("breaking")) or ("BREAKING CHANGE" in body)
        if ctype == "chore" and (scope == "release" or desc.startswith("v0.") or desc.startswith("v1.")):
            return None
        return CommitEntry(
            sha=sha,
            subject=subj,
            body=body.strip(),
            commit_type=ctype,
            scope=scope,
            description=desc,
            breaking=breaking,
        )
    if subj.lower().startswith("chore(release):"):
        return None
    return CommitEntry(
        sha=sha,
        subject=subj,
        body=body.strip(),
        commit_type="other",
        scope="",
        description=subj,
        breaking="BREAKING CHANGE" in body,
    )


def collect_git_commits(
    repo_root: Path,
    from_tag: str | None,
    to_ref: str = "HEAD",
) -> list[CommitEntry]:
    rev_range = f"{from_tag}..{to_ref}" if from_tag else to_ref
    proc = subprocess.run(
        ["git", "log", rev_range, "--no-merges", "--format=%H%x1f%s%x1f%b%x1e"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    entries: list[CommitEntry] = []
    for record in proc.stdout.split("\x1e"):
        record = record.strip()
        if not record:
            continue
        parts = record.split("\x1f")
        if len(parts) < 2:
            continue
        sha = parts[0].strip()
        subject = parts[1].strip()
        body = parts[2].strip() if len(parts) > 2 else ""
        parsed = parse_commit(sha, subject, body)
        if parsed is not None:
            entries.append(parsed)
    return entries


def format_deterministic_notes(commits: list[CommitEntry], version: str) -> str:
    buckets: dict[str, list[str]] = {name: [] for name in SECTION_ORDER}
    filtered = [
        c for c in commits if c.breaking or c.commit_type not in SKIP_TYPES
    ]
    active = filtered if filtered else commits

    for commit in active:
        scope_prefix = f"**{commit.scope}:** " if commit.scope else ""
        text = commit.description
        if text and text[0].islower():
            text = text[0].upper() + text[1:]
        if text and text[-1] not in ".!?":
            text = f"{text}."
        bullet = f"- {scope_prefix}{text}"
        if commit.breaking:
            buckets["Breaking Changes"].append(bullet)
        elif commit.commit_type == "feat":
            buckets["Added"].append(bullet)
        elif commit.commit_type == "fix":
            buckets["Fixed"].append(bullet)
        elif commit.commit_type in ("perf", "refactor", "docs", "chore", "other", "build", "ci", "test", "style"):
            buckets["Changed"].append(bullet)
        else:
            buckets["Changed"].append(bullet)

    blocks: list[str] = []
    for section in SECTION_ORDER:
        items = buckets[section]
        if not items:
            continue
        deduped = list(dict.fromkeys(items))
        blocks.append(f"### {section}\n\n" + "\n".join(deduped))

    if not blocks:
        return f"### Changed\n\n- Lockstep package and runtime alignment for `{version}`."
    return "\n\n".join(blocks)


def _load_dotenv_if_present(repo_root: Path) -> dict[str, str]:
    env_file = repo_root / ".env"
    values: dict[str, str] = {}
    if not env_file.is_file():
        return values
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip().strip("'\"")
    return values


def resolve_llm_config(repo_root: Path) -> tuple[str, str, str] | None:
    dotenv = _load_dotenv_if_present(repo_root)

    def get_var(name: str) -> str:
        return (os.environ.get(name) or dotenv.get(name) or "").strip()

    explicit_key = get_var("CHANGELOG_LLM_API_KEY")
    deepseek_key = get_var("DEEPSEEK_API_KEY")
    openai_key = get_var("OPENAI_API_KEY")

    api_key = explicit_key or deepseek_key or openai_key
    if not api_key:
        return None

    if explicit_key:
        default_url = "https://api.openai.com/v1"
        default_model = "gpt-4o-mini"
    elif deepseek_key:
        default_url = get_var("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/v1"
        default_model = "deepseek-chat"
    else:
        default_url = "https://api.openai.com/v1"
        default_model = "gpt-4o-mini"

    base_url = (get_var("CHANGELOG_LLM_BASE_URL") or default_url).rstrip("/")
    if not base_url.endswith("/v1") and not base_url.endswith("/chat/completions"):
        base_url = f"{base_url}/v1"
    model = get_var("CHANGELOG_LLM_MODEL") or default_model
    return api_key, base_url, model


def validate_llm_markdown(candidate: str) -> str | None:
    cleaned = candidate.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    if not cleaned:
        return None
    if "### " not in cleaned:
        return None
    if not any(line.lstrip().startswith(("- ", "* ")) for line in cleaned.splitlines()):
        return None
    if FORBIDDEN_LLM_PATTERNS.search(cleaned):
        return None
    return cleaned


def rewrite_with_llm(
    version: str,
    commits: list[CommitEntry],
    fallback_body: str,
    repo_root: Path,
) -> str:
    if not commits:
        return fallback_body
    config = resolve_llm_config(repo_root)
    if config is None:
        return fallback_body
    api_key, base_url, model = config
    endpoint = (
        base_url
        if base_url.endswith("/chat/completions")
        else f"{base_url}/chat/completions"
    )

    commit_lines = []
    for c in commits[:60]:
        detail = f" — {c.body.splitlines()[0]}" if c.body else ""
        commit_lines.append(f"- [{c.sha[:7]}] {c.subject}{detail}")

    system_prompt = (
        "You write concise, accurate English release notes for the Steerable agent framework "
        "(TypeScript + Python + CLI + UI + desktop shell). "
        "Output ONLY Markdown subsections using one or more of: "
        "'### Breaking Changes', '### Added', '### Changed', '### Fixed'. "
        "Rules:\n"
        "1. Merge related commits into clear, developer-facing bullets ('- **scope:** ...').\n"
        "2. Omit pure CI, test-only, or formatting noise unless it affects published artifacts.\n"
        "3. Preserve exact CLI flags, package names, and protocol terms.\n"
        "4. State shipped behavior directly; never speculate about future work or unimplemented features.\n"
        "5. Do not wrap the output in outer code fences or include a top-level ## version header."
    )
    user_prompt = (
        f"Target version: v{version}\n\n"
        f"Git commits since previous release:\n" + "\n".join(commit_lines)
    )

    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        content = raw["choices"][0]["message"]["content"]
        validated = validate_llm_markdown(content)
        if validated:
            print(f"[changelog] Rewrote v{version} notes with LLM ({model}).", file=sys.stderr)
            return validated
        print("[changelog] LLM response failed format validation; using deterministic notes.", file=sys.stderr)
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError, OSError) as exc:
        print(f"[changelog] LLM rewrite skipped ({exc}); using deterministic notes.", file=sys.stderr)
    return fallback_body


def render_changelog(preamble: str, sections: list[ChangelogSection]) -> str:
    header = preamble.strip() or (
        "# Changelog\n\n"
        "All notable changes to the Steerable framework are documented in this file."
    )
    parts = [header]
    has_unreleased = any(s.version.lower() == "unreleased" for s in sections)
    if not has_unreleased:
        parts.append("## [Unreleased]")
    for sec in sections:
        if sec.body:
            parts.append(f"{sec.heading_line}\n\n{sec.body}")
        else:
            parts.append(sec.heading_line)
    return "\n\n".join(parts).rstrip() + "\n"


def update_changelog_markdown(
    existing_markdown: str,
    *,
    version: str,
    release_date: str,
    prev_tag: str | None,
    generated_body: str,
) -> tuple[str, bool]:
    """Insert ## [version] if absent. Returns (updated_markdown, changed)."""
    target = normalize_version(version)
    preamble, sections = parse_sections(existing_markdown)

    for sec in sections:
        if sec.version == target:
            return existing_markdown, False

    compare_target = (
        f"{REPO_URL}/compare/{prev_tag}...v{target}"
        if prev_tag
        else f"{REPO_URL}/releases/tag/v{target}"
    )
    new_heading = f"## [{target}]({compare_target}) - {release_date}"

    unreleased_idx = next(
        (i for i, s in enumerate(sections) if s.version.lower() == "unreleased"),
        None,
    )
    if unreleased_idx is not None and has_meaningful_notes(sections[unreleased_idx].body):
        body_to_use = sections[unreleased_idx].body
        sections[unreleased_idx] = ChangelogSection(
            version="Unreleased",
            release_date=None,
            heading_line="## [Unreleased]",
            body="",
        )
    else:
        body_to_use = generated_body

    new_section = ChangelogSection(
        version=target,
        release_date=release_date,
        heading_line=new_heading,
        body=body_to_use,
    )

    if unreleased_idx is not None:
        sections.insert(unreleased_idx + 1, new_section)
    else:
        sections.insert(0, new_section)
        sections.insert(
            0,
            ChangelogSection(
                version="Unreleased",
                release_date=None,
                heading_line="## [Unreleased]",
                body="",
            ),
        )

    return render_changelog(preamble, sections), True


def render_docs_changelog(changelog_markdown: str) -> str:
    """Render docs/changelog.md for MkDocs without empty [Unreleased] headings."""
    preamble, sections = parse_sections(changelog_markdown)
    kept = [
        sec
        for sec in sections
        if not (sec.version.lower() == "unreleased" and not has_meaningful_notes(sec.body))
    ]
    header = preamble.strip() or (
        "# Changelog\n\n"
        "All notable changes to the Steerable framework are documented on this page."
    )
    parts = [header]
    for sec in kept:
        if sec.body:
            parts.append(f"{sec.heading_line}\n\n{sec.body}")
        else:
            parts.append(sec.heading_line)
    return "\n\n".join(parts).rstrip() + "\n"


def sync_docs_file(changelog_path: Path, docs_out: Path, check_only: bool = False) -> bool:
    expected = render_docs_changelog(changelog_path.read_text(encoding="utf-8"))
    current = docs_out.read_text(encoding="utf-8") if docs_out.is_file() else ""
    if current == expected:
        return True
    if check_only:
        return False
    docs_out.parent.mkdir(parents=True, exist_ok=True)
    docs_out.write_text(expected, encoding="utf-8")
    return True


def cmd_update(args: argparse.Namespace) -> int:
    version = normalize_version(args.version)
    rel_date = args.date or date.today().isoformat()
    changelog_path = Path(args.changelog)
    docs_out = Path(args.docs_out) if args.docs_out else None

    existing = (
        changelog_path.read_text(encoding="utf-8")
        if changelog_path.is_file()
        else "# Changelog\n\n## [Unreleased]\n"
    )
    _preamble, sections = parse_sections(existing)
    already_exists = any(s.version == version and has_meaningful_notes(s.body) for s in sections)

    if not already_exists:
        unreleased = next((s for s in sections if s.version.lower() == "unreleased"), None)
        prev_tag = args.from_tag or find_previous_tag(ROOT, version)
        if unreleased is not None and has_meaningful_notes(unreleased.body):
            generated_body = unreleased.body
        else:
            commits = collect_git_commits(ROOT, prev_tag, args.to_ref)
            deterministic = format_deterministic_notes(commits, version)
            use_llm = not args.no_llm and os.environ.get("CHANGELOG_NO_LLM") != "1"
            generated_body = (
                rewrite_with_llm(version, commits, deterministic, ROOT)
                if use_llm
                else deterministic
            )
        updated, _changed = update_changelog_markdown(
            existing,
            version=version,
            release_date=rel_date,
            prev_tag=prev_tag,
            generated_body=generated_body,
        )
        changelog_path.write_text(updated, encoding="utf-8")
        print(f"  CHANGELOG.md                      updated -> [{version}] ({rel_date})")
    else:
        print(f"  CHANGELOG.md                      kept existing [{version}]")

    if docs_out is not None:
        sync_docs_file(changelog_path, docs_out, check_only=False)
        print(f"  {docs_out.relative_to(ROOT) if docs_out.is_relative_to(ROOT) else docs_out}  synced")
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    changelog_path = Path(args.changelog)
    if not changelog_path.is_file():
        print(f"ERROR: {changelog_path} does not exist.", file=sys.stderr)
        return 1
    try:
        notes = extract_version_notes(changelog_path.read_text(encoding="utf-8"), args.version)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    output = summarize_notes(notes, max_chars=args.max_chars) if args.summary else notes
    if args.out:
        Path(args.out).write_text(output + "\n", encoding="utf-8")
    else:
        sys.stdout.write(output + "\n")
    return 0


def cmd_sync_docs(args: argparse.Namespace) -> int:
    changelog_path = Path(args.changelog)
    docs_out = Path(args.docs_out)
    ok = sync_docs_file(changelog_path, docs_out, check_only=args.check)
    if not ok:
        print(
            f"ERROR: {docs_out} is out of sync with {changelog_path}. "
            "Run: python3 scripts/release/changelog.py sync-docs",
            file=sys.stderr,
        )
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_update = sub.add_parser("update", help="Update CHANGELOG.md for a target version.")
    p_update.add_argument("--version", required=True, help="Target semver (e.g. 0.12.8)")
    p_update.add_argument("--date", default="", help="ISO date YYYY-MM-DD (default: today)")
    p_update.add_argument("--from-tag", default="", help="Override starting git tag")
    p_update.add_argument("--to-ref", default="HEAD", help="Ending git ref (default: HEAD)")
    p_update.add_argument(
        "--changelog",
        default=str(ROOT / "CHANGELOG.md"),
        help="Path to root CHANGELOG.md",
    )
    p_update.add_argument(
        "--docs-out",
        default=str(ROOT / "docs" / "changelog.md"),
        help="Path to MkDocs changelog page (empty string to skip)",
    )
    p_update.add_argument(
        "--no-llm",
        action="store_true",
        help="Disable LLM rewrite even when an API key is present",
    )
    p_update.set_defaults(func=cmd_update)

    p_extract = sub.add_parser("extract", help="Extract notes for a single version.")
    p_extract.add_argument("--version", required=True, help="Version to extract")
    p_extract.add_argument(
        "--changelog",
        default=str(ROOT / "CHANGELOG.md"),
        help="Path to root CHANGELOG.md",
    )
    p_extract.add_argument("--out", default="", help="Write extracted notes to file")
    p_extract.add_argument(
        "--summary",
        action="store_true",
        help="Format compact bullet summary (e.g. for Feishu cards)",
    )
    p_extract.add_argument("--max-chars", type=int, default=700, help="Max summary length")
    p_extract.set_defaults(func=cmd_extract)

    p_sync = sub.add_parser("sync-docs", help="Sync docs/changelog.md from CHANGELOG.md.")
    p_sync.add_argument(
        "--changelog",
        default=str(ROOT / "CHANGELOG.md"),
        help="Path to root CHANGELOG.md",
    )
    p_sync.add_argument(
        "--docs-out",
        default=str(ROOT / "docs" / "changelog.md"),
        help="Path to MkDocs changelog page",
    )
    p_sync.add_argument("--check", action="store_true", help="Exit 1 if out of sync")
    p_sync.set_defaults(func=cmd_sync_docs)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
