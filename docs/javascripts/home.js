/* Interactive enhancements for the Steerable landing page (docs/index.md).
   Scoped to .sf-hero / .sf-run-term / .sf-bench / .sf-subnav so other docs
   pages are unaffected. Re-initializes cleanly across Material instant nav. */
(function () {
  function getPageLang() {
    var hero = document.querySelector(".sf-hero");
    var attr = hero && hero.getAttribute("data-lang");
    if (attr && (attr === "zh" || attr === "ja" || attr === "en")) return attr;
    if (/\/zh(\/|$)/.test(location.pathname)) return "zh";
    if (/\/ja(\/|$)/.test(location.pathname)) return "ja";
    return "en";
  }

  var I18N = {
    en: {
      copy: "Copy",
      copied: "Copied",
      loop: {
        all: "Click any block above: one Rust CoreLoop engine emits structured LoopEvent frames to both the desktop sidecar (stdio JSON-RPC) and the in-process FastAPI server (SSE).",
        core: "CoreLoop (Rust engine behind a Python facade): executes step loops, malformed tool-call recovery, grounding checks, completion vetoes, and mid-turn steering across 15 frozen LoopEvent kinds.",
        desktop: "Desktop & Terminal: steerable-sidecar bundles portable CPython + CoreLoop with 38 JSON-RPC methods over stdio, driving Tauri windows (@steerable/agent-shell-tauri) and the CLI/TUI.",
        server: "Server: steerable-agent-runtime runs the exact same CoreLoop in-process behind FastAPI SSE and 4 LLM wire protocols (OpenAI-compat, Responses, Anthropic, Gemini)."
      },
      arch: {
        all: "Click any tier above to highlight its exact downward dependencies — no layer ever imports above itself.",
        t5: "Tier 5 (Host Shell & CLI): renders with Tier 4 UI and supervises Tier 3 Sidecar; inherits Tier 1–4 without touching Tier 3 Python server adapters.",
        t4: "Tier 4 (React UI): shares Tier 1 wire types and optionally bridges to Tier 3 Sidecar — skip the sidecar if you bring your own SSE endpoint.",
        t3s: "Tier 3 (Sidecar): embeds Tier 2 Harness and validates Tier 1 Protocol into a portable CPython binary; never pulls in Tier 4 UI or Tier 5 Shell.",
        t3r: "Tier 3 (Python Runtime): embeds Tier 2 Harness and validates Tier 1 Protocol for FastAPI/server hosts — zero React or desktop shell dependencies.",
        t2: "Tier 2 (Harness): pure-function policy, budget, retry, grounding, and safety over Tier 1 Protocol types — zero I/O coupling.",
        t1: "Tier 1 (Protocol): zero-dependency TypeScript/Zod and Pydantic wire types generated from JSON Schema — adoptable completely standalone."
      }
    },
    zh: {
      copy: "复制",
      copied: "已复制",
      loop: {
        all: "点击上方任意模块：同一套 Rust CoreLoop 引擎通过结构化 LoopEvent 协议，同时驱动桌面端 Sidecar（stdio JSON-RPC）与服务端 FastAPI（SSE）。",
        core: "CoreLoop（Python 门面背后的 Rust 引擎）：在 15 种冻结的 LoopEvent 事件之上执行步进循环、畸形工具调用恢复、事实核查、完成否决与回合中实时纠偏。",
        desktop: "桌面与终端：steerable-sidecar 将便携式 CPython 与 CoreLoop 打包在一起，通过 stdio 暴露 38 个 JSON-RPC 方法，驱动 Tauri 桌面窗（@steerable/agent-shell-tauri）与 CLI/TUI。",
        server: "服务端：steerable-agent-runtime 在进程内运行完全一致的 CoreLoop，对接 FastAPI SSE 与 4 种大模型协议（OpenAI 兼容、Responses、Anthropic、Gemini）。"
      },
      arch: {
        all: "点击上方任意层级，高亮查看它的向下传递依赖——低层永不反向引入高层。",
        t5: "Tier 5（宿主壳与 CLI）：使用 Tier 4 UI 渲染并托管 Tier 3 Sidecar；只依赖 Tier 1–4，无需引入服务端专用适配器。",
        t4: "Tier 4（React UI）：共享 Tier 1 协议类型，并可选通过宿主机桥接 Tier 3 Sidecar——如果已有自己的 SSE 后端，可完全跳过 Sidecar。",
        t3s: "Tier 3（Sidecar）：内嵌 Tier 2 Harness 并按 Tier 1 Protocol 校验，打包为独立可移植的 CPython 可执行程序，不包含任何 UI 或桌面壳依赖。",
        t3r: "Tier 3（Python Runtime）：面向 FastAPI/服务端宿主，内嵌 Tier 2 Harness 与 Tier 1 Protocol，零 React 与桌面端依赖。",
        t2: "Tier 2（Harness）：基于 Tier 1 协议类型的纯函数策略、预算、重试、事实核查与安全规则，零 I/O 耦合。",
        t1: "Tier 1（Protocol）：由 JSON Schema 生成、零外部依赖的 TypeScript/Zod 与 Pydantic 通信类型，可完全独立采用。"
      }
    },
    ja: {
      copy: "コピー",
      copied: "コピー済み",
      loop: {
        all: "上の各ブロックをクリック：単一の Rust CoreLoop エンジンが構造化された LoopEvent を生成し、デスクトップ Sidecar（stdio JSON-RPC）と FastAPI サーバー（SSE）の両方を駆動します。",
        core: "CoreLoop（Python ファサード配下の Rust エンジン）：15 種の固定 LoopEvent に基づき、ステップループ、不正ツール呼び出し修復、グラウンディング検証、完了拒否、ターン中ステアリングを実行します。",
        desktop: "デスクトップ & ターミナル：steerable-sidecar は可搬 CPython と CoreLoop を同梱し、stdio 経由の 38 個の JSON-RPC メソッドで Tauri（@steerable/agent-shell-tauri）や CLI/TUI を駆動します。",
        server: "サーバー：steerable-agent-runtime は同一の CoreLoop をプロセス内で実行し、FastAPI SSE と 4 種の LLM プロトコル（OpenAI 互換・Responses・Anthropic・Gemini）に接続します。"
      },
      arch: {
        all: "上の各レイヤーをクリックすると、下位方向のみの依存関係をハイライトします。上位レイヤーへの逆依存は一切ありません。",
        t5: "Tier 5（ホストシェル & CLI）：Tier 4 UI で描画し Tier 3 Sidecar を管理します。Tier 1–4 のみを継承し、サーバー専用アダプターは含みません。",
        t4: "Tier 4（React UI）：Tier 1 ワイヤー型を共有し、必要に応じてホストブリッジ経由で Tier 3 Sidecar に接続します（独自 SSE がある場合は Sidecar 不要）。",
        t3s: "Tier 3（Sidecar）：Tier 2 Harness を組み込み Tier 1 Protocol で検証した可搬 CPython バイナリ。UI やシェルには一切依存しません。",
        t3r: "Tier 3（Python Runtime）：FastAPI などのサーバー向け。Tier 2 Harness と Tier 1 Protocol のみに依存し、React やデスクトップ殻を持ち込みません。",
        t2: "Tier 2（Harness）：Tier 1 型に基づく純粋関数群（ポリシー・予算・リトライ・グラウンディング・安全性）。I/O 結合ゼロです。",
        t1: "Tier 1（Protocol）：JSON Schema から生成される依存ゼロの TypeScript/Zod および Pydantic 型定義。単体で導入可能です。"
      }
    }
  };

  var HARNESS_META = {
    steer: { label: "Steerable", color: "#5c6bc0" },
    pi: { label: "P*", color: "#0e7490" },
    cc: { label: "C* C*", color: "#c2410c" },
    codex: { label: "C*", color: "#71717a" },
    dsh: { label: "D* H*", color: "#15803d" }
  };

  function initRunTerminal() {
    var term = document.querySelector(".sf-run-term");
    if (!term || term.dataset.sfInit === "1") return;
    term.dataset.sfInit = "1";

    var radios = Array.from(term.querySelectorAll(".sf-run-radio"));
    var labels = Array.from(term.querySelectorAll(".sf-run-bar label"));
    var copyBtn = term.querySelector(".sf-run-copy");

    function syncTabs() {
      radios.forEach(function (radio, idx) {
        var lbl = labels[idx];
        if (!lbl) return;
        lbl.setAttribute("aria-selected", radio.checked ? "true" : "false");
        lbl.setAttribute("tabindex", radio.checked ? "0" : "-1");
      });
    }

    radios.forEach(function (radio) {
      radio.addEventListener("change", syncTabs);
    });

    labels.forEach(function (lbl, idx) {
      lbl.addEventListener("keydown", function (e) {
        var next = -1;
        if (e.key === "ArrowRight") next = (idx + 1) % labels.length;
        else if (e.key === "ArrowLeft") next = (idx - 1 + labels.length) % labels.length;
        if (next === -1) return;
        e.preventDefault();
        if (radios[next]) {
          radios[next].checked = true;
          syncTabs();
          labels[next].focus();
        }
      });
    });

    if (copyBtn) {
      var resetTimer = null;
      copyBtn.addEventListener("click", function () {
        var activeIdx = radios.findIndex(function (r) { return r.checked; });
        var panes = term.querySelectorAll(".sf-run-pane");
        var pane = panes[activeIdx >= 0 ? activeIdx : 0];
        if (!pane) return;
        var cmds = Array.from(pane.querySelectorAll(".sf-cmd"))
          .map(function (el) { return el.textContent.trim(); })
          .filter(function (line) { return line && !line.startsWith("#"); })
          .join("\n");
        if (!cmds) return;

        var done = function () {
          var copyLabels = I18N[getPageLang()] || I18N.en;
          copyBtn.dataset.copied = "true";
          var textEl = copyBtn.querySelector(".sf-run-copy-text");
          if (textEl) textEl.textContent = copyLabels.copied;
          clearTimeout(resetTimer);
          resetTimer = setTimeout(function () {
            delete copyBtn.dataset.copied;
            if (textEl) textEl.textContent = copyLabels.copy;
          }, 1600);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(cmds).then(done, function () {});
        } else {
          var ta = document.createElement("textarea");
          ta.value = cmds;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (_err) {}
          document.body.removeChild(ta);
        }
      });
    }

    syncTabs();
  }

  function initBenchmarkInteractions() {
    var bench = document.querySelector(".sf-bench");
    if (!bench || bench.dataset.sfInit === "1") return;
    bench.dataset.sfInit = "1";

    var filterBtns = Array.from(bench.querySelectorAll(".sf-bench-filter[data-harness]"));
    var activeHarness = "all";

    function applyFilter(harness) {
      activeHarness = harness;
      bench.dataset.filter = harness;
      filterBtns.forEach(function (btn) {
        var selected = btn.dataset.harness === harness;
        btn.classList.toggle("is-active", selected);
        btn.setAttribute("aria-pressed", selected ? "true" : "false");
      });

      var bars = bench.querySelectorAll(".sf-bars rect[class*='bar--'], .sf-scatter .pt[class*='pt--']");
      bars.forEach(function (el) {
        if (harness === "all") {
          el.classList.remove("is-dimmed", "is-highlighted");
          return;
        }
        var isMatch =
          el.classList.contains("bar--" + harness) ||
          el.classList.contains("pt--" + harness) ||
          (harness === "steer" && el.classList.contains("pt--ours"));
        el.classList.toggle("is-dimmed", !isMatch);
        el.classList.toggle("is-highlighted", isMatch);
      });

      var scatterTexts = bench.querySelectorAll(".sf-scatter text.lbl, .sf-scatter text.sub");
      scatterTexts.forEach(function (t) {
        if (harness === "all") {
          t.classList.remove("is-dimmed");
          return;
        }
        var target = HARNESS_META[harness];
        var belongs = target && t.dataset.harness === harness;
        t.classList.toggle("is-dimmed", !belongs);
      });

      var barOrder = ["steer", "pi", "cc", "codex", "dsh"];
      var barVals = bench.querySelectorAll(".sf-bars text.barVal");
      barVals.forEach(function (t, idx) {
        if (harness === "all") {
          t.classList.remove("is-dimmed");
          return;
        }
        t.classList.toggle("is-dimmed", barOrder[idx % 5] !== harness);
      });
    }

    // Tag scatter labels & points with harness + interactive tooltip data
    var scatterSvg = bench.querySelector(".sf-scatter");
    if (scatterSvg) {
      var pts = Array.from(scatterSvg.querySelectorAll(".pt[data-tip]"));
      pts.forEach(function (pt) {
        pt.setAttribute("tabindex", "0");
      });
    }

    var barSvg = bench.querySelector(".sf-bars");
    if (barSvg) {
      var barRects = Array.from(barSvg.querySelectorAll("rect[data-tip]"));
      barRects.forEach(function (rect) {
        rect.setAttribute("tabindex", "0");
      });
    }

    filterBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.dataset.harness || "all";
        applyFilter(target !== "all" && activeHarness === target ? "all" : target);
      });
    });

    // Shared floating tooltip for both benchmark charts (reused across instant nav)
    var tip = document.querySelector(".sf-chart-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "sf-chart-tip";
      tip.setAttribute("role", "status");
      tip.hidden = true;
      document.body.appendChild(tip);
    } else {
      tip.hidden = true;
    }

    function showTip(el, clientX, clientY) {
      var text = el.getAttribute("data-tip");
      if (!text) return;
      tip.textContent = text;
      tip.hidden = false;
      var pad = 12;
      var rect = tip.getBoundingClientRect();
      var left = Math.min(window.innerWidth - rect.width - pad, Math.max(pad, clientX + 12));
      var top = Math.max(pad, clientY - rect.height - 12);
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }

    function hideTip() {
      tip.hidden = true;
    }

    bench.addEventListener("pointermove", function (e) {
      var target = e.target.closest("[data-tip]");
      if (!target) {
        hideTip();
        return;
      }
      showTip(target, e.clientX, e.clientY);
    });

    bench.addEventListener("pointerleave", hideTip);

    bench.addEventListener("focusin", function (e) {
      var target = e.target.closest("[data-tip]");
      if (!target) return;
      var r = target.getBoundingClientRect();
      showTip(target, r.left + r.width / 2, r.top);
    });

    bench.addEventListener("focusout", hideTip);
  }

  function initSubnav() {
    var subnav = document.querySelector(".sf-subnav");
    if (!subnav || subnav.dataset.sfInit === "1") return;
    subnav.dataset.sfInit = "1";

    var links = Array.from(subnav.querySelectorAll("a[href^='#']"));
    var targets = links
      .map(function (a) {
        var id = a.getAttribute("href").slice(1);
        var el = document.getElementById(id);
        return el ? { link: a, el: el, id: id } : null;
      })
      .filter(Boolean);

    if (!targets.length || typeof IntersectionObserver === "undefined") return;

    function setActive(id) {
      links.forEach(function (a) {
        var active = a.getAttribute("href") === "#" + id;
        a.classList.toggle("is-active", active);
        if (active && a.scrollIntoView) {
          a.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      });
    }

    var visible = new Set();
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        });
        for (var i = 0; i < targets.length; i++) {
          if (visible.has(targets[i].id)) {
            setActive(targets[i].id);
            break;
          }
        }
      },
      { rootMargin: "-90px 0px -60% 0px", threshold: 0 }
    );

    targets.forEach(function (item) { observer.observe(item.el); });
  }

  function initLoopStage() {
    var stage = document.querySelector(".sf-loop-stage");
    if (!stage || stage.dataset.sfInit === "1") return;
    stage.dataset.sfInit = "1";

    var captionEl = document.getElementById("sf-loop-caption");
    var btns = Array.from(stage.querySelectorAll(".sf-loop-btn[data-target]"));
    var nodes = Array.from(stage.querySelectorAll(".sf-loop-node[data-node]"));
    var captions = (I18N[getPageLang()] || I18N.en).loop;

    function selectTarget(target) {
      stage.dataset.focus = target;
      btns.forEach(function (b) {
        var active = b.dataset.target === target;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });
      if (captionEl && captions[target]) {
        captionEl.textContent = captions[target];
      }
    }

    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectTarget(btn.dataset.target || "all");
      });
    });

    nodes.forEach(function (node) {
      node.addEventListener("click", function () {
        var next = node.dataset.node || "all";
        selectTarget(stage.dataset.focus === next ? "all" : next);
      });
      node.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          var next = node.dataset.node || "all";
          selectTarget(stage.dataset.focus === next ? "all" : next);
        }
      });
    });
  }

  function initArchStage() {
    var stage = document.querySelector(".sf-arch-stage");
    if (!stage || stage.dataset.sfInit === "1") return;
    stage.dataset.sfInit = "1";

    var captionEl = document.getElementById("sf-arch-caption");
    var btns = Array.from(stage.querySelectorAll(".sf-arch-btn[data-tier]"));
    var nodes = Array.from(stage.querySelectorAll(".sf-tier-node[data-tier]"));
    var edges = Array.from(stage.querySelectorAll(".sf-edge, .sf-edge-lbl, .sf-edge-txt"));

    var deps = {
      t5: ["t5", "t4", "t3s", "t2", "t1"],
      t4: ["t4", "t3s", "t2", "t1"],
      t3s: ["t3s", "t2", "t1"],
      t3r: ["t3r", "t2", "t1"],
      t2: ["t2", "t1"],
      t1: ["t1"]
    };

    var captions = (I18N[getPageLang()] || I18N.en).arch;

    function applyTier(tier) {
      stage.dataset.focus = tier;
      btns.forEach(function (b) {
        var active = b.dataset.tier === tier;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });

      var keep = tier === "all" ? null : deps[tier] || [tier];
      nodes.forEach(function (n) {
        var t = n.getAttribute("data-tier");
        n.classList.toggle("is-dimmed", !!(keep && keep.indexOf(t) === -1));
      });
      edges.forEach(function (e) {
        if (!keep) {
          e.classList.remove("is-dimmed");
          return;
        }
        var from = e.getAttribute("data-from");
        var to = e.getAttribute("data-to");
        var active = keep.indexOf(from) !== -1 && keep.indexOf(to) !== -1;
        e.classList.toggle("is-dimmed", !active);
      });

      if (captionEl && captions[tier]) {
        captionEl.textContent = captions[tier];
      }
    }

    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.dataset.tier || "all";
        applyTier(target !== "all" && stage.dataset.focus === target ? "all" : target);
      });
    });

    nodes.forEach(function (node) {
      node.addEventListener("click", function () {
        var target = node.getAttribute("data-tier") || "all";
        applyTier(stage.dataset.focus === target ? "all" : target);
      });
      node.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          var target = node.getAttribute("data-tier") || "all";
          applyTier(stage.dataset.focus === target ? "all" : target);
        }
      });
    });
  }

  function initLanguagePreference() {
    if (window.__sfLangBound) return;
    window.__sfLangBound = true;
    document.addEventListener("click", function (e) {
      var link = e.target.closest(".sf-lang-bar a[hreflang], .md-select__link[hreflang]");
      if (!link) return;
      var langAttr = (link.getAttribute("hreflang") || "").toLowerCase();
      var code = langAttr.indexOf("zh") === 0 ? "zh" : langAttr.indexOf("ja") === 0 ? "ja" : "en";
      try { localStorage.setItem("sf_lang", code); } catch (_err) {}
    });
  }

  function boot() {
    initLanguagePreference();
    if (!document.querySelector(".sf-hero")) return;
    initRunTerminal();
    initBenchmarkInteractions();
    initLoopStage();
    initArchStage();
    initSubnav();
  }

  if (typeof window.document$ !== "undefined" && window.document$.subscribe) {
    window.document$.subscribe(boot);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
