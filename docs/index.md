---
hide:
  - navigation
  - toc
---

<script>
(function () {
  if (location.hash) return;
  var saved = null;
  try { saved = localStorage.getItem("sf_lang"); } catch (_err) {}
  if (saved === "en") return;
  if (saved === "zh" || saved === "ja") {
    location.replace(saved + "/");
    return;
  }
  var langs = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || ""];
  for (var i = 0; i < langs.length; i++) {
    var code = String(langs[i] || "").toLowerCase();
    if (!code) continue;
    if (code.indexOf("zh") === 0) { location.replace("zh/"); return; }
    if (code.indexOf("ja") === 0) { location.replace("ja/"); return; }
    if (code.indexOf("en") === 0) { return; }
  }
})();
</script>

<div class="sf-hero" data-lang="en" markdown>

<svg class="sf-px-clouds" viewBox="0 0 960 120" aria-hidden="true" shape-rendering="crispEdges">
  <!-- left pixel cloud -->
  <g transform="translate(28,18)">
    <rect x="24" y="0" width="40" height="8" fill="#1E242B"/>
    <rect x="16" y="8" width="56" height="8" fill="#1E242B"/>
    <rect x="8" y="16" width="76" height="8" fill="#1E242B"/>
    <rect x="0" y="24" width="92" height="16" fill="#1E242B"/>
    <rect x="8" y="40" width="76" height="8" fill="#1E242B"/>
    <rect x="24" y="8" width="40" height="8" fill="#FFFDF7"/>
    <rect x="16" y="16" width="60" height="8" fill="#FFFDF7"/>
    <rect x="8" y="24" width="76" height="12" fill="#FFFDF7"/>
    <rect x="12" y="34" width="68" height="6" fill="#D5E3EE"/>
  </g>
  <!-- right pixel cloud -->
  <g transform="translate(824,14)">
    <rect x="28" y="0" width="44" height="8" fill="#1E242B"/>
    <rect x="16" y="8" width="68" height="8" fill="#1E242B"/>
    <rect x="8" y="16" width="84" height="8" fill="#1E242B"/>
    <rect x="0" y="24" width="100" height="16" fill="#1E242B"/>
    <rect x="8" y="40" width="84" height="8" fill="#1E242B"/>
    <rect x="28" y="8" width="44" height="8" fill="#FFFDF7"/>
    <rect x="16" y="16" width="68" height="8" fill="#FFFDF7"/>
    <rect x="8" y="24" width="84" height="12" fill="#FFFDF7"/>
    <rect x="12" y="34" width="76" height="6" fill="#D5E3EE"/>
  </g>
  <g class="sf-px-stars">
    <rect x="172" y="22" width="4" height="4" fill="#FEF08A"/>
    <rect x="248" y="54" width="3" height="3" fill="#FFFDF7"/>
    <rect x="336" y="18" width="4" height="4" fill="#FDE047"/>
    <rect x="614" y="20" width="4" height="4" fill="#FFFDF7"/>
    <rect x="688" y="58" width="3" height="3" fill="#FEF08A"/>
    <rect x="768" y="82" width="4" height="4" fill="#FFFDF7"/>
  </g>
</svg>

<button type="button" class="sf-celestial" aria-label="Switch to dark mode" title="Switch to dark mode" aria-pressed="false">
  <svg class="sf-celestial-svg sf-celestial-sun" viewBox="0 0 24 24" aria-hidden="true" shape-rendering="crispEdges">
    <rect x="11" y="1" width="2" height="3" fill="#EA7A2E"/>
    <rect x="11" y="20" width="2" height="3" fill="#EA7A2E"/>
    <rect x="1" y="11" width="3" height="2" fill="#EA7A2E"/>
    <rect x="20" y="11" width="3" height="2" fill="#EA7A2E"/>
    <rect x="4" y="4" width="2" height="2" fill="#F59E0B"/>
    <rect x="18" y="4" width="2" height="2" fill="#F59E0B"/>
    <rect x="4" y="18" width="2" height="2" fill="#F59E0B"/>
    <rect x="18" y="18" width="2" height="2" fill="#F59E0B"/>
    <rect x="8" y="6" width="8" height="12" fill="#1E242B"/>
    <rect x="6" y="8" width="12" height="8" fill="#1E242B"/>
    <rect x="7" y="7" width="10" height="10" fill="#1E242B"/>
    <rect x="9" y="7" width="6" height="10" fill="#F59E0B"/>
    <rect x="7" y="9" width="10" height="6" fill="#F59E0B"/>
    <rect x="8" y="8" width="8" height="8" fill="#FACC15"/>
    <rect x="9" y="9" width="5" height="5" fill="#FEF08A"/>
  </svg>
  <svg class="sf-celestial-svg sf-celestial-moon" viewBox="0 0 24 24" aria-hidden="true" shape-rendering="crispEdges">
    <rect x="18" y="3" width="2" height="2" fill="#FEF08A"/>
    <rect x="19" y="8" width="1" height="1" fill="#FFFDF7"/>
    <rect x="4" y="17" width="2" height="2" fill="#FEF08A"/>
    <rect x="9" y="4" width="6" height="2" fill="#1E242B"/>
    <rect x="7" y="6" width="8" height="2" fill="#1E242B"/>
    <rect x="5" y="8" width="8" height="8" fill="#1E242B"/>
    <rect x="7" y="16" width="8" height="2" fill="#1E242B"/>
    <rect x="9" y="18" width="8" height="2" fill="#1E242B"/>
    <rect x="15" y="15" width="3" height="3" fill="#1E242B"/>
    <rect x="9" y="5" width="5" height="2" fill="#FACC15"/>
    <rect x="7" y="7" width="5" height="3" fill="#FACC15"/>
    <rect x="6" y="9" width="4" height="6" fill="#FDE047"/>
    <rect x="7" y="14" width="5" height="3" fill="#FACC15"/>
    <rect x="9" y="16" width="7" height="3" fill="#FACC15"/>
    <rect x="14" y="15" width="3" height="2" fill="#FDE047"/>
    <rect x="8" y="9" width="2" height="4" fill="#FEF9C3"/>
  </svg>
</button>

<div class="sf-hero-logo-wrap">
<img class="sf-hero-logo" src="assets/logo.png" alt="Steerable logo" />
</div>

# Steerable

<p class="sf-tagline"><span class="sf-ribbon">◆ The model-quality layer for local &amp; cheap models ◆</span></p>

<p class="sf-pills">
<a href="#pillar-1" class="sf-pill">Fewer hallucinations</a>
<a href="#pillar-2" class="sf-pill">Smallest code</a>
<a href="#pillar-3" class="sf-pill">Ready out of the box</a>
<a href="#pillar-4" class="sf-pill">Componentized</a>
</p>

<p class="sf-sub" markdown>
**79.0%** on Terminal-Bench 2.1 with GLM-5.3-Flash. One command boots the full shell, or adopt any layer standalone.
</p>

<div class="sf-cta" markdown>
<a href="#run" class="md-button md-button--primary">Run it in one command</a>
<a href="demo/" class="md-button">Live demo</a>
</div>

<p class="sf-cta-secondary" markdown>
[Get started](getting-started.md) · <a href="storybook/">Storybook</a> · <a href="https://github.com/pathlyapp/steerable" target="_blank" rel="noopener noreferrer">★ Star on GitHub</a>
</p>

<p class="sf-badges">
  <a href="https://github.com/pathlyapp/steerable" target="_blank" rel="noopener noreferrer"><img alt="GitHub stars" src="https://img.shields.io/github/stars/pathlyapp/steerable?label=Star&color=f59e0b" /></a>
  <a href="https://github.com/pathlyapp/steerable/blob/main/LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" /></a>
  <a href="https://www.npmjs.com/package/@steerable/agent-protocol"><img alt="npm: @steerable/agent-protocol" src="https://img.shields.io/npm/v/@steerable/agent-protocol?label=%40steerable%2Fagent-protocol&color=cb3837" /></a>
  <a href="https://www.npmjs.com/package/@steerable/agent-ui"><img alt="npm: @steerable/agent-ui" src="https://img.shields.io/npm/v/@steerable/agent-ui?label=%40steerable%2Fagent-ui&color=cb3837" /></a>
  <a href="https://pypi.org/project/steerable-agent-runtime/"><img alt="PyPI: steerable-agent-runtime" src="https://img.shields.io/pypi/v/steerable-agent-runtime?label=steerable-agent-runtime&color=3776ab" /></a>
  <a href="https://pypi.org/project/steerable-sidecar/"><img alt="PyPI: steerable-sidecar" src="https://img.shields.io/pypi/v/steerable-sidecar?label=steerable-sidecar&color=3776ab" /></a>
