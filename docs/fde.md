# Field Deployment Engineer (FDE) Guide

Steerable ships a built-in CLI toolchain for air-gapped enterprise deployments, signed out-of-tree scenario packs, and zero-leakage diagnostics.

## 1. Authoring & Signing Out-of-Tree Scenario Packs

Create, validate, and sign a `.spack.tgz` archive without modifying the framework repository:

```bash
steerable-cli pack init ./my-pack --id acme-ops
steerable-cli pack test ./my-pack
STEERABLE_PACK_SIGNING_KEY=<ed25519-pkcs8-hex> \
  steerable-cli pack bundle ./my-pack --out ./acme-ops.spack.tgz
```

- `@steerable/pack-testkit` (`createPackTestHost`, `validatePackStaticGuards`) runs pure-Node contract and AST purity checks (`scoped-store-only`, `read-only-purity`, `extension-core-imports`) in milliseconds without booting Python or a browser.
- At startup, `STEERABLE_PACK_DIRS=/opt/packs/acme-ops.spack.tgz` and `STEERABLE_PACK_PUBLIC_KEY=<ed25519-spki-hex>` verify `steerableApiRange`, reject symlinks/path traversal, validate per-file SHA-256 digests, and verify the Ed25519 signature — failing closed with exit code `78` (`EX_CONFIG`) on any mismatch.

## 2. Air-Gapped Host Readiness (`preflight`)

Before starting containers or services on customer hardware:

```bash
steerable-cli preflight --profile server --manifest ./preflight.json
```

`preflight` checks:

- `x86-64-v2` (`POPCNT` / `SSE4.2`) CPU instruction support before launching native engines or modern database containers.
- OS sandbox kernel posture (`Landlock` / `bwrap` / `Seatbelt`).
- Free disk capacity, X.509 TLS certificate expiration window, required binaries (`soffice`, `gs`, `pdftoppm`), and required document fonts — printing actionable offline remediation commands for every failure.

## 3. Zero-Content-Leakage Diagnostics (`diag-bundle`)

Export an offline `.tgz` troubleshooting archive from a failed session:

```bash
steerable-cli diag-bundle --chat <chat-id> --out ./diag.tgz
```

By default (`--redact-content` enabled):

- All registered `SecretRedactor` credentials, `Authorization` headers, cookies, and API keys are scrubbed.
- `<userDataDir>/memory/` and `credential-master-key*` are physically excluded from the archive.
- User prompts, assistant replies, and tool string arguments are replaced with `[REDACTED len=<N> sha256=<prefix12>]`, preserving `LoopEvent` timings, tool names, `outcomeUnknown` flags, and error codes for root-cause analysis.

## 4. Private Model Compatibility Gate (`site-eval`)

Quantify an intranet `vLLM` / `SGLang` / `Ollama` endpoint before cutover:

```bash
steerable-cli site-eval \
  --model qwen-32b-int4 \
  --base-url http://127.0.0.1:8000/v1 \
  --out ./site-eval-report.json
```

`site-eval` measures native `tool_calls` hit rate, XML/markdown pseudo-tool recovery, `promised_action` nudge rescue, and HTTP `400` incompatibilities (automatically recommending `compatRecommendations.echoEmptyReasoningForToolCalls = true` when reasoning models require `reasoning_content` echo).

## 5. Safe Recovery Mode (`?safe=1` & `app reset`)

If a customized `ApplicationManifest` hides navigation or misconfigures shell chrome:

- Open `/?safe=1` in the browser to bypass custom pack UI slots and click **Reset to default application**, or
- Run `steerable-cli app reset` on the host.
