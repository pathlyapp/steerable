# Changelog

All notable changes to the Steerable framework (lockstep across TypeScript, Python, CLI, UI, and desktop host packages) are documented in this file.

## [Unreleased]

## [0.13.0](https://github.com/pathlyapp/steerable/compare/v0.12.8...v0.13.0) - 2026-11-26

### Added

- **shell, security:** Unified `Principal` and `OriginChannel` turn context (`im` / `webhook` channel confinement), AES-256-GCM `CredentialBroker` with cross-origin redirect header stripping, unified `SecretRedactor` across transcripts, logs, spills, memories, and diagnostic bundles, runtime `/api/v2/auth/bootstrap`, `ApplicationManifest` switching (`steerable-cli app list|use|reset`), and `?safe=1` Safe Recovery Mode.
- **protocol, runtime, shell:** Sealed `RejectedBeforeEffect` boundaries, mandatory human sign-off for `outward` actions (never auto-approved by unattended mode or session cache), `outcome_unknown` non-retryable tool settlement with `OutcomeReconcileCard` (`POST /api/v2/chats/:id/reconcile`), and `policyDigest`-scoped `allow_always` rules (`_by_policy`).
- **ui, shell, cli:** Controlled `UiSurface` v1 (`UiSurfaceCard`, `UiSurfaceWorkbench`, ASCII TUI fallback) with real-time `$source` SHA-256 drift detection (`409 UI_STALE`) and idempotent command receipts, plus `DeliverableVerifier` immutable snapshot archiving and `FactChainDrawer` claim-to-source provenance inspection.
- **runtime, memory:** Guarded `SideCallPort` (16 KiB input truncation, secret redaction, main-turn abort cascade, independent `caller` spend attribution), `PromisedActionContinuationHooks` single-nudge guard, automatic conversation title refresh, and Host-isolated dual-layer `MEMORY.md` + Zero-Trust RSI (`user | workspace | tenant` scopes, Seatbelt/bwrap sandbox read-deny on raw memory storage, 30-day auto-expiry, permanent revoke tombstones, `MemorySettingsPanel`, `/memory`, and `/refine`).
- **pack-testkit, cli, guards:** Published `@steerable/pack-testkit` (`createPackTestHost` and AST boundary checks), signed external `.spack` loading (Ed25519 + SHA-256 + symlink refusal), `steerable-cli pack init|test|bundle`, `preflight`, `diag-bundle`, and `site-eval`, plus five repository AST architecture guards.

### Changed

- **engine:** Adopt Rust artifacts `1.0.11` (`SideCallPort`, `PromisedActionContinuationHooks`, `outward` / `outcome_unknown` enforcement, and `ring::digest::SHA256` `policyDigest` verification).

## [0.12.8](https://github.com/pathlyapp/steerable/compare/v0.12.7...v0.12.8) - 2026-11-25

### Added
- **release:** Added `scripts/release/changelog.py` to promote the `[Unreleased]` section, aggregate commits with optional LLM rewriting, and sync `docs/changelog.md`.
- **shell:** In-app update release notes are now displayed in the desktop shell.

## [0.12.7](https://github.com/pathlyapp/steerable/compare/v0.12.6...v0.12.7) - 2026-11-24

### Added

- **shell, runtime:** Multiline IME-safe chat composer input, stop-and-edit turn resubmission from an active stream, and live inline `todo_write` progress rendering during turns.

## [0.12.6](https://github.com/pathlyapp/steerable/compare/v0.12.5...v0.12.6) - 2026-11-18

### Added

- **shell:** Extracted reusable `TurnProcessTimeline` component for consistent collapsible tool, reasoning, and sub-agent timeline presentation across chat surfaces.
- **sidecar:** Hardened `web_search` and `web_fetch` provider fallback and response sanitization.

## [0.12.5](https://github.com/pathlyapp/steerable/compare/v0.12.4...v0.12.5) - 2026-11-18

### Added

