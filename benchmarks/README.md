# Benchmarks — the performance gate

Required, repository-level performance gates. Each benchmark measures one
real user path's wall-clock and asserts the median of 5 samples stays under
a calibrated budget. A red bench blocks the PR — that is what makes it a
gate rather than a decoration.

## What is measured (one directory entry per user path, not per package)

| Benchmark | User path | Endpoint |
|---|---|---|
| `test_sidecar_boot.py` | First-message latency | spawn → `__SIDECAR_READY__` marker |
| `test_coreloop_round.py` | Per-turn framework tax | one round over a 50-turn transcript, instant provider |
| `test_compaction.py` | Long-session stall | pressure compaction firing mid-run |

## Budget discipline

- Budgets are **reviewed source constants** (`REFERENCE_MS` per file) —
  environment variables must not override them.
- The reference machine is an arm64 Mac. CI budgets derive via
  `calibration.py`: `ceil(REFERENCE_MS × CI_TIME_SCALE × HEADROOM)`.
- `CI_TIME_SCALE` is the measured CI-runner/reference ratio (initially 2.0,
  following dsh). Recalibrate from a CI run's reported medians: if every
  benchmark's CI median lands at roughly `k × REFERENCE_MS`, set
  `CI_TIME_SCALE = k` and record the evidence in the PR.
- On failure the assertion prints the full sample distribution
  (min/median/max) so the verdict is explainable from the log alone.

## Running

```sh
uv run pytest benchmarks/ -q
```

The lane is deliberately NOT in `testpaths`: benchmarks run as their own CI
job (`bench` in `ci.yml`, pull_request only) on an otherwise idle runner —
wall-clock budgets are meaningless under a concurrent gate aggregate.

## The sidecar boot gate is red, and has been since 2026-09-09

`test_sidecar_boot.py` fails on every PR. Recorded medians, oldest first:

| Date | Run | Median | Budget |
|---|---|---|---|
| 2026-11-07 | PR #113 job 42392643151 | 656.3ms | 500ms |
| 2026-11-11 | PR #113 job 42990539480 | 500.1ms | 500ms |
| 2026-11-13 | PR #116 job 131873489225 | 623.0ms | 500ms |

`REFERENCE_MS = 400.0` was set from a 261ms arm64-Mac measurement on
2026-09-09 and has not been revisited. The other two benchmarks are *not*
red on the same runs — `compaction run` lands at 59.6ms against 75ms and
`coreloop round` at 5.2ms against 7ms, both k≈1.0 against their reference
values. So this is not "the whole runner got slower": a single ratio cannot
explain one path at 1.56× and two at 1.0×.

Two candidate explanations, and what would settle it:

1. **The path itself got slower.** `python -c "import steerable_sidecar"`
   costs 276ms on the arm64 reference today, and the subprocess boot median
   there is 365ms (n=9, warm) against the 261ms recorded in September. If
   the September number was cold-cache, the current reference-machine
   median already eats most of the 400ms headroom and the budget is simply
   stale.
2. **This runner class is slower at spawning Python.** Only a measurement of
   the same commit on both a newer runner label and an older one separates
   this from (1).

Until one of those is measured, the honest state is "the gate is red", not
"the code regressed": no PR since September has changed anything the boot
path imports at this scale. Do not recalibrate `CI_TIME_SCALE` to paper
over it — that constant scales all three benchmarks, and two of them are
correctly calibrated right now.

## Adding a benchmark

1. Pick a user path, not a function. If you cannot name the user-visible
   stall it prevents, do not add it.
2. Providers and externals are instant fakes — the measurement must isolate
   framework overhead, never network.
3. Fresh process/state per sample; bound every child, await exit, reap.
4. Measure locally (median of 5+), set `REFERENCE_MS` near the measurement
   with headroom for legitimate growth, and record the measurement in the
   PR description.
