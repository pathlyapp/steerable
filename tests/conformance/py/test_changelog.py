"""Unit tests for scripts/release/changelog.py."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "release" / "changelog.py"
spec = importlib.util.spec_from_file_location("steerable_changelog", SCRIPT_PATH)
assert spec and spec.loader
changelog = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = changelog
spec.loader.exec_module(changelog)


def test_extract_existing_versions_from_repo_changelog() -> None:
    root_changelog = (SCRIPT_PATH.parents[2] / "CHANGELOG.md").read_text(encoding="utf-8")
    notes_127 = changelog.extract_version_notes(root_changelog, "v0.12.7")
    assert "Multiline IME-safe chat composer input" in notes_127

    notes_020 = changelog.extract_version_notes(root_changelog, "0.2.0")
    assert "autonomous publish pipeline" in notes_020

    summary = changelog.summarize_notes(notes_127, max_chars=200)
    assert summary.startswith("• [Added]")


def test_extract_rejects_missing_or_empty_section() -> None:
    md = "# Changelog\n\n## [Unreleased]\n\n## [0.5.0] - 2026-06-01\n\n"
    with pytest.raises(ValueError, match="empty"):
        changelog.extract_version_notes(md, "0.5.0")
    with pytest.raises(ValueError, match="missing"):
        changelog.extract_version_notes(md, "0.5.1")


def test_update_promotes_unreleased_when_populated() -> None:
    initial = (
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "### Added\n\n"
        "- **cli:** Support `--json` output on `doctor`.\n\n"
        "## [0.12.7](https://github.com/pathlyapp/steerable/compare/v0.12.6...v0.12.7) - 2026-11-24\n\n"
        "### Added\n\n"
        "- Existing item.\n"
    )
    updated, changed = changelog.update_changelog_markdown(
        initial,
        version="0.12.8",
        release_date="2026-11-25",
        prev_tag="v0.12.7",
        generated_body="### Changed\n\n- Ignored fallback.",
    )
    assert changed is True
    assert "## [0.12.8](https://github.com/pathlyapp/steerable/compare/v0.12.7...v0.12.8) - 2026-11-25" in updated
    extracted = changelog.extract_version_notes(updated, "0.12.8")
    assert "Support `--json` output on `doctor`." in extracted
    assert "Ignored fallback" not in extracted
    # Unreleased is reset to empty, and running again for 0.12.8 is idempotent.
    _preamble, sections = changelog.parse_sections(updated)
    assert sections[0].version == "Unreleased"
    assert sections[0].body == ""
    again, changed_again = changelog.update_changelog_markdown(
        updated,
        version="0.12.8",
        release_date="2026-11-25",
        prev_tag="v0.12.7",
        generated_body="### Added\n\n- Other.",
    )
    assert changed_again is False
    assert again == updated


def test_deterministic_formatting_and_llm_validation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    c1 = changelog.parse_commit("abc1234", "feat(shell): add release notes panel", "")
    c2 = changelog.parse_commit("def5678", "fix(runtime)!: enforce schema check", "")
    c3 = changelog.parse_commit("0001111", "chore(release): v0.12.8", "")
    c4 = changelog.parse_commit("2223333", "ci: bump cache version", "")
    assert c3 is None
    assert c1 is not None and c2 is not None and c4 is not None

    notes = changelog.format_deterministic_notes([c1, c2, c4], "0.12.8")
    assert "### Breaking Changes\n\n- **runtime:** Enforce schema check." in notes
    assert "### Added\n\n- **shell:** Add release notes panel." in notes
    assert "bump cache version" not in notes

    # LLM validation rejects empty/non-bulleted or forbidden trigger text.
    assert changelog.validate_llm_markdown("plain text") is None
    assert changelog.validate_llm_markdown("### Added\n\n- Feature X is planned.") is None
    valid = changelog.validate_llm_markdown("```markdown\n### Added\n\n- **shell:** Polished note.\n```")
    assert valid == "### Added\n\n- **shell:** Polished note."

    # Mock OpenAI-compatible HTTP response to verify LLM rewrite path.
    class FakeResp:
        def __enter__(self) -> FakeResp:
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(
                {
                    "choices": [
                        {
                            "message": {
                                "content": "### Added\n\n- **shell:** Display release notes in the desktop update panel."
                            }
                        }
                    ]
                }
            ).encode("utf-8")

    monkeypatch.setenv("CHANGELOG_LLM_API_KEY", "test-key")
    monkeypatch.setattr(changelog.urllib.request, "urlopen", lambda req, timeout=30: FakeResp())
    rewritten = changelog.rewrite_with_llm("0.12.8", [c1], notes, tmp_path)
    assert "Display release notes in the desktop update panel." in rewritten