</p>

<svg class="sf-px-ground" viewBox="0 0 960 64" preserveAspectRatio="none" aria-hidden="true" shape-rendering="crispEdges">
  <!-- left terraced hill + green S flag -->
  <rect x="0" y="32" width="144" height="32" fill="#8B5A30"/>
  <rect x="0" y="24" width="152" height="12" fill="#2FA858"/>
  <rect x="0" y="20" width="144" height="6" fill="#46C96E"/>
  <rect x="144" y="40" width="64" height="24" fill="#8B5A30"/>
  <rect x="144" y="34" width="72" height="10" fill="#2FA858"/>
  <rect x="208" y="48" width="552" height="16" fill="#8B5A30"/>
  <rect x="208" y="44" width="552" height="8" fill="#2FA858"/>
  <rect x="208" y="42" width="552" height="3" fill="#46C96E"/>
  <!-- dirt pixel bricks -->
  <rect x="24" y="42" width="16" height="8" fill="#6E4421"/>
  <rect x="84" y="48" width="20" height="8" fill="#6E4421"/>
  <rect x="310" y="52" width="24" height="6" fill="#6E4421"/>
  <rect x="520" y="54" width="24" height="6" fill="#6E4421"/>
  <rect x="640" y="50" width="20" height="6" fill="#6E4421"/>
  <!-- left flag -->
  <rect x="34" y="0" width="4" height="22" fill="#1E242B"/>
  <rect x="38" y="2" width="26" height="14" fill="#1E242B"/>
  <rect x="40" y="4" width="22" height="10" fill="#229659"/>
  <rect x="47" y="6" width="8" height="2" fill="#FFFDF7"/>
  <rect x="47" y="8" width="2" height="2" fill="#FFFDF7"/>
  <rect x="47" y="9" width="8" height="2" fill="#FFFDF7"/>
  <rect x="53" y="10" width="2" height="2" fill="#FFFDF7"/>
  <rect x="47" y="11" width="8" height="2" fill="#FFFDF7"/>
  <!-- right terraced hill + orange S flag -->
  <rect x="752" y="40" width="64" height="24" fill="#8B5A30"/>
  <rect x="744" y="34" width="72" height="10" fill="#2FA858"/>
  <rect x="816" y="32" width="144" height="32" fill="#8B5A30"/>
  <rect x="808" y="24" width="152" height="12" fill="#2FA858"/>
  <rect x="816" y="20" width="144" height="6" fill="#46C96E"/>
  <rect x="880" y="46" width="18" height="8" fill="#6E4421"/>
  <!-- right flag -->
  <rect x="922" y="2" width="4" height="20" fill="#1E242B"/>
  <rect x="896" y="4" width="26" height="14" fill="#1E242B"/>
  <rect x="898" y="6" width="22" height="10" fill="#EA7A2E"/>
  <rect x="905" y="8" width="8" height="2" fill="#FFFDF7"/>
  <rect x="905" y="10" width="8" height="2" fill="#FFFDF7"/>
  <rect x="905" y="12" width="8" height="2" fill="#FFFDF7"/>
  <!-- tiny pixel flowers -->
  <rect x="260" y="36" width="4" height="6" fill="#2FA858"/>
  <rect x="258" y="34" width="8" height="4" fill="#F59E0B"/>
  <rect x="690" y="36" width="4" height="6" fill="#2FA858"/>
  <rect x="688" y="34" width="8" height="4" fill="#3B82F6"/>
</svg>

</div>

<div class="sf-score-strip" markdown>
<div class="sf-score sf-score--ours" markdown>
<span class="sf-score-value">79.0%</span>
<span class="sf-score-label">Steerable + GLM-5.3-Flash</span>
<span class="sf-score-meta">TB 2.1 · this repo</span>
</div>
<div class="sf-score" markdown>
<span class="sf-score-value">+23.6</span>
<span class="sf-score-label">vs Codex on the same GLM</span>
<span class="sf-score-meta">Codex + GLM-5.3-Flash · 56.2%</span>
</div>
<div class="sf-score" markdown>
<span class="sf-score-value">229.9M</span>
<span class="sf-score-label">input tokens per catalog run</span>
<span class="sf-score-meta">three-run mean · 15.4% below prior baseline</span>
</div>
</div>

<nav class="sf-subnav" aria-label="On this page">
<a href="#run">Quick start</a>
<a href="#quickstart">Integrate</a>
<a href="#why">Architecture</a>
<a href="#bench">Compare</a>
<a href="#users">Users</a>
</nav>

<div class="sf-run" id="run">
<div class="sf-run-copy">
<span class="sf-pillar-kicker">01 · Quick start</span>
<p class="sf-run-title">One command, full agent</p>
<p class="sf-run-text">Chat, terminal, sandboxed sidecar, and any OpenAI-compat, Anthropic, or Gemini key — across browser, desktop, and CLI.</p>
<a href="#quickstart" class="md-button">Embed a layer ↓</a>
</div>
<div class="sf-run-term">
<input type="radio" name="sf-run-mode" id="sf-run-web" class="sf-run-radio" checked>
<input type="radio" name="sf-run-mode" id="sf-run-desktop" class="sf-run-radio">
<input type="radio" name="sf-run-mode" id="sf-run-cli" class="sf-run-radio">
<div class="sf-run-bar" role="tablist" aria-label="Launch mode">
<div class="sf-run-dots" aria-hidden="true"><span></span><span></span><span></span></div>
<div class="sf-run-tabs">
<label for="sf-run-web" role="tab" aria-selected="true" tabindex="0">Web</label>
<label for="sf-run-desktop" role="tab" aria-selected="false" tabindex="-1">Desktop app</label>
<label for="sf-run-cli" role="tab" aria-selected="false" tabindex="-1">Command line</label>
</div>
<button type="button" class="sf-run-copy" aria-label="Copy commands">
<span class="sf-run-copy-text">Copy</span>
</button>
</div>
<div class="sf-run-pane sf-run-pane--web" role="tabpanel">
<pre><code><span class="sf-cmd">git clone https://github.com/pathlyapp/steerable.git</span>
<span class="sf-cmd">cd steerable &amp;&amp; pnpm install</span>
<span class="sf-cmd"><b>pnpm agent-shell:web</b></span></code></pre>
<div class="sf-out">→ Steerable Shell listening at http://127.0.0.1:4787</div>
</div>
<div class="sf-run-pane sf-run-pane--desktop" role="tabpanel">
<pre><code><span class="sf-cmd"># in your product repo, with src-tauri wired to the shell crate</span>
<span class="sf-cmd"><b>pnpm tauri dev</b></span></code></pre>
<div class="sf-out">→ native window on the same host runtime and sidecar</div>
</div>
<div class="sf-run-pane sf-run-pane--cli" role="tabpanel">
<pre><code><span class="sf-cmd">npm install -g @steerable/agent-cli</span>
<span class="sf-cmd"><b>steerable-cli login</b></span>
<span class="sf-cmd">steerable-cli run "summarize this repo"</span></code></pre>
<div class="sf-out">→ one install brings the runtime; login verifies the key; Node 22.19 or newer (the terminal session needs 26.4)</div>
</div>
</div>
</div>

<h2 class="sf-section" id="quickstart">Easy to integrate</h2>

<p class="sf-lede" markdown>
Embed only the layer you need — a Python agent, React chat UI, or a Node.js agent. UI-only showcase: <code>pnpm shell:dev</code>.
</p>

<div class="sf-tabs" markdown>

=== "Python agent"

    ```bash
    uv add steerable-agent-protocol steerable-agent-harness steerable-agent-runtime
    ```

    ```python
    from steerable_agent_runtime import ToolRouter, tool
    from steerable_agent_protocol import ToolCall

    router = ToolRouter()

    @tool(router=router, description="Read a file by path")
    async def read_file(path: str) -> dict:
        return {"path": path, "content": open(path).read()}

    result = await router.dispatch(
        ToolCall(id="c1", name="read_file", arguments={"path": "README.md"})
    )
    # result.success, result.data, result.error — all typed.
    ```

