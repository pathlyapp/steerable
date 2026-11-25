"""Guards on the release workflow chain.

A reusable workflow does not inherit the caller's checkout. When the release
chain called the publish workflows without a ref, GitHub checked out the
default branch, so releasing tag vX published whatever versions that branch
carried — 0.12.1 shipped while v0.12.2 was being released. These tests keep
every publish path bound to the tag it names.
"""

from __future__ import annotations

from pathlib import Path

import yaml

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _on_block(workflow: dict) -> dict:
    # PyYAML reads the bare key `on` as the boolean True.
    return workflow.get("on") or workflow.get(True) or {}


def _steps(workflow: dict, job: str) -> list[dict]:
    return workflow["jobs"][job]["steps"]


def _checkout_steps(steps: list[dict]) -> list[dict]:
    return [step for step in steps if str(step.get("uses", "")).startswith("actions/checkout")]


def test_reusable_workflows_require_the_ref_to_check_out() -> None:
    for name in ("publish-npm.yml", "publish-pypi.yml", "sidecar-build.yml"):
        call = _on_block(_load(name))["workflow_call"]["inputs"]
        assert call["ref"]["required"] is True, name


def test_publish_workflows_verify_the_tag_version_before_any_upload() -> None:
    for name in ("publish-npm.yml", "publish-pypi.yml"):
        call = _on_block(_load(name))["workflow_call"]["inputs"]
        assert call["expected_version"]["required"] is True, name
        steps = _steps(_load(name), "publish")
        names = [step.get("name", "") for step in steps]
        gate = next(
            index
            for index, label in enumerate(names)
            if "publish a version other than the released tag" in label
        )
        upload = min(
            index
            for index, label in enumerate(names)
            if "ublish" in label and "tag" not in label
        )
        assert gate < upload, f"{name} gates the version before publishing"


def test_every_checkout_in_the_release_chain_uses_the_caller_ref() -> None:
    for name in ("publish-npm.yml", "publish-pypi.yml", "sidecar-build.yml"):
        for job in _load(name)["jobs"].values():
            for step in _checkout_steps(job["steps"]):
                assert step.get("with", {}).get("ref"), f"{name} checkout has no ref"


def test_release_passes_the_tag_to_every_chained_workflow() -> None:
    release = _load("release.yml")
    for job_name, job in release["jobs"].items():
        if not str(job.get("uses", "")).startswith("./.github/workflows/"):
            continue
        ref = job.get("with", {}).get("ref", "")
        assert "refs/tags/v" in ref, f"{job_name} does not check out the tag"


def test_release_tag_dispatches_release_from_the_tag() -> None:
    steps = _steps(_load("release-tag.yml"), "tag")
    dispatch = next(step for step in steps if step.get("name") == "Dispatch the release from the tag")
    script = dispatch["run"]
    # Dispatching from the default branch would run a newer workflow than the
    # tag ships, and that workflow's `uses: ./...` would resolve there.
    assert '--ref "$TAG"' in script


def test_release_tag_tags_the_merge_commit() -> None:
    steps = _steps(_load("release-tag.yml"), "tag")
    checkout = next(step for step in steps if "Checkout" in step.get("name", ""))
    assert "merge_commit_sha" in checkout["with"]["ref"]
    push = next(step for step in steps if step.get("name") == "Push the tag")
    assert 'git tag "$TAG" "$SHA"' in push["run"]


def test_release_refuses_a_tag_that_is_not_on_main() -> None:
    steps = _steps(_load("release.yml"), "validate")
    assert any(
        "not an ancestor of main" in step.get("run", "") for step in steps
    ), "validate does not reject tags outside main"


def test_release_gates_on_curated_changelog_section() -> None:
    steps = _steps(_load("release.yml"), "validate")
    assert any(
        "scripts/release/changelog.py extract" in step.get("run", "")
        for step in steps
    ), "validate does not gate on CHANGELOG.md"
    create = next(step for step in steps if "Create GitHub Release" in step.get("name", ""))
    assert "--notes-file /tmp/release-notes.md" in create["run"]
    assert "--generate-notes" not in create["run"]
