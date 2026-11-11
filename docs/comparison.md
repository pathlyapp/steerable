# Framework Comparison

How Steerable compares to other agent frameworks and products — including
where we lag. Steerable is an early-stage project (`0.8.x`); this page is
written to help you decide, not to declare a winner.

!!! note "Honesty policy"
    Every claim below links to a spec page or names a shipped artifact.
    Where Steerable is behind, the table says so. If you find a stale row,
    [open an issue](https://github.com/pathlyapp/steerable/issues) —
    this page is reviewed on every release.

!!! info "How the Claude Code column was sourced"
    Claude Code is closed source, so its column is not quoted from marketing
    copy: it was read out of the shipped artifact. The `2.1.319` npm package is
    an installer stub whose real payload is eight platform-specific native
    binaries; the `darwin-arm64` one embeds its full application bundle as
    plain-text JavaScript, and the package also publishes `sdk-tools.d.ts` —
    unminified TypeScript declarations for 45 built-in tool input types.
    Identifiers are minified, but string literals, environment variable names,
    error messages, tool schemas and system-prompt text are intact. Facts below
    are taken from that bundle at version `2.1.319`. The same bundle serves the
    CLI and the Agent SDK — it carries three system-prompt variants, one of
    which reads *"running within the Claude Agent SDK"* — so they share a
    column rather than pretending to be separate products.

## Versions compared

This round was refreshed on 2026-11-09. Open-source columns were read from
source at the listed revision; the others from the shipped artifact or the
official release notes.

| Project | Version read | Source |
| --- | --- | --- |
| Steerable | `0.9.1`, Rust engine artifacts `1.0.7` | This repository |
| OpenAI Codex | `0.167.0` (`main` at `8703d32`) | Source |
| DeepSeek Harness | `0.2.2-rc.1` (`master` at `fcc0ad4`) | Source |
| Pi | `1.5.0` (`main` at `ea1cfcc`) | Source |
| LangGraph | `langgraph` 1.2.20, `@langchain/langgraph` 1.7.2 | Release notes and docs |
| OpenAI Agents SDK | `openai-agents` 0.24.0, `@openai/agents` 0.21.0 | Release notes and docs |
| Claude Code / Agent SDK | `2.1.319` | Shipped `darwin-arm64` binary and `sdk-tools.d.ts` |

## The short version

Most agent frameworks answer one of two questions: *"how do I orchestrate
agent logic?"* (LangGraph, OpenAI Agents SDK) or *"how do I ship a coding
agent product?"* (Claude Code, Codex, DeepSeek Harness, Pi). Steerable
answers a third: *"how do I ship the same agent loop into a desktop app and
a server, over one typed protocol, without rewriting the plumbing twice?"*
It is a layered library — protocol, harness, runtime/sidecar, UI, host
shell — where each tier is independently adoptable.

The field converged on several features since the previous round. MCP is no
longer a differentiator: Pi ships a built-in MCP client since `0.99`.
Session goals with auto-continuation exist in Codex, DeepSeek Harness, Claude
Code and the Steerable shell. Programmatic tool calling ships in Steerable,
DeepSeek Harness and Pi; Codex and Claude Code carry it behind development
flags. Sandboxed execution reached the OpenAI Agents SDK (Sandbox
Agents) and LangGraph's Deep Agents harness. The remaining differences are in
deployment form, confinement defaults, protocol surface and source
availability.

Ease of use was our largest gap in the previous round and is closed in
`0.9.1`: one `npm install` brings the runtime, `login` verifies the key, and a
turn refuses to start without one instead of returning a provider 401. The
comparison below keeps that history rather than presenting it as parity by
default.

## At a glance

| Dimension | Steerable | OpenAI Codex | DeepSeek Harness | Pi | LangGraph | OpenAI Agents SDK | Claude Code / Agent SDK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **What it is** | Layered framework in five independently published tiers (protocol, harness, runtime/sidecar, UI, host shell). Source is Apache-2.0; the CoreLoop engine and egress proxy are separately licensed binary-only Rust artifacts pinned by digest. A Tauri desktop shell, CLI/TUI, headless and ACP entry points run the same runtime | Product family: CLI/TUI, IDE, desktop, cloud — Rust core | Plugin-based TS harness on vendored Cordis; every part, including the agent loop, is a replaceable plugin. About 50 package groups composed into `dsh` profiles, including PTC runtime, computer use, browser use, team, workflow, goal and schedule | Minimal-core coding agent CLI (TS, 11 lockstep public packages, plus experimental Durable and Chord runtimes); MCP and codemode ship as replaceable built-in extensions; still no subagents or permission system in core | Low-level orchestration library (Py/JS): state graphs. The separate Deep Agents harness (planning, subagents, filesystem, skills) builds on it | Lightweight agent framework (Py/TS) over the Responses API, with Sandbox Agents for file and shell workspaces; a native Codex-runtime rewrite is in alpha | Closed-source product shipped as one bundle behind both the CLI and the Agent SDK |
| **Loop control / steering** | `CoreLoop` single-agent step loop (native engine behind a Python facade); structured `LoopEvent` taxonomy (15 stable kinds, frozen in a runtime contract); `agent.chat.steer` mid-turn plus queued follow-ups; fork. A retry after partial output withdraws the streamed text. Failed or stopped turns can be continued. The shell adds goals and recurring loops | Session-owned turn loop; `turn/steer`, interrupt, durable input queue; persisted thread goals with auto-continuation and token budgets; 14-event hook engine (command and MCP-tool handlers) | Inbox-driven loop; `steer` / `inject` / `followup` delivery; waterfall hooks (`agent/pre-step`, `tools/*`, `agent/turn-stopping` can extend a turn); goal rounds, workflow loops and scheduled follow-ups built on top | `agent-loop.ts` turn loop; steering and follow-up queues polled between turns; a `finishTurn` hook decides whether to end a turn; tool calls parallel by default, per-tool sequential opt-out | You design the graph; interrupts at node boundaries, each with its own id; opt-in strict resume rejects stale answers | Handoffs + guardrails; tool approvals pause and resume via `RunState`. No mid-run steering in stable releases; the alphas add `Turn` steering | Mid-turn "fold" queue absorbs messages between tool rounds, with a separate follow-up queue when folding is suspended; Stop hooks can veto turn completion, capped at 8 consecutive blocks (env-adjustable); `--max-turns`; a `turn_handoff` control request passes an in-flight turn to another worker |
| **Tool execution** | `ToolRouter` + `@tool`; host **reverse channel** — shell tools run in the host process (visible PTY, `write_stdin`, background jobs); stdio and Streamable HTTP MCP on desktop, sidecar, headless and ACP paths. Programmatic tool calling two ways: `run_code` (sandboxed Python child) and `run_js` / `wait_js` (persistent Node worker with KV and yield/wait cells), off in the framework and on in the shell. The public shell adds cross-turn Tasks (`task_run` / `task_send` / `task_status` / `task_result`, `dependsOn`), git worktrees, goals and loops | Unified exec (PTY), MCP, parallel gating (read-only tools run in parallel); remote executor via standalone `codex-exec-server`; subagent tools; Code Mode under development | Scoped tool registry with allow/deny/ask policy and per-tool parallel-safety declarations; native and PTC executors (persistent REPL); `apply_patch`, Bash/PowerShell, persistent PTY, LSP, web, background jobs; MCP client plus a settings-driven MCP manager | 8 built-in tools (4 on by default) plus built-in `codemode` (QuickJS-sandboxed JS calling tools in parallel) and `tool_search`; built-in MCP client (stdio, Streamable HTTP, OAuth); extensions register tools at runtime with no reload | `ToolNode` inside your graph; Deep Agents adds filesystem and shell tools | Function tools, MCP (with annotations), hosted tools, shell / `apply_patch`, computer use; sandbox capabilities | 45 built-in tool input types (`sdk-tools.d.ts`), lazy exposure via `ToolSearch` + `defer_loading`, tool concurrency hard-capped at 10; MCP over stdio/SSE/HTTP/WebSocket with eight config scopes, OAuth, and a 25k-token output cap |
| **Safety model** | Sidecar confinement on all three OSes: macOS Seatbelt, Linux bwrap falling back to Landlock, and on Windows a host-supplied restricted-token + Job Object helper that confines writes only. Each command reports `full` / `partial` / `none`, and a missing backend fails closed. A 61-rule command classifier, prefix policy rules, consent gate and plan-mode block form the second layer. **Egress is per-host by default** through the bundled CONNECT allow-list proxy (`steerable-egress-proxy`), with a port-only fallback when an ambient proxy is present | Approval policies + ExecPolicy + platform sandbox (Seatbelt / bubblewrap + seccomp / Windows restricted token and MXC) + managed network proxy + Guardian auto-review | `sandbox.confine` (bwrap then Landlock, Seatbelt, Windows restricted-token ACL backend), fail-closed; default `workspace-write` with approval `ask`; versioned-handle stale-write checks | None built-in — tools and extensions run with host user permissions and no per-call approval; project trust only controls which project resources load; containers or VMs are the documented isolation. Codemode scripts run in QuickJS, the tools they call do not | None in core — your infrastructure. Deep Agents runs shell and filesystem in pluggable sandboxes (Modal, Daytona, QuickJS) | Guardrails, tool guardrails and approvals; Sandbox Agents on Docker or hosted sandbox providers; the Unix-local client has no Linux confinement | Six permission modes (`default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`), `allow`/`deny`/`ask` rules from nine user-facing sources, `defer` as a fourth per-call state, headless fail-closed deny; Seatbelt/bwrap confinement with a domain allowlist, **opt-in** — the CLI defaults `failIfUnavailable` to false (fail-open), the Agent SDK `sandbox` option defaults it to true |
| **Protocol surface** | One JSON Schema → generated TS types/Zod + Pydantic models, lockstep-released and drift-checked in CI; sidecar JSON-RPC 2.0 over stdio (36 request methods plus notifications, frozen in a runtime contract); a conformance suite runs shared golden harness cases in both languages | app-server JSON-RPC v2 (about 180 client methods; stdio, WebSocket, Unix socket and remote-control transports) with generated TS types and JSON Schema; TypeScript and Python SDKs | JSON-RPC SDK (TS client/server and Python client) + automation-only ACP server; typed RPC gateway for the Web client; typed, declaration-merged session-event map | `--mode rpc` strict JSONL over stdio plus a `--mode json` event stream; the experimental CBOR `pi-protocol` server and client were removed in `1.2.0`; no cross-language codegen | LangSmith Deployment (formerly LangGraph Platform) Agent Server REST/SDK; `RemoteGraph`; an ACP adapter for Deep Agents | OpenAI Responses / Realtime APIs; LiteLLM and any-llm adapters for other providers; the alphas add an A2A client and server | `--print --input-format/--output-format stream-json` plus a 99-entry control-request registry — permission answers (`can_use_tool`), interrupt, `set_model`, `reload_plugins`, session claim and export, and about 30 `ui_*` messages that let a remote client drive the TUI; typed via the published `sdk-tools.d.ts` (TypeScript only) |
| **Skills ecosystem** | Layered disclosure: eager base skills in the system prompt, catalog skills loaded on demand via a `skill` tool; `SKILL.md`-compatible frontmatter (`disable-model-invocation` interop); the shell bundles built-in skills and manages agents, skills and MCP on one Plugins page | `SKILL.md` skills from `.agents/skills`, `.codex/skills`, admin and bundled roots; plugins with marketplaces, remote and curated plugins, and sharing | Skill provider registry (filesystem and Office skills) + catalog/loader tool and `/name` invocation; installable `dsh` bundles; plugin market (experimental) | Agent Skills (`SKILL.md`) from `~/.pi/agent/skills/`, `.pi/skills/` and `.agents/skills/`, exposed as `/skill:name`, model-invocable unless disabled | None in core; Deep Agents loads skills on demand | Sandbox `Skills` capability loads local skill directories lazily | Agent Skills plus a plugin runtime: a plugin contributes commands, skills, agents, hooks, MCP and LSP servers, output styles, themes, workflows, monitors, channels and pinned binaries, from seven install source kinds, hot-reloadable via `reload_plugins`, with a marketplace schema, a blocklist and an impersonation check |
| **Persistence / sessions** | Append-only session record in SQLite (WAL); desktop and CLI processes can write different sessions in one database; fork with seed provenance and cycle-guarded `lineage` walking; `agent.session.tree` feeds a `/tree`-style branch view with single-hop switching; `CompactionBoundary` carries pre/post token counts; cancelled turns persist | Pluggable thread store: local rollout JSONL (canonical history) + SQLite metadata, or cloud threads resumable from the TUI; resume + fork; opt-in memories | Append-only, event-sourced session log as versioned JSONL (format v4, optional zstd); migrations write a successor file and never overwrite; fork and resume; SQLite only for search and non-session storage | JSONL session tree keyed by cwd; `-c` / `-r` / `--fork`; in-session `/tree` branch UI; the SQLite backend was removed in `1.0`; durable SQLite storage lives in the experimental `pi-durable` package | Checkpointers (SQLite/Postgres/…) plus a Store for cross-thread memory | Sessions on SQLite, SQLAlchemy, Redis, MongoDB, Dapr, encrypted or OpenAI Conversations backends; `RunState` resume; sandbox snapshots | JSONL transcript per session under `~/.claude/projects/<cwd>/`, `parentUuid` chain with `isSidechain` branches, `--fork-session`, `--resume-session-at`, and a `logical_parent_uuid` that survives compaction |
| **Deployment form** | **Dual form**: embeddable signed sidecar (portable CPython carrying the native CoreLoop, JSON-RPC over stdio, host-agnostic) + in-process Python runtime for servers (FastAPI SSE). Steerable's own desktop shell is Tauri; also browser-server mode, CLI/TUI, headless and ACP | Local CLI/TUI/IDE/desktop (optional app-server daemon) + hosted cloud threads; remote executors; providers: OpenAI, Bedrock, Vertex AI, Ollama, LM Studio and custom, all over the Responses wire | npm `dsh` CLI with profiles (`web`, `headless`, `sdk`, `acp`); Web GUI; Electron desktop for macOS and Windows; Python SDK wheel that bundles `dsh` | npm packages + Bun standalone binaries + Nix flake; library SDK via `createAgentSession`; an unsupported self-hosted prototype app | Self-host or LangSmith Deployment | Your infra + OpenAI platform; sandboxes on Docker or hosted providers | Eight platform-specific native binaries (~320–345 MB each) behind an installer stub; no user-visible runtime to install |
| **Maturity** | `0.8.x`, pre-stable, frequent patch releases; one consumer codebase ([DeepPath](https://deeppath.cc)) ships several branded desktop builds; small traffic; the native engine is closed source | Massive real-world usage | Public prerelease only (`0.2.2-rc.1` on npm, MIT); public APIs pre-stable; versioned session-format migrations | Lockstep `1.5.0` across 11 public packages (`1.0.0` on 2026-10-01); roughly weekly releases | Widely adopted in production (1.x) | Production `0.x`, OpenAI-tied; the native-runtime rewrite in alpha carries breaking API changes | Production; Anthropic models only, routed across eight backends (first-party, Bedrock, Vertex, Foundry, Anthropic on AWS and Google Cloud, Mantle, Gateway). Much of the surface sits behind server-side flags, so reading the binary tells you the default, not necessarily what is live for a given user |

## Where Steerable is genuinely different

1. **Dual-form deployment, one loop.** The same `CoreLoop` runs embedded in
   a desktop app (signed sidecar, OS-sandboxed) and in a server process. The
   wire protocol is identical in both — a desktop frontend and a FastAPI
   backend consume the same event stream.
2. **The loop yields structured events, not bytes.** The `LoopEvent`
   taxonomy (15 stable kinds) was derived from a production server's ~114
   emission sites, then adopted by the desktop. Transports render wire
   formats — including byte-compatible rendering onto an existing frontend
   contract — instead of the loop printing SSE. See the
   [CoreLoop spec](spec/core-loop.md).
3. **Cross-language contract as codegen, not parallel implementation.**
   `spec/*.schema.json` is the single source of truth; TypeScript types and
   Pydantic models are generated and drift-checked in CI, and the sidecar
   method list and event kinds are frozen in a runtime contract. The
   conformance suite runs the same golden harness cases against both
   languages.
4. **A binary engine behind a public, versioned contract.** The Rust
   CoreLoop ships as a digest-pinned artifact with three compatibility
   identifiers checked in CI, so a host can upgrade the public packages and
   the engine independently and learn at load time when they disagree. See
   [Engine compatibility](spec/engine-compatibility.md).
5. **Confinement is fail-closed and reported per command.** When a sandbox
   backend is unavailable the sidecar refuses to run the command rather than
   running it unconfined, and each command reports `full`, `partial` or
   `none` enforcement to the UI. Windows hosts get write confinement and
   report the missing network enforcement as `partial` instead of hiding
   it. Claude Code's CLI takes the opposite default: its sandbox is opt-in
   and `failIfUnavailable` defaults to false there, so a missing backend
   prints a warning and proceeds. DeepSeek Harness also fails closed. See [Safety spec](spec/safety.md).
6. **Multi-process session database.** The desktop and the CLI can write
   different sessions in one SQLite database, so a CLI can drive a turn
   against the desktop's data directory and answer its approvals.

## Where Steerable lags — honestly

- **The CoreLoop source is not available.** Codex, DeepSeek Harness, Pi,
  LangGraph and the Agents SDK publish their loops; Steerable's engine is a
  separately licensed binary. You can audit the protocol, harness, runtime
  and UI, but not fork the loop itself.
- **Production volume.** Codex serves massive daily traffic; LangGraph is
  deployed across the industry. Steerable has one consumer codebase and a
  fraction of the mileage.
- **Ecosystem.** LangGraph's integration catalog and community dwarf ours.
  The framework-native MCP clients support stdio and Streamable HTTP on the
  sidecar, headless and ACP paths, and desktop hosts use the same
  transports through the reverse channel. What we lack is breadth of
  prebuilt integrations, not the wiring.
- **Extension runtime without a distribution trust layer.** A
  `PluginRegistry` tracks which tools each plugin registered and supports
  `enable` / `disable` / `unload` / `reload` per plugin without a sidecar
  restart. Two install sources ship: the `steerable.tools` entry point group
  and a local directory source (`STEERABLE_PLUGIN_DIR`). An out-of-process
  [plugin host protocol](spec/plugin-host.md) lets plugin authors depend only
  on `steerable-plugin-sdk`. Name collisions fail closed. What we still
  lack is what Claude Code and Codex now both have: a marketplace, and in
  Claude Code's case a blocklist and an impersonation check.
- **Context compaction: three default paths plus one opt-in, and both
  breakers.** Pressure-triggered, overflow-reactive and manual
  (`compact_now`) compaction are on by default; periodic micro-compaction
  (tool-result pruning) is opt-in via `micro_compact_interval_rounds`. Two
  circuit breakers match Claude Code's pair — three consecutive ineffective
  compactions, or three whose freed space refills within three rounds — and
  the tripping round appends an actionable thrashing reminder. A hysteresis
  margin (which Claude Code does not have) keeps a borderline transcript
  from re-compacting every round. What we still lack is Claude Code's
  partial compaction that keeps a named prefix or suffix of the
  conversation verbatim.
- **Structured questions reach the model end-to-end.** The `ask_user` tool
  follows Claude Code's `AskUserQuestion` constraints: 1–4 questions, a
  `header` chip label (≤12 chars, clipped when longer), 2–4 options per
  select question, a required `multiSelect`, and an automatic "Other"
  free-text option. Out-of-range payloads are returned to the model as a
  tool error to fix.
- **Write-conflict detection is a default-on gate.** File tools refuse a
  write to a file the model has not read this session, reject full-file
  writes after a clipped read, and detect external modification by content
  hash. Claude Code compares mtime and now re-compares content when only
  the mtime changed; DeepSeek Harness uses versioned-handle CAS.
- **Web tools carry the deployment policy knobs.** `web_search` /
  `web_fetch` enforce domain allow/block lists for every provider and a
  per-session search cap of 200 (Claude Code parity; Claude Code now also
  refills its cap hourly). Backends: Tavily, Brave Search, host-delegated
  OpenAI hosted search, and an explicit no-key DuckDuckGo lite backend. We
  still lack a self-hosted usage-accounting service.
- **Provider breadth.** Four wire protocols ship: OpenAI-compatible
  chat/completions, OpenAI Responses (also serving xAI), Anthropic-native
  and Gemini-native, with vendor divergences as compat flags and a preset
  table of vendor-documented sampling optima for open-weight families.
  Codex now ships built-in Bedrock and Vertex AI providers; we still lack
  Bedrock Converse and a remote model catalog with ETag-cached updates like
  Codex's (live `GET /models` discovery exists).
- **Sandbox coverage is uneven across platforms.** macOS and Linux get
  full process confinement. The Windows helper is supplied by the product
  (DeepPath), not by Steerable, and confines writes only: network rules
  report `partial`, and paths writable by Everyone stay writable. Codex and
  DeepSeek Harness both ship their own Windows backends. On Linux the
  namespace backends have no per-host pinning, so per-host egress there is
  enforced by the bundled proxy plus the app-layer domain list, and the UI
  says so. A denied CONNECT can be approved per session through the
  proxy's loopback control endpoint (its token never reaches sandboxed
  children), or auto-allowed by product configuration.
- **Getting started was the weakest part, and is now fixed.** Measured on a
  clean `HOME` on 2026-11-10, `npm install -g @steerable/agent-cli` followed
  by `steerable-cli doctor` used to fail with a Node stack trace: the npm
  package carried no Python sidecar, and the README did not say one was
  needed. Three undocumented steps followed (a PyPI install, two environment
  variables, a key). For comparison, Claude Code printed
  `Not logged in · Please run /login` and Pi pointed at its providers doc —
  both one step from working. The fix ships in `0.9.1`: the platform runtime
  is an optional npm dependency, `login` verifies a key before saving it, `run`
  refuses to start without a credential and prints the three ways to configure
  one, `doctor` prints one row per check with the command that fixes it, and
  `scripts/quickstart_smoke.mjs` runs the README's own commands on three
  platforms in CI.

  Verified on 2026-11-11 by installing `@steerable/agent-cli@0.9.1` from the
  registry into an empty project: one platform package came with it, the
  interpreter was executable, `--version` answered, `run` without a key printed
  the three commands and exited 78, and a turn against a local gateway returned
  its text. `doctor` reported the sidecar and egress proxy as coming from the
  platform package.

  What remains behind: the CLI needs Node 22.19 (Pi 22.19, Claude Code 22) and
  `tui` still needs 26.4 for its renderer. pnpm needs `better-sqlite3` and
  `node-pty` in `onlyBuiltDependencies`, or the CLI imports and then throws —
  npm runs those scripts and only warns. Windows cannot start a turn until the
  engine release publishes `win-spawn-helper.exe`, and linux-arm64 ships
  without the egress proxy; both are gaps in the private release, not in the
  install path.
- **No hosted offering.** No cloud, no managed platform, no live
  observability stream. Traces and per-turn outcome counters export to
  OTLP after the fact, without conversation content. Codex now resumes
  cloud threads from its local client.
- **Multi-agent: one delegate tool on a shared pool.** The model-facing
  surface is a single `delegate_subagent` tool — depth 1 by construction,
  named `subagent_type` profiles with per-profile tool domains that fail
  closed (`tool_not_delegated`), per-profile models and system prompts, and
  profile descriptions in the tool schema so the model picks a profile by
  purpose (Claude Code `.claude/agents` parity). Delegations run on the
  framework's `AgentPool` under one budget, and child lifecycle lands as
  `agent.child` events. A six-tool orchestration family (`agent_spawn` /
  `agent_send` / `agent_wait` / `agent_close` / `agent_list` /
  `agent_interrupt`) is off in the framework and on by default in the
  shell. Planning, DAGs and groupchat stay out of the framework by design.
  If you want batteries-included orchestration, LangGraph, Deep Agents or
  the Agents SDK will get you there faster.

## Terminal-Bench 2.1

The score of record is **Steerable + GLM-5.3-Flash = 79.0% ±3.4** on the 89-task catalog (three-run mean measured on 2026-09-23 with the Rust CoreLoop; see [Evals](evals.md)), averaging **229.9M input tokens per run**. It predates the `0.7` and `0.8` lines, including the removal of the default round and tool-error caps, so it does not describe the current release; a full-catalog re-run is the next release-gate item. Provider prices changed between measurement windows, so the baseline does not claim a cross-date dollar cost.

On the same model and Harbor protocol, Claude Code scores 83.1% and Pi scores 73.4%; both runs predate the versions read in the table above. Z.AI's own Claude Code run of GLM-5.3-Flash is 84.3% under a 6-hour timeout — we wrap at 170 minutes. Pass rate and token volume are tracked as co-equal metrics because they can move in opposite directions. Read the current score with its 3.4-point sample standard deviation.

## Choosing

**Reach for Steerable when** you need a typed cross-language contract
(TS + Python generated from one schema), plan to ship to desktop / on-prem /
air-gapped environments, want the same loop in your desktop app and your
FastAPI backend, or want a headless React chat UI you can theme without
fighting markup opinions.

**Don't reach for Steerable when** your agent lives entirely inside one
Python process with no frontend (LangGraph or the Agents SDK are more
direct), you need to audit or fork the agent loop itself (Codex, DeepSeek
Harness and Pi publish theirs), you want a hosted platform with managed
tracing and evals, you need a large integration ecosystem today, or you
want a finished product rather than plumbing — Claude Code and Codex ship
the product.

## Related

- [CoreLoop spec](spec/core-loop.md) — the loop and its event taxonomy
- [Safety spec](spec/safety.md) — the two-layer safety model
- [Sidecar spec](spec/sidecar.md) — the JSON-RPC method catalog
- [Engine compatibility](spec/engine-compatibility.md) — how the binary engine is versioned
- [Architecture](spec/architecture.md) — the tier layering rule