=== "React chat UI"

    ```bash
    pnpm add @steerable/agent-protocol @steerable/agent-ui
    ```

    ```tsx
    import { ChatPanel, useChatStream } from '@steerable/agent-ui';

    export function Chat() {
      const { messages, send, isStreaming } = useChatStream({
        endpoint: '/api/chats/123/send',
      });
      return <ChatPanel messages={messages} onSubmit={send} isStreaming={isStreaming} />;
    }
    ```

=== "Node.js agent"

    ```bash
    # Bundle the sidecar binary into resources/python-runtime/<platform>/
    pnpm add @steerable/agent-runtime
    ```

    ```ts
    import { AgentRuntime } from '@steerable/agent-runtime';

    const runtime = new AgentRuntime({ sidecarPath });
    await runtime.start();   // spawn + lifecycle.ready handshake

    const stream = await runtime.chatStream({
      provider: 'openai_compat',
      model: 'glm-5.3-flash',
      baseUrl: process.env.GATEWAY_BASE_URL!,
      apiKey: process.env.GATEWAY_API_KEY!,
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const event of stream.events) { /* typed SSEEvent stream */ }
    ```

</div>

<div class="sf-loop-stage" id="loop-stage" data-focus="all">
<div class="sf-loop-head">
<span class="sf-loop-badge">◆ ONE LOOP · TWO DEPLOYMENT FORMS ◆</span>
<div class="sf-loop-controls" role="toolbar" aria-label="Inspect CoreLoop deployment targets">
<button type="button" class="sf-loop-btn is-active" data-target="all" aria-pressed="true">Overview</button>
<button type="button" class="sf-loop-btn" data-target="core" aria-pressed="false">CoreLoop</button>
<button type="button" class="sf-loop-btn" data-target="desktop" aria-pressed="false">Desktop &amp; TUI</button>
<button type="button" class="sf-loop-btn" data-target="server" aria-pressed="false">Server</button>
</div>
</div>

<div class="sf-svg-scroll">
<svg class="sf-loop-svg" viewBox="0 0 820 248" role="img" aria-label="One CoreLoop powering both Desktop & Terminal (Tauri app / CLI & TUI) and Server (FastAPI SSE) over one typed protocol." shape-rendering="crispEdges">
  <!-- connecting pixel pipes from CoreLoop bottom to Desktop & Server -->
  <g class="sf-pipe-group">
    <!-- left pipe -->
    <path class="sf-pipe-bg" d="M368 150 L368 184 L216 184 L216 168" fill="none" stroke="#1E242B" stroke-width="14" stroke-linejoin="miter"/>
    <path class="sf-pipe-fill" d="M368 150 L368 184 L216 184 L216 168" fill="none" stroke="#229659" stroke-width="8" stroke-linejoin="miter"/>
    <path class="sf-pipe-pulse" d="M368 150 L368 184 L216 184 L216 168" fill="none" stroke="#FEF08A" stroke-width="4" stroke-dasharray="10 18"/>
    <!-- right pipe -->
    <path class="sf-pipe-bg" d="M452 150 L452 184 L604 184 L604 168" fill="none" stroke="#1E242B" stroke-width="14" stroke-linejoin="miter"/>
    <path class="sf-pipe-fill" d="M452 150 L452 184 L604 184 L604 168" fill="none" stroke="#229659" stroke-width="8" stroke-linejoin="miter"/>
    <path class="sf-pipe-pulse" d="M452 150 L452 184 L604 184 L604 168" fill="none" stroke="#FEF08A" stroke-width="4" stroke-dasharray="10 18"/>
    <!-- pipe collar joints -->
    <rect x="358" y="144" width="20" height="8" fill="#1FA866" stroke="#1E242B" stroke-width="3"/>
    <rect x="442" y="144" width="20" height="8" fill="#1FA866" stroke="#1E242B" stroke-width="3"/>
  </g>

  <!-- Left window: Desktop & Terminal -->
  <g class="sf-loop-node" data-node="desktop" tabindex="0" role="button" aria-label="Inspect Desktop & Terminal target">
    <rect x="28" y="24" width="236" height="146" fill="#1E242B"/>
    <rect x="22" y="18" width="236" height="146" fill="#FFFDF7" stroke="#1E242B" stroke-width="4"/>
    <rect x="22" y="18" width="236" height="24" fill="#1E8250" stroke="#1E242B" stroke-width="4"/>
    <rect x="34" y="26" width="8" height="8" fill="#EA7A2E"/>
    <rect x="46" y="26" width="8" height="8" fill="#FACC15"/>
    <rect x="58" y="26" width="8" height="8" fill="#86EFAC"/>
    <!-- monitor icon -->
    <rect x="66" y="54" width="54" height="38" fill="#1E242B"/>
    <rect x="70" y="58" width="46" height="28" fill="#3B82F6"/>
    <rect x="89" y="64" width="8" height="2" fill="#FFFDF7"/>
    <rect x="89" y="66" width="2" height="4" fill="#FFFDF7"/>
    <rect x="89" y="70" width="8" height="2" fill="#FFFDF7"/>
    <rect x="95" y="72" width="2" height="4" fill="#FFFDF7"/>
    <rect x="89" y="76" width="8" height="2" fill="#FFFDF7"/>
    <rect x="86" y="92" width="14" height="6" fill="#1E242B"/>
    <rect x="78" y="96" width="30" height="4" fill="#1E242B"/>
    <!-- terminal icon -->
    <rect x="138" y="54" width="54" height="46" fill="#1E242B"/>
    <rect x="142" y="58" width="46" height="38" fill="#18202C"/>
    <rect x="150" y="68" width="4" height="4" fill="#4ADE80"/>
    <rect x="154" y="72" width="4" height="4" fill="#4ADE80"/>
    <rect x="150" y="76" width="4" height="4" fill="#4ADE80"/>
    <rect x="162" y="78" width="12" height="4" fill="#4ADE80"/>
    <text class="sf-svg-title" x="140" y="124" text-anchor="middle">Desktop &amp; Terminal</text>
    <rect x="56" y="134" width="168" height="22" fill="#1E8250" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-svg-pill" x="140" y="149" text-anchor="middle">Tauri Desktop / CLI &amp; TUI</text>
  </g>

  <!-- Center gear: CoreLoop -->
  <g class="sf-loop-node" data-node="core" tabindex="0" role="button" aria-label="Inspect CoreLoop engine">
    <!-- pixel gear silhouette -->
    <rect x="392" y="22" width="36" height="14" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="392" y="142" width="36" height="14" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="336" y="72" width="14" height="34" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="470" y="72" width="14" height="34" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="352" y="40" width="22" height="22" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="446" y="40" width="22" height="22" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="352" y="116" width="22" height="22" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="446" y="116" width="22" height="22" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="350" y="36" width="120" height="106" fill="#1FA866" stroke="#1E242B" stroke-width="4"/>
    <rect x="362" y="48" width="96" height="72" fill="#FFFDF7" stroke="#1E242B" stroke-width="3"/>
    <!-- infinity pixel loop -->
    <rect x="374" y="68" width="28" height="24" fill="none" stroke="#EA7A2E" stroke-width="6"/>
    <rect x="418" y="68" width="28" height="24" fill="none" stroke="#1E8250" stroke-width="6"/>
    <rect x="404" y="74" width="12" height="12" fill="#F59E0B"/>
    <!-- CoreLoop plaque -->
    <rect x="356" y="116" width="108" height="28" fill="#1E242B"/>
    <rect x="359" y="119" width="102" height="22" fill="#1E8250"/>
    <text class="sf-svg-core" x="410" y="135" text-anchor="middle">CoreLoop</text>
  </g>

  <!-- Right window: Server -->
  <g class="sf-loop-node" data-node="server" tabindex="0" role="button" aria-label="Inspect Server target">
    <rect x="568" y="24" width="236" height="146" fill="#1E242B"/>
    <rect x="562" y="18" width="236" height="146" fill="#FFFDF7" stroke="#1E242B" stroke-width="4"/>
    <rect x="562" y="18" width="236" height="24" fill="#2563EB" stroke="#1E242B" stroke-width="4"/>
    <rect x="574" y="26" width="8" height="8" fill="#EA7A2E"/>
    <rect x="586" y="26" width="8" height="8" fill="#FACC15"/>
    <rect x="598" y="26" width="8" height="8" fill="#86EFAC"/>
    <!-- server rack pixel art -->
    <rect x="640" y="50" width="80" height="14" fill="#94A3B8" stroke="#1E242B" stroke-width="3"/>
    <rect x="648" y="55" width="8" height="4" fill="#1E242B"/>
    <rect x="706" y="55" width="6" height="4" fill="#38BDF8"/>
    <rect x="640" y="68" width="80" height="14" fill="#94A3B8" stroke="#1E242B" stroke-width="3"/>
    <rect x="648" y="73" width="8" height="4" fill="#1E242B"/>
    <rect x="706" y="73" width="6" height="4" fill="#4ADE80"/>
    <rect x="640" y="86" width="80" height="14" fill="#94A3B8" stroke="#1E242B" stroke-width="3"/>
    <rect x="648" y="91" width="8" height="4" fill="#1E242B"/>
    <rect x="706" y="91" width="6" height="4" fill="#FACC15"/>
    <text class="sf-svg-title" x="680" y="124" text-anchor="middle">Server</text>
    <rect x="596" y="134" width="168" height="22" fill="#2563EB" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-svg-pill" x="680" y="149" text-anchor="middle">FastAPI SSE / Python</text>
  </g>

  <!-- bottom ribbon -->
  <rect x="200" y="206" width="420" height="32" fill="#1E242B"/>
  <rect x="204" y="208" width="412" height="26" fill="#1E8250"/>
  <text class="sf-svg-ribbon" x="410" y="226" text-anchor="middle">◆ SAME LOOP · DUAL DEPLOYMENT · TYPED PROTOCOL ◆</text>