- **demo, ui:** Interactive browser playbook with complete mock endpoints, 14 card stories, and design-token reference in Storybook.

### Fixed

- **sidecar:** Omit sub-agent `reasoningEffort` hints when the parent model exposes no reasoning effort control.
- **ui:** Darken card muted fallback and badge text colors to meet WCAG AA contrast ratios.

## [0.12.4](https://github.com/pathlyapp/steerable/compare/v0.12.3...v0.12.4) - 2026-11-17

### Added

- **shell:** Stream pack-route binary files over HTTP with `Range` request support so large PDFs, spreadsheets, and media previews load without base64 memory bloat.

### Fixed

- **shell:** Keep pack-route integration tests product-neutral.

## [0.12.3](https://github.com/pathlyapp/steerable/compare/v0.12.2...v0.12.3) - 2026-11-17

### Fixed

- **release:** Bind reusable publish workflows (`publish-npm.yml`, `publish-pypi.yml`, `sidecar-build.yml`) to the explicit tag ref and enforce `check_lockstep_versions.py` ahead of registry uploads.

## [0.12.2](https://github.com/pathlyapp/steerable/compare/v0.12.1...v0.12.2) - 2026-11-16

### Fixed

- **shell:** Preserve text and image pastes in the desktop WKWebView chat composer via the host menu paste bridge.

## [0.12.1](https://github.com/pathlyapp/steerable/compare/v0.12.0...v0.12.1) - 2026-11-13

### Changed

- **runtime:** Report each turn's cumulative token and cost spend across parent and child agents instead of enforcing a hard tree cap.
- **engine:** Adopt Rust artifacts `1.0.10`.

### Fixed

- **runtime:** Persist sub-agent closed state across session hydration so closed children remain closed on reload.

## [0.12.0](https://github.com/pathlyapp/steerable/compare/v0.11.1...v0.12.0) - 2026-11-13

### Added

- **shell:** Display per-turn sub-agent token and spend breakdown inside the child agent inspection panel.

## [0.11.1](https://github.com/pathlyapp/steerable/compare/v0.11.0...v0.11.1) - 2026-11-13

### Fixed

- **sidecar:** Parse named `.py` scripts in-process during preflight syntax checks so scripts sharing a Python stdlib module name execute cleanly.

## [0.11.0](https://github.com/pathlyapp/steerable/compare/v0.10.3...v0.11.0) - 2026-11-12

### Added

- **runtime:** Peer messaging across the sub-agent spawn tree and a shared session task board for multi-agent coordination.

## [0.10.3](https://github.com/pathlyapp/steerable/compare/v0.10.2...v0.10.3) - 2026-11-11

### Fixed

- **shell:** Mark turns interrupted by a crashed sidecar process distinctly rather than settling them as normal completions.

## [0.10.2](https://github.com/pathlyapp/steerable/compare/v0.10.1...v0.10.2) - 2026-11-11

### Fixed

- **shell:** Hydrate interrupted-turn recovery cards immediately without blocking on child-agent index loading.

## [0.10.1](https://github.com/pathlyapp/steerable/compare/v0.10.0...v0.10.1) - 2026-11-10

### Changed

- **engine:** Adopt Rust artifacts `1.0.9`, preserving partial assistant replies when a turn is stopped mid-stream.

## [0.10.0](https://github.com/pathlyapp/steerable/compare/v0.9.2...v0.10.0) - 2026-11-09

### Added

- **multi-agent:** First-class persistent sub-agents with durable lifecycles, addressable handles, and structured delegation events.

## [0.2.0](https://github.com/pathlyapp/steerable/compare/v0.1.0...v0.2.0) (2026-05-15)

### Features

* add json-schema-to-typescript dependency and enhance agent protocol models
* integrate Storybook for UI components and enhance documentation
* **release:** wire autonomous publish pipeline (npm + PyPI)

### Bug Fixes

* **ci:** declare workspace packages in dev group so uv sync installs them
* un-ignore packages/sidecar/build/ source toolchain
