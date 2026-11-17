# Release pipeline

How a version reaches npm and PyPI, and the constraints that keep every
publish bound to the tag being released. Read this before editing anything
under `.github/workflows/` that touches publishing.

`RELEASING.md` covers the operator commands. This document covers the
pipeline's structure and the failure modes it is designed to prevent.

## Entry points

Two paths produce a `v*` tag, and both end in the same `release.yml` chain.

**Branch-driven** (preferred — one human step):

```
release/X.Y.Z branch pushed
  → release-prepare.yml runs scripts/release/bump_to.sh X.Y.Z
  → commits the bump, opens the release PR
  → dispatches ci.yml for the branch (see below)
  → PR merged into main
  → release-tag.yml tags the PR's merge commit and dispatches release.yml
```

The bump commit is pushed with `GITHUB_TOKEN`, which triggers neither `push`
nor `pull_request` workflows. `release-prepare.yml` therefore dispatches
`ci.yml` against the branch explicitly; without that the release PR opens with
no checks and cannot be merged under branch protection.

**Manual:**

```bash
./scripts/release/bump_to.sh X.Y.Z   # or bump by hand
git commit -am "chore(release): vX.Y.Z"
git tag vX.Y.Z && git push origin main vX.Y.Z
```

`bump_to.sh` refuses to run on a dirty tree, which is why the branch path
commits rather than leaving changes staged.

## The chain

```
release.yml (validate)
  ├── quickstart.yml              CLI + web quickstart on 3 platforms
  ├── sidecar-build.yml           signed bundles, one per target
  ├── publish-native.yml          verifies the private wheels exist
  ├── publish-npm.yml             workspace packages + assembled runtimes
  └── publish-pypi.yml            pure-Python wheels
```

`validate` resolves the version, creates the GitHub Release, and gates on
`scripts/check_lockstep_versions.py --expected X.Y.Z` — every framework
package must report exactly that version, and the Rust artifact pin must be
coherent.

Each publish job is idempotent: it skips a package already on the registry.
That makes a partial failure recoverable by re-triggering the chain, and it is
also what made the 0.12.2 defect look like success.

## Rule: a reusable workflow does not inherit the caller's checkout

This is the defect that shipped a wrong release, so it gets its own rule.

A reusable workflow called with `uses: ./.github/workflows/x.yml` starts from
scratch. Its `actions/checkout` step with no `ref` checks out the repository's
**default branch** — which here is `develop`, not `main`. A caller's own
`actions/checkout` with a tag ref has no effect on the callee.

Releasing v0.12.2 therefore ran every publish job against `develop`. The
registry-skip logic compared `develop`'s versions (still 0.12.1), concluded
everything was already published, and uploaded nothing. The release only
appeared to work because it was re-dispatched by hand from `main` afterwards.
The job summaries were green in both cases.

Every reusable workflow in the chain now takes the ref explicitly:

| Workflow | Input | Required |
| --- | --- | --- |
| `publish-npm.yml` | `ref`, `expected_version` | yes |
| `publish-pypi.yml` | `ref`, `expected_version` | yes |
| `sidecar-build.yml` | `ref` | yes |
| `quickstart.yml` | `ref` | no (defaults to the triggering ref) |
| `publish-native.yml` | `ref` | no (defaults to the triggering ref) |

`release.yml` always passes `ref: refs/tags/v<version>`.

### Defense in depth

A ref alone is not enough, because a wrong-but-valid ref would still check out
*something*. The npm and PyPI publishers therefore also require
`expected_version` and assert it before any registry write:

```yaml
- name: Refuse to publish a version other than the released tag
  env:
    EXPECTED: ${{ inputs.expected_version }}
  run: python3 scripts/check_lockstep_versions.py --expected "$EXPECTED"
```

This step runs before `pnpm/action-setup` and before any upload, so a
mis-wired ref fails the run instead of publishing a stale version. Note the
`setup-python` step above it: the checker imports `tomllib`, which needs
Python 3.11 or newer.

## Rule: a tag pushed by `GITHUB_TOKEN` starts no workflow

GitHub suppresses workflow runs for pushes made with the default
`GITHUB_TOKEN`, to stop runaway recursion. So `release-tag.yml` cannot rely on
the `push: tags:` trigger: it creates the tag, then dispatches `release.yml`
itself.

Two details make that dispatch trustworthy:

- **The tag points at the PR's merge commit** (`merge_commit_sha`), not at
  whatever `main` points at when the job runs — another merge may land in
  between.
- **The dispatch passes `--ref "$TAG"`**, so the run uses the tag's own
  workflow files. Dispatching from the default branch would run a newer
  pipeline than the tag ships, and its `uses: ./...` would resolve there.

## Rule: release only from main

`validate` refuses a tag that is not an ancestor of `main`:

```bash
git fetch --no-tags origin main
git merge-base --is-ancestor "$TAG^{commit}" FETCH_HEAD
```

A tag cut from a feature or `develop` branch would publish code `main` never
contained. This check runs before the lockstep gate.

## What a wrong-ref release looks like

Worth recognizing, because it reports success.

A release that checked out the wrong branch produces a green run. The only
tell is in the publish log: every package reports

```
##[notice]@steerable/agent-shell-web@0.12.1 is already on the registry.
```

`0.12.1` where you expected `0.12.2`. The job never fails, because skipping
already-published versions is the intended idempotent behaviour — the defect
is that it compared the wrong tree.

Compare against a healthy run, which prints `+ @steerable/<name>@<version>`
for each package it uploads. Verify the registry when it matters:

```bash
curl -s https://registry.npmjs.org/@steerable%2Fagent-shell \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['dist-tags']['latest'])"
```

`npm view <pkg> version` can serve a stale local cache; the registry request
above does not.

## Recovering a partial failure

The publish workflows skip what is already on the registry, so re-trigger the
chain from the tag:

```bash
gh workflow run release.yml --ref vX.Y.Z -f version=X.Y.Z
```

The `--ref` matters for the reason above. To re-run one publisher, pass the
tag and the version it must report:

```bash
gh workflow run publish-npm.yml --ref vX.Y.Z -f ref=vX.Y.Z -f expected_version=X.Y.Z
```

## Guard tests

`tests/conformance/py/test_release_workflow_refs.py` keeps the chain bound.
It fails when:

- a publish workflow's `workflow_call` does not require `ref`
- a publish workflow does not require `expected_version`
- the version gate is not ahead of the upload step
- a checkout inside a reusable workflow has no `ref`
- `release.yml` calls a chained workflow without a tag ref
- `release-tag.yml` dispatches from anything but the tag
- `release-tag.yml` tags anything but the merge commit
- `release.yml` does not reject a tag outside `main`

Run it directly with `uv run pytest tests/conformance/py/test_release_workflow_refs.py`.
The suite is part of `uv run pytest`, which CI runs.