</svg>
</div>

<p class="sf-loop-caption" id="sf-loop-caption">
One Rust <code>CoreLoop</code> drives both the desktop sidecar (stdio JSON-RPC) and the FastAPI server (SSE) over <code>LoopEvent</code>.
</p>
</div>

<h2 class="sf-section" id="why">Core mechanisms</h2>

<p class="sf-lede" markdown>
Built for imperfect models — deterministic tool recovery, grounding vetoes, and fail-closed confinement.
</p>

<div class="sf-pillars" markdown>
<div class="sf-pillar" id="pillar-1" markdown>
<span class="sf-pillar-kicker">01 · Fewer hallucinations</span>
### Grounded, not guessed
Grounding judges, completion vetoes, and automatic recovery for malformed text tool calls.
</div>
<div class="sf-pillar" id="pillar-2" markdown>
<span class="sf-pillar-kicker">02 · Smallest code</span>
### Built for vibe coding
The smallest code surface. Plain `@tool` functions, no graph DSL.
</div>
<div class="sf-pillar" id="pillar-3" markdown>
<span class="sf-pillar-kicker">03 · Ready out of the box</span>
### Fail-closed by default
Seatbelt / bwrap / Windows confinement, 61-rule classifier, and egress proxy. Try the keyless [live demo](demo/).
</div>
<div class="sf-pillar" id="pillar-4" markdown>
<span class="sf-pillar-kicker">04 · Componentized</span>
### Take one layer, skip the rest
5 tiers, 15 packages, strict no-upward-imports. Adopt just the protocol, UI, or sidecar.
</div>
</div>

<h2 class="sf-section" id="architecture">Architecture</h2>

<p class="sf-lede" markdown>
Strict no-upward-imports rule — adopt any tier and inherit only what sits below it. [Architecture spec](spec/architecture.md)
</p>

<div class="sf-arch-stage" id="arch-stage" data-focus="all">
<div class="sf-arch-head">
<span class="sf-arch-badge">◆ FIVE TIERS · NO UPWARD IMPORTS ◆</span>
<div class="sf-arch-controls" role="toolbar" aria-label="Select a tier to see what it inherits">
<button type="button" class="sf-arch-btn is-active" data-tier="all" aria-pressed="true">All tiers</button>
<button type="button" class="sf-arch-btn" data-tier="t5" aria-pressed="false">T5 Shell</button>
<button type="button" class="sf-arch-btn" data-tier="t4" aria-pressed="false">T4 UI</button>
<button type="button" class="sf-arch-btn" data-tier="t3s" aria-pressed="false">T3 Sidecar</button>
<button type="button" class="sf-arch-btn" data-tier="t3r" aria-pressed="false">T3 Runtime</button>
<button type="button" class="sf-arch-btn" data-tier="t2" aria-pressed="false">T2 Harness</button>
<button type="button" class="sf-arch-btn" data-tier="t1" aria-pressed="false">T1 Protocol</button>
</div>
</div>

<div class="sf-svg-scroll">
<svg class="sf-arch-svg" viewBox="0 0 820 420" role="img" aria-label="Steerable five-tier architecture stack from Tier 5 Host Shell at top down to Tier 1 Protocol foundation at bottom." shape-rendering="crispEdges">
  <!-- Dependency connectors (layered beneath blocks) -->
  <g class="sf-arch-edges">
    <!-- T5 -> T4 (left) -->
    <line class="sf-edge" data-from="t5" data-to="t4" x1="210" y1="74" x2="210" y2="102" stroke="#1E242B" stroke-width="3" stroke-dasharray="5 4"/>
    <rect class="sf-edge-lbl" data-from="t5" data-to="t4" x="158" y="79" width="78" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t5" data-to="t4" x="197" y="91" text-anchor="middle">renders with</text>

    <!-- T5 -> T3S (center-right) -->
    <path class="sf-edge" data-from="t5" data-to="t3s" d="M510 74 L510 88 L352 88 L352 178" fill="none" stroke="#1E242B" stroke-width="3"/>
    <rect class="sf-edge-lbl" data-from="t5" data-to="t3s" x="454" y="79" width="76" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t5" data-to="t3s" x="492" y="91" text-anchor="middle">supervises</text>

    <!-- T4 -> T3S (host bridge) -->
    <path class="sf-edge" data-from="t4" data-to="t3s" d="M276 154 L276 168 L302 168 L302 178" fill="none" stroke="#1E242B" stroke-width="3"/>
    <rect class="sf-edge-lbl" data-from="t4" data-to="t3s" x="236" y="158" width="72" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t4" data-to="t3s" x="272" y="170" text-anchor="middle">host bridge</text>

    <!-- T4 -> T1 (outer left wire types) -->
    <path class="sf-edge" data-from="t4" data-to="t1" d="M108 154 L108 344" fill="none" stroke="#7C3AED" stroke-width="3" stroke-dasharray="5 4"/>
    <rect class="sf-edge-lbl" data-from="t4" data-to="t1" x="69" y="244" width="78" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t4" data-to="t1" x="108" y="256" text-anchor="middle">wire types</text>

    <!-- T3S -> T2 -->
    <line class="sf-edge" data-from="t3s" data-to="t2" x1="376" y1="236" x2="376" y2="266" stroke="#1E242B" stroke-width="3"/>
    <rect class="sf-edge-lbl" data-from="t3s" data-to="t2" x="346" y="242" width="60" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t3s" data-to="t2" x="376" y="254" text-anchor="middle">embeds</text>

    <!-- T3R -> T2 -->
    <line class="sf-edge" data-from="t3r" data-to="t2" x1="600" y1="236" x2="600" y2="266" stroke="#1E242B" stroke-width="3"/>
    <rect class="sf-edge-lbl" data-from="t3r" data-to="t2" x="570" y="242" width="60" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t3r" data-to="t2" x="600" y="254" text-anchor="middle">embeds</text>

    <!-- T3S -> T1 (left side) -->
    <path class="sf-edge" data-from="t3s" data-to="t1" d="M196 236 L196 344" fill="none" stroke="#1E242B" stroke-width="3"/>
    <rect class="sf-edge-lbl" data-from="t3s" data-to="t1" x="162" y="286" width="68" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t3s" data-to="t1" x="196" y="298" text-anchor="middle">validates</text>

    <!-- T3R -> T1 (right side) -->
    <path class="sf-edge" data-from="t3r" data-to="t1" d="M762 236 L762 344" fill="none" stroke="#1E242B" stroke-width="3"/>
    <rect class="sf-edge-lbl" data-from="t3r" data-to="t1" x="728" y="286" width="68" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t3r" data-to="t1" x="762" y="298" text-anchor="middle">validates</text>

    <!-- T2 -> T1 -->
    <line class="sf-edge" data-from="t2" data-to="t1" x1="488" y1="322" x2="488" y2="344" stroke="#1E242B" stroke-width="3"/>
    <rect class="sf-edge-lbl" data-from="t2" data-to="t1" x="458" y="324" width="60" height="16" fill="#F6EEDB" stroke="#1E242B" stroke-width="1.5"/>
    <text class="sf-edge-txt" data-from="t2" data-to="t1" x="488" y="336" text-anchor="middle">imports</text>
  </g>

  <!-- Tier 5: Host Shell & CLI -->
  <g class="sf-tier-node" data-tier="t5" tabindex="0" role="button" aria-label="Tier 5 Host Shell and CLI">
    <rect x="44" y="18" width="736" height="56" fill="#1E242B"/>
    <rect x="40" y="14" width="736" height="56" fill="#FFFDF7" stroke="#1E242B" stroke-width="3"/>
    <rect x="40" y="14" width="144" height="56" fill="#2563EB" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-tier-tag" x="112" y="39" text-anchor="middle">TIER 5</text>
    <text class="sf-tier-sub" x="112" y="55" text-anchor="middle">Host Shell &amp; CLI</text>
    <text class="sf-tier-pkg" x="198" y="38">@steerable/agent-shell · agent-shell-tauri · agent-shell-web · agent-cli · pack-sdk</text>
    <text class="sf-tier-desc" x="198" y="56">Tauri desktop window · Node host runtime · headless HTTP server · CLI/TUI</text>
  </g>

  <!-- Tier 4: UI -->
  <g class="sf-tier-node" data-tier="t4" tabindex="0" role="button" aria-label="Tier 4 UI">
    <rect x="44" y="106" width="342" height="52" fill="#1E242B"/>
    <rect x="40" y="102" width="342" height="52" fill="#FFFDF7" stroke="#1E242B" stroke-width="3"/>
    <rect x="40" y="102" width="102" height="52" fill="#7C3AED" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-tier-tag" x="91" y="125" text-anchor="middle">TIER 4</text>
    <text class="sf-tier-sub" x="91" y="141" text-anchor="middle">React UI</text>
    <text class="sf-tier-pkg" x="156" y="124">@steerable/agent-ui</text>
    <text class="sf-tier-desc" x="156" y="141">7 components · 14 cards · 3 hooks</text>
  </g>

  <!-- Tier 3: Sidecar -->
  <g class="sf-tier-node" data-tier="t3s" tabindex="0" role="button" aria-label="Tier 3 Sidecar">
    <rect x="176" y="182" width="290" height="56" fill="#1E242B"/>
    <rect x="172" y="178" width="290" height="56" fill="#FFFDF7" stroke="#1E242B" stroke-width="3"/>
    <rect x="172" y="178" width="84" height="56" fill="#EA7A2E" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-tier-tag" x="214" y="203" text-anchor="middle">TIER 3</text>
    <text class="sf-tier-sub" x="214" y="219" text-anchor="middle">Sidecar</text>
    <text class="sf-tier-pkg" x="268" y="202">steerable-sidecar</text>
    <text class="sf-tier-desc" x="268" y="219">Portable CPython · 38 RPC methods</text>
  </g>

  <!-- Tier 3: Runtime -->
  <g class="sf-tier-node" data-tier="t3r" tabindex="0" role="button" aria-label="Tier 3 Runtime">
    <rect x="484" y="182" width="296" height="56" fill="#1E242B"/>
    <rect x="480" y="178" width="296" height="56" fill="#FFFDF7" stroke="#1E242B" stroke-width="3"/>
    <rect x="480" y="178" width="88" height="56" fill="#0E7490" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-tier-tag" x="524" y="203" text-anchor="middle">TIER 3</text>
    <text class="sf-tier-sub" x="524" y="219" text-anchor="middle">Runtime</text>
    <text class="sf-tier-pkg" x="580" y="202">steerable-agent-runtime</text>
    <text class="sf-tier-desc" x="580" y="219">CoreLoop · 4 providers · ToolRouter</text>
  </g>

  <!-- Tier 2: Harness -->
  <g class="sf-tier-node" data-tier="t2" tabindex="0" role="button" aria-label="Tier 2 Harness">
    <rect x="244" y="270" width="490" height="54" fill="#1E242B"/>
    <rect x="240" y="266" width="490" height="54" fill="#FFFDF7" stroke="#1E242B" stroke-width="3"/>
    <rect x="240" y="266" width="100" height="54" fill="#1E8250" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-tier-tag" x="290" y="290" text-anchor="middle">TIER 2</text>
    <text class="sf-tier-sub" x="290" y="306" text-anchor="middle">Harness</text>
    <text class="sf-tier-pkg" x="354" y="289">steerable-agent-harness · @steerable/agent-harness</text>
    <text class="sf-tier-desc" x="354" y="306">Pure-function policy · budget · retry · grounding · safety</text>
  </g>

  <!-- Tier 1: Protocol (Bedrock Foundation) -->
  <g class="sf-tier-node" data-tier="t1" tabindex="0" role="button" aria-label="Tier 1 Protocol">
    <rect x="44" y="348" width="736" height="58" fill="#1E242B"/>
    <rect x="40" y="344" width="736" height="58" fill="#FFFDF7" stroke="#1E242B" stroke-width="3"/>
    <rect x="40" y="344" width="144" height="58" fill="#1E242B" stroke="#1E242B" stroke-width="3"/>
    <text class="sf-tier-tag" x="112" y="370" text-anchor="middle">TIER 1</text>
    <text class="sf-tier-sub" x="112" y="386" text-anchor="middle">Protocol</text>
    <text class="sf-tier-pkg" x="198" y="369">@steerable/agent-protocol · steerable-agent-protocol</text>
    <text class="sf-tier-desc" x="198" y="387">Single JSON Schema → generated TS/Zod + Pydantic wire types · lockstep X.Y.Z</text>
  </g>
</svg>
</div>

<p class="sf-arch-caption" id="sf-arch-caption">
Click any tier to highlight its downward dependencies — no layer ever imports above itself.
</p>
</div>

| Package | Tier | What you get |
| ------- | ---- | ------------ |
| [`@steerable/agent-protocol`](https://www.npmjs.com/package/@steerable/agent-protocol) · `steerable-agent-protocol` | 1 | `SSEEvent`, `ToolCall` / `ToolResult`, `ChatMessage`, Sidecar JSON-RPC types (codegen from `spec/`) |
| `@steerable/agent-harness` · [`steerable-agent-harness`](https://pypi.org/project/steerable-agent-harness/) | 2 | `decide_tool_mode`, `consume_budget`, `next_retry_delay_ms`, command-safety patterns |
| [`steerable-agent-runtime`](https://pypi.org/project/steerable-agent-runtime/) · [`@steerable/agent-runtime`](https://www.npmjs.com/package/@steerable/agent-runtime) | 3 | `CoreLoop`, 4-protocol `LLMProvider`, `@tool`, `ToolRouter`, SSE/stdio transports & sidecar lifecycle |
| [`steerable-sidecar`](https://pypi.org/project/steerable-sidecar/) · [`steerable-egress-proxy`](https://pypi.org/project/steerable-egress-proxy/) | 3 | Portable CPython (<1s boot, signed & notarised) plus per-host CONNECT egress allow-list proxy |
| [`@steerable/agent-ui`](https://www.npmjs.com/package/@steerable/agent-ui) | 4 | 7 core components (`ChatPanel`, `MessageList`, `ToolCallRenderer`, …) + 14 `/cards` + hooks + Tailwind preset |
| `@steerable/agent-shell` · `agent-shell-web` · `agent-shell-tauri` · `pack-sdk` | 5 | Tauri + headless host shell, shared Node HostRuntime, sidecar supervision, product-neutral renderer |
| [`@steerable/agent-cli`](https://www.npmjs.com/package/@steerable/agent-cli) · `@steerable/runtime-<target>` | 5 | CLI & TUI (`steerable-cli login`), auto-pulling the platform runtime and sharing the host DB |

<h2 class="sf-section" id="bench">How common frameworks compare</h2>

<p class="sf-lede" markdown>
Terminal-Bench 2.1 (89 tasks). <strong>79.0%</strong> is GLM-5.3-Flash @max (3-run mean); charts compare single <code>n=1</code> runs. [Methodology](evals.md)
</p>

<div class="sf-bench sf-bench--wide">

<div class="sf-bench-toolbar" role="toolbar" aria-label="Filter charts by agent harness">
<span class="sf-bench-toolbar-label">Highlight harness:</span>
<button type="button" class="sf-bench-filter is-active" data-harness="all" aria-pressed="true">All</button>
<button type="button" class="sf-bench-filter" data-harness="steer" aria-pressed="false"><i class="sf-swatch sf-swatch--steer"></i>Steerable</button>
<button type="button" class="sf-bench-filter" data-harness="pi" aria-pressed="false"><i class="sf-swatch sf-swatch--pi"></i>P*</button>
<button type="button" class="sf-bench-filter" data-harness="cc" aria-pressed="false"><i class="sf-swatch sf-swatch--cc"></i>C* C*</button>
<button type="button" class="sf-bench-filter" data-harness="codex" aria-pressed="false"><i class="sf-swatch sf-swatch--codex"></i>C*</button>
<button type="button" class="sf-bench-filter" data-harness="dsh" aria-pressed="false"><i class="sf-swatch sf-swatch--dsh"></i>D* H*</button>
</div>

<div class="sf-bench-duo">

<div class="sf-bench-group sf-bench-group--focus">
<div class="sf-bench-kicker">Pass rate · three Flash models · five harnesses</div>
<p class="sf-bench-blurb">Tasks solved out of 89. Hover any bar or filter above.</p>
<div class="sf-svg-scroll">
<svg class="sf-bars" viewBox="0 0 760 336" role="img" aria-label="Terminal-Bench 2.1 n=1 pass over 89 for three models and five harnesses: Steerable, P*, C* C*, C*, D* H*.">
<line class="axis" x1="56" y1="48" x2="56" y2="280"/>
<line class="axis" x1="56" y1="280" x2="730" y2="280"/>
<text class="tick" x="50" y="284" text-anchor="end">0</text>
<text class="tick" x="50" y="219" text-anchor="end">25</text>
<text class="tick" x="50" y="154" text-anchor="end">50</text>
<text class="tick" x="50" y="89" text-anchor="end">75</text>
<text class="tick" x="50" y="58" text-anchor="end">89</text>
<line class="grid" x1="56" y1="215" x2="730" y2="215"/>
<line class="grid" x1="56" y1="150" x2="730" y2="150"/>
<line class="grid" x1="56" y1="85" x2="730" y2="85"/>
<line class="grid" x1="56" y1="54" x2="730" y2="54"/>
<rect class="bar--steer" data-tip="Steerable · GLM @high: 79.8% (71/89)" fill="#5c6bc0" x="79" y="99.6" width="22" height="180.4"/>
<rect class="bar--pi" data-tip="P* · GLM @high: 73.0% (65/89)" fill="#0e7490" x="107" y="114.9" width="22" height="165.1"/>
<rect class="bar--cc" data-tip="C* C* · GLM @high: 77.5% (69/89)" fill="#c2410c" x="135" y="104.7" width="22" height="175.3"/>
<rect class="bar--codex" data-tip="C* · GLM @high: 56.2% (50/89)" fill="#a1a1aa" x="163" y="153.0" width="22" height="127.0"/>
<rect class="bar--dsh" data-tip="D* H* · GLM @high: 66.3% (59/89)" fill="#15803d" x="191" y="130.2" width="22" height="149.8"/>
<text class="barVal" x="90" y="95" text-anchor="middle">79.8</text>
<text class="barVal" x="118" y="110" text-anchor="middle">73.0</text>
<text class="barVal" x="146" y="100" text-anchor="middle">77.5</text>
<text class="barVal" x="174" y="149" text-anchor="middle">56.2</text>
<text class="barVal" x="202" y="125" text-anchor="middle">66.3</text>
<text class="axisTitle" x="146" y="298" text-anchor="middle">GLM @high</text>
<rect class="bar--steer" data-tip="Steerable · DS0731 @high: 78.7% (70/89)" fill="#5c6bc0" x="303" y="102.1" width="22" height="177.9"/>
<rect class="bar--pi" data-tip="P* · DS0731 @high: 69.7% (62/89)" fill="#0e7490" x="331" y="122.5" width="22" height="157.5"/>
<rect class="bar--cc" data-tip="C* C* · DS0731 @high: 44.9% (40/89)" fill="#c2410c" x="359" y="178.4" width="22" height="101.6"/>
<rect class="bar--codex" data-tip="C* · DS0731 @high: 61.8% (55/89)" fill="#a1a1aa" x="387" y="140.3" width="22" height="139.7"/>
<rect class="bar--dsh" data-tip="D* H* · DS0731 @high: 77.5% (69/89)" fill="#15803d" x="415" y="104.8" width="22" height="175.2"/>
<text class="barVal" x="314" y="98" text-anchor="middle">78.7</text>
<text class="barVal" x="342" y="118" text-anchor="middle">69.7</text>
<text class="barVal" x="370" y="174" text-anchor="middle">44.9</text>
<text class="barVal" x="398" y="136" text-anchor="middle">61.8</text>
<text class="barVal" x="426" y="100" text-anchor="middle">77.5</text>
<text class="axisTitle" x="370" y="298" text-anchor="middle">DS0731 @high</text>
<rect class="bar--steer" data-tip="Steerable · Qwen @medium: 68.5% (61/89)" fill="#5c6bc0" x="527" y="125.0" width="22" height="155.0"/>
<rect class="bar--pi" data-tip="P* · Qwen @medium: 62.9% (56/89)" fill="#0e7490" x="555" y="137.8" width="22" height="142.2"/>
<rect class="bar--cc" data-tip="C* C* · Qwen @medium: 70.8% (63/89)" fill="#c2410c" x="583" y="120.0" width="22" height="160.0"/>
<rect class="bar--codex" data-tip="C* · Qwen @medium: 64.0% (57/89)" fill="#a1a1aa" x="611" y="135.2" width="22" height="144.8"/>
<rect class="bar--dsh" data-tip="D* H* · Qwen @medium: 60.7% (54/89)" fill="#15803d" x="639" y="142.9" width="22" height="137.1"/>
<text class="barVal" x="538" y="121" text-anchor="middle">68.5</text>
<text class="barVal" x="566" y="133" text-anchor="middle">62.9</text>
<text class="barVal" x="594" y="116" text-anchor="middle">70.8</text>
<text class="barVal" x="622" y="131" text-anchor="middle">64.0</text>
<text class="barVal" x="650" y="138" text-anchor="middle">60.7</text>
<text class="axisTitle" x="594" y="298" text-anchor="middle">Qwen @medium</text>
<rect class="bar--steer" fill="#5c6bc0" x="56" y="314" width="10" height="10"/>
<text class="tick" x="70" y="323">Steerable</text>
<rect class="bar--pi" fill="#0e7490" x="148" y="314" width="10" height="10"/>
<text class="tick" x="162" y="323">P*</text>
<rect class="bar--cc" fill="#c2410c" x="198" y="314" width="10" height="10"/>
<text class="tick" x="212" y="323">C* C*</text>
<rect class="bar--codex" fill="#a1a1aa" x="276" y="314" width="10" height="10"/>
<text class="tick" x="290" y="323">C*</text>
<rect class="bar--dsh" fill="#15803d" x="332" y="314" width="10" height="10"/>
<text class="tick" x="346" y="323">D* H*</text>
</svg>
</div>
<p class="sf-bench-foot">One run per cell at high effort (Qwen: medium). <a href="evals/">Run list and commit SHAs</a></p>
</div>

<div class="sf-bench-group sf-bench-group--focus">
<div class="sf-bench-kicker">Score vs cost per solved task</div>
<p class="sf-bench-blurb">Shape is model (circle GLM, square DeepSeek, diamond Qwen). Higher and further left is better.</p>
<div class="sf-svg-scroll">
<svg class="sf-scatter" viewBox="0 0 800 428" role="img" aria-label="Terminal-Bench 2.1 n=1 score against OpenRouter list dollars per solved task for fifteen catalog-89 cells. Color is harness, shape is model.">
<line class="grid" x1="48.0" y1="32" x2="48.0" y2="332"/>
<line class="grid" x1="216.6" y1="32" x2="216.6" y2="332"/>
<line class="grid" x1="344.2" y1="32" x2="344.2" y2="332"/>
<line class="grid" x1="471.8" y1="32" x2="471.8" y2="332"/>
<line class="grid" x1="599.4" y1="32" x2="599.4" y2="332"/>
<line class="grid" x1="768.0" y1="32" x2="768.0" y2="332"/>
<line class="grid" x1="48" y1="298.7" x2="768" y2="298.7"/>
<line class="grid" x1="48" y1="232.0" x2="768" y2="232.0"/>
<line class="grid" x1="48" y1="165.3" x2="768" y2="165.3"/>
<line class="grid" x1="48" y1="98.7" x2="768" y2="98.7"/>
<line class="grid" x1="48" y1="65.3" x2="768" y2="65.3"/>
<line class="axis" x1="48" y1="32" x2="48" y2="332"/>
<line class="axis" x1="48" y1="332" x2="768" y2="332"/>
<text class="tick" x="48.0" y="348" text-anchor="middle">$0.10</text>
<text class="tick" x="216.6" y="348" text-anchor="middle">$0.25</text>
<text class="tick" x="344.2" y="348" text-anchor="middle">$0.50</text>
<text class="tick" x="471.8" y="348" text-anchor="middle">$1</text>
<text class="tick" x="599.4" y="348" text-anchor="middle">$2</text>
<text class="tick" x="768.0" y="348" text-anchor="middle">$5</text>
<text class="tick" x="42" y="302.7" text-anchor="end">45</text>
<text class="tick" x="42" y="236.0" text-anchor="end">55</text>
<text class="tick" x="42" y="169.3" text-anchor="end">65</text>
<text class="tick" x="42" y="102.7" text-anchor="end">75</text>
<text class="tick" x="42" y="69.3" text-anchor="end">80</text>
<text class="axisTitle" x="408" y="372" text-anchor="middle">$ per solved task (log) · OpenRouter list on pinned host</text>
<text class="axisTitle" x="14" y="182" text-anchor="middle" transform="rotate(-90 14 182)">TB 2.1 score (n=1 pass / 89)</text>
<circle class="pt pt--pi" data-tip="P* · GLM @high: 73.0% · $0.12 / solved task" fill="#0e7490" stroke="#0e7490" cx="86.1" cy="112.0" r="11"/>
<text class="lbl" data-harness="pi" x="100" y="108">P* · GLM</text>
<text class="sub" data-harness="pi" x="100" y="118">73.0% · $0.12</text>
<circle class="pt pt--cc" data-tip="C* C* · GLM @high: 77.5% · $0.23 / solved task" fill="#c2410c" stroke="#c2410c" cx="198.1" cy="82.0" r="11"/>
<text class="lbl" data-harness="cc" x="212" y="78">C* C* · GLM</text>
<text class="sub" data-harness="cc" x="212" y="88">77.5% · $0.23</text>
<rect class="pt pt--pi" data-tip="P* · DS0731 @high: 69.7% · $0.28 / solved task" fill="#0e7490" stroke="#0e7490" x="223.2" y="123.0" width="22" height="22"/>
<text class="lbl" data-harness="pi" x="250" y="130">P* · DS</text>
<text class="sub" data-harness="pi" x="250" y="140">69.7% · $0.28</text>
<circle class="pt pt--ours" data-tip="Steerable · GLM @high: 79.8% · $0.61 / solved task" fill="#5c6bc0" stroke="#5c6bc0" cx="381.4" cy="66.7" r="14"/>
<text class="lbl lbl--ours" data-harness="steer" x="398" y="81">Steerable · GLM</text>
<text class="sub" data-harness="steer" x="398" y="91">79.8% · $0.61</text>
<rect class="pt pt--cc" data-tip="C* C* · DS0731 @high: 44.9% · $0.85 / solved task" fill="#c2410c" stroke="#c2410c" x="430.0" y="288.3" width="22" height="22"/>
<text class="lbl" data-harness="cc" x="456" y="286">C* C* · DS</text>
<text class="sub" data-harness="cc" x="456" y="296">44.9% · $0.85</text>
<circle class="pt pt--codex" data-tip="C* · GLM @high: 56.2% · $1.06 / solved task" fill="#71717a" stroke="#71717a" cx="481.6" cy="224.0" r="11"/>
<text class="lbl" data-harness="codex" x="496" y="220">C* · GLM</text>
<text class="sub" data-harness="codex" x="496" y="230">56.2% · $1.06</text>
<polygon class="pt pt--cc" data-tip="C* C* · Qwen @medium: 70.8% · $1.68 / solved task" fill="#c2410c" stroke="#c2410c" points="567.3,110.7 583.3,126.7 567.3,142.7 551.3,126.7"/>
<text class="lbl" data-harness="cc" x="548" y="116" text-anchor="end">C* C* · Qwen</text>
<text class="sub" data-harness="cc" x="548" y="126" text-anchor="end">70.8% · $1.68</text>
<rect class="pt pt--ours" data-tip="Steerable · DS0731 @high: 78.7% · $2.18 / solved task" fill="#5c6bc0" stroke="#5c6bc0" x="602.3" y="61.0" width="26" height="26"/>
<text class="lbl lbl--ours" data-harness="steer" x="598" y="58" text-anchor="end">Steerable · DS</text>
<text class="sub" data-harness="steer" x="598" y="72" text-anchor="end">78.7% · $2.18</text>
<polygon class="pt pt--codex" data-tip="C* · Qwen @medium: 64.0% · $2.60 / solved task" fill="#71717a" stroke="#71717a" points="647.6,156.0 663.6,172.0 647.6,188.0 631.6,172.0"/>
<text class="lbl" data-harness="codex" x="628" y="198" text-anchor="end">C* · Qwen</text>
<text class="sub" data-harness="codex" x="628" y="208" text-anchor="end">64.0% · $2.60</text>
<polygon class="pt pt--pi" data-tip="P* · Qwen @medium: 62.9% · $2.87 / solved task" fill="#0e7490" stroke="#0e7490" points="666.2,163.3 682.2,179.3 666.2,195.3 650.2,179.3"/>
<text class="lbl" data-harness="pi" x="638" y="152" text-anchor="end">P* · Qwen</text>
<text class="sub" data-harness="pi" x="638" y="162" text-anchor="end">62.9% · $2.87</text>
<polygon class="pt pt--ours" data-tip="Steerable · Qwen @medium: 68.5% · $4.12 / solved task" fill="#5c6bc0" stroke="#5c6bc0" points="732.1,124.0 750.1,142.0 732.1,160.0 714.1,142.0"/>
<text class="lbl lbl--ours" data-harness="steer" x="710" y="128" text-anchor="end">Steerable · Qwen</text>
<text class="sub" data-harness="steer" x="710" y="138" text-anchor="end">68.5% · $4.12</text>
<rect class="pt pt--codex" data-tip="C* · DS0731 @high: 61.8% · $4.42 / solved task" fill="#71717a" stroke="#71717a" x="732.3" y="173.7" width="26" height="26"/>
<text class="lbl" data-harness="codex" x="728" y="218" text-anchor="end">C* · DS</text>
<text class="sub" data-harness="codex" x="728" y="228" text-anchor="end">61.8% · $4.42</text>
<circle class="pt pt--dsh" data-tip="D* H* · GLM @high: 66.3% · $0.12 / solved task" fill="#15803d" stroke="#15803d" cx="88.5" cy="156.7" r="11"/>
<text class="lbl" data-harness="dsh" x="104" y="152">D* H* · GLM</text>
<text class="sub" data-harness="dsh" x="104" y="162">66.3% · $0.12</text>
<rect class="pt pt--dsh" data-tip="D* H* · DS0731 @high: 77.5% · $3.48 / solved task" fill="#15803d" stroke="#15803d" x="690.3" y="71.0" width="22" height="22"/>
<text class="lbl" data-harness="dsh" x="686" y="100" text-anchor="end">D* H* · DS</text>
<text class="sub" data-harness="dsh" x="686" y="110" text-anchor="end">77.5% · $3.48</text>
<polygon class="pt pt--dsh" data-tip="D* H* · Qwen @medium: 60.7% · $3.36 / solved task" fill="#15803d" stroke="#15803d" points="694.8,183.0 705.8,194.0 694.8,205.0 683.8,194.0"/>
<text class="lbl" data-harness="dsh" x="694" y="248" text-anchor="middle">D* H* · Qwen</text>
<text class="sub" data-harness="dsh" x="694" y="258" text-anchor="middle">60.7% · $3.36</text>
<rect class="pt pt--steer" fill="#5c6bc0" stroke="#5c6bc0" x="48" y="388" width="14" height="14"/>
<text class="legend" x="66" y="399">Steerable</text>
<rect class="pt pt--pi" fill="#0e7490" stroke="#0e7490" x="150" y="388" width="14" height="14"/>
<text class="legend" x="168" y="399">P*</text>
<rect class="pt pt--cc" fill="#c2410c" stroke="#c2410c" x="200" y="388" width="14" height="14"/>
<text class="legend" x="218" y="399">C* C*</text>
<rect class="pt pt--codex" fill="#71717a" stroke="#71717a" x="280" y="388" width="14" height="14"/>
<text class="legend" x="298" y="399">C*</text>
<rect class="pt pt--dsh" fill="#15803d" stroke="#15803d" x="342" y="388" width="14" height="14"/>
<text class="legend" x="360" y="399">D* H*</text>
<text class="legend" x="424" y="399">circle GLM · square DeepSeek · diamond Qwen</text>
</svg>
</div>
<p class="sf-bench-foot">OpenRouter list prices on the pinned host. <a href="evals/">Pricing formula</a></p>
</div>

</div>

</div>

<p class="sf-lede" markdown>
GLM-5.3-Flash @high (<code>n=1</code>): **Steerable 79.8%** · C&#42; C&#42; 77.5% · P&#42; 73.0% · D&#42; H&#42; 66.3% · C&#42; 56.2%.
</p>

<p class="sf-lede" markdown>
Beyond pass rates — how Steerable compares on runtime form, loop events, sandbox, and model recovery:
</p>

<div class="sf-compare-wrap" markdown>

| Dimension | Steerable | OpenAI Codex | DeepSeek Harness | LangGraph | OpenAI Agents SDK | Claude Code / Agent SDK |
| --------- | --------- | ------------ | ---------------- | --------- | ----------------- | ----------------------- |
| **What you get** | **5 modular tiers**: signed desktop sidecar + FastAPI server + 14-card React UI over one wire protocol | Closed product family (CLI / IDE / cloud), not an embeddable UI/SDK stack | Plugin-based TS harness (Cordis) for CLI/Web; no standalone desktop sidecar | State-graph orchestration only; no built-in UI, sandbox, or desktop runtime | Server-side orchestration only; no desktop sidecar or React UI kit | Closed-source CLI + SDK bundle; cannot adopt individual layers |
| **Cheap & local models** | **Built-in recovery**: parses malformed text tool calls + grounding judge + completion veto (**79.0%** on Flash) | Assumes structured `tool_calls` | Assumes structured `tool_calls` | No built-in recovery — you own the loop and checks | Built for frontier models | Built for frontier Claude models |
| **Model lock-in** | **Zero lock-in**: OpenAI-compat (Ollama/vLLM), Responses, Anthropic, Gemini natively | Centered on Responses wire & OpenAI | Multi-model (focused on DeepSeek / standard wires) | Multi-model via your own SDK calls | Tied to OpenAI (other providers via LiteLLM) | **Anthropic models only** (via 8 backends) |
| **Default sandbox & egress** | **Fail-closed by default**: Seatbelt / bwrap / Windows + 61 rules + per-host CONNECT allow-list | Platform sandbox + approvals + managed proxy | `sandbox.confine` (fail-closed) | **None built-in** (bring Docker / cloud sandbox) | Docker or hosted Sandbox Agents (no local Linux confinement) | CLI defaults **fail-open** (missing backend warns and proceeds) |
| **TS + Python contract** | **Single JSON Schema codegen** → TS/Zod + Pydantic, 15 lockstep packages + golden conformance tests | Generates TS types; separate SDK implementations | TS-first; Python SDK bridges via CLI/RPC | Separate Py / JS libraries; no shared schema codegen | Separate Py / TS libraries; no cross-language codegen | Publishes TS declarations only (`sdk-tools.d.ts`) |
| **Trade-off** | Native `CoreLoop` engine is closed-binary; early ecosystem (`0.12.x`) | Huge real-world mileage, but monolithic product stack | Open-source, still public prerelease (`0.2.x`) | Mature ecosystem, but loop guards & UI are DIY | Quick to start, lacks desktop & cross-tier plumbing | Feature-rich, but closed-source and Anthropic-only |

</div>

<p class="sf-lede" markdown>
Trade-offs and when to pick which: [Full comparison](comparison.md).
</p>

<h2 class="sf-section" id="users">Who's using it</h2>

<p class="sf-lede" markdown>
Production desktop shells and enterprise deployments.
</p>

<div class="sf-brand-grid">
  <div class="sf-brand-group">
    <div class="sf-brand-group-title">Enterprise & Products</div>
    <div class="sf-brand-items">
      <a href="https://deeppath.cc" target="_blank" rel="noopener noreferrer" class="sf-brand-item">
        <img src="assets/users/deeppath.png" alt="DeepPath">
        <span class="sf-brand-name">DeepPath</span>
        <span class="sf-brand-domain">deeppath.cc</span>
      </a>
      <a href="https://steeragent.app" target="_blank" rel="noopener noreferrer" class="sf-brand-item">
        <img src="assets/users/steer.png" alt="Steer">
        <span class="sf-brand-name">Steer</span>
        <span class="sf-brand-domain">steeragent.app</span>
      </a>
      <a href="https://dpkgs.cn" target="_blank" rel="noopener noreferrer" class="sf-brand-item">
        <img src="assets/users/dpkgs.png" alt="DPKGS">
        <span class="sf-brand-name">DPKGS</span>
        <span class="sf-brand-domain">dpkgs.cn</span>
      </a>
      <a href="https://idevault.com" target="_blank" rel="noopener noreferrer" class="sf-brand-item">
        <img src="assets/users/idevault.png" alt="IDEVault">
        <span class="sf-brand-name">IDEVault</span>
        <span class="sf-brand-domain">idevault.com</span>
      </a>
      <div class="sf-brand-item">
        <img src="assets/users/petrochina.svg" alt="PetroChina">
        <span>PetroChina</span>
      </div>
      <div class="sf-brand-item">
        <img src="assets/users/etown-mark.png" alt="E-Town Holdings">
        <span>E-Town Holdings</span>
      </div>
    </div>
  </div>
</div>

<h2 class="sf-section" id="explore">Explore</h2>

<div class="sf-explore-grid" markdown>
<div class="sf-explore-group" markdown>
<div class="sf-explore-title">Guides</div>
<div class="sf-links" markdown>
[Full walkthrough](getting-started.md){ .md-button }
[Comparison](comparison.md){ .md-button }
[Evals](evals.md){ .md-button }
</div>
</div>
<div class="sf-explore-group" markdown>
<div class="sf-explore-title">Protocol & Core Specs</div>
<div class="sf-links" markdown>
[Wire spec](spec/overview.md){ .md-button }
[Architecture](spec/architecture.md){ .md-button }
[Events](spec/events.md){ .md-button }
[Tools](spec/tools.md){ .md-button }
[Chat](spec/chat.md){ .md-button }
</div>
</div>
<div class="sf-explore-group" markdown>
<div class="sf-explore-title">Runtime & UI</div>
<div class="sf-links" markdown>
[Safety](spec/safety.md){ .md-button }
[Runtime](spec/runtime.md){ .md-button }
[Sidecar](spec/sidecar.md){ .md-button }
[ACP (editor embed)](spec/acp.md){ .md-button }
[UI components](ui/index.md){ .md-button }
</div>
</div>
</div>

<div class="sf-closing" markdown>
<div class="sf-closing-copy">
<strong>Try Steerable</strong>
<span>Launch the keyless browser demo or read the architecture guide.</span>
</div>
<div class="sf-closing-actions" markdown>
<a href="demo/" class="md-button md-button--primary">Launch live demo</a>
[Full walkthrough](getting-started.md){ .md-button }
</div>
</div>
