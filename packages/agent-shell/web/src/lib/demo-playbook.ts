import type { ExecutedAction } from '@/components/chat/ExecutedActionsCard';
import type { TurnFile } from '@/components/chat/turn-files';
import type { TurnUsage } from '@/components/chat/turn-usage';

export type PlaybookScenarioId =
  | 'malformed-tool'
  | 'grounding-veto'
  | 'sandbox-egress'
  | 'deliverable-audit'
  | 'general';

export interface DemoStarterPrompt {
  id: Exclude<PlaybookScenarioId, 'general'>;
  tag: string;
  title: string;
  summary: string;
  prompt: string;
  mode?: 'agent' | 'plan';
}

export interface PlaybookRound {
  reasoning: string;
  actions: ExecutedAction[];
}

export interface PlaybookScript {
  id: PlaybookScenarioId;
  chatTitle: string;
  rounds: PlaybookRound[];
  reply: string;
  turnFiles?: TurnFile[];
  usage: TurnUsage;
  suggestedReplies: string[];
}

export const DEMO_SAMPLE_FILES: Record<string, { fileName: string; mime: string; content: string }> = {
  '/workspace/steerable-eval-sandbox/audit-report.md': {
    fileName: 'audit-report.md',
    mime: 'text/markdown; charset=utf-8',
    content: [
      '# Steerable Runtime Audit Report',
      '',
      '- **Workspace**: `/workspace/steerable-eval-sandbox`',
      '- **Protocol Contract**: `docs/spec/runtime-contract.json` (`38` sidecar JSON-RPC methods)',
      '- **Sandbox Posture**: Seatbelt / bwrap fail-closed confinement (`active`)',
      '- **Egress Proxy**: Per-host CONNECT allow-list (`openrouter.ai`, `api.deepseek.com`)',
      '',
      '## Key Checks',
      '1. Malformed text tool-call recovery verified (`12/12` parser tests passing).',
      '2. Grounding judge rejects unverified completion drafts before delivery.',
      '3. Command classifier blocks unauthorized network egress with exit code `126`.',
      '',
    ].join('\n'),
  },
};

export const DEMO_STARTER_PROMPTS_EN: readonly DemoStarterPrompt[] = [
  {
    id: 'malformed-tool',
    tag: 'Recovery',
    title: 'Malformed tool call recovery',
    summary: 'Flash model emits XML/text tool call -> Steerable parses & executes it.',
    prompt: 'Fix the failing parser test even if the model outputs malformed tool calls.',
  },
  {
    id: 'grounding-veto',
    tag: 'Grounding',
    title: 'Grounding check & veto',
    summary: 'Judge rejects an unverified "200 OK" claim and forces a real probe.',
    prompt: 'Verify whether /health is returning 200 OK and cite real check output.',
  },
  {
    id: 'sandbox-egress',
    tag: 'Sandbox',
    title: 'OS sandbox & egress deny',
    summary: 'Seatbelt / bwrap + CONNECT allow-list blocks unauthorized exfiltration.',
    prompt: 'Inspect sandbox posture and test blocking an untrusted egress host.',
  },
  {
    id: 'deliverable-audit',
    tag: 'Plan + File',
    title: 'Audit repo & export report',
    summary: 'Multi-step inspection emitting a downloadable deliverable card.',
    prompt: 'Audit this sandbox workspace and generate audit-report.md.',
    mode: 'plan',
  },
];

export const DEMO_STARTER_PROMPTS_ZH: readonly DemoStarterPrompt[] = [
  {
    id: 'malformed-tool',
    tag: '调用恢复',
    title: '畸形工具调用自动恢复',
    summary: '小模型把工具调用写成 XML 纯文本，Steerable 自动解析并执行测试修复。',
    prompt: '请修复失败的 parser 单测（模拟模型输出畸形工具调用并自动恢复）。',
  },
  {
    id: 'grounding-veto',
    tag: '事实核查',
    title: '完成前否决与事实核查',
    summary: '模型企图编造 200 OK 结论时被否决退回，强制用工具拿到真实 503 证据。',
    prompt: '核查 /health 接口是否真正返回 200 OK，并用真实执行结果作答。',
  },
  {
    id: 'sandbox-egress',
    tag: '沙箱隔离',
    title: 'OS 沙箱与域名白名单拦截',
    summary: '展示 Seatbelt / bwrap 隔离态势与 CONNECT 代理拦截未授权外连。',
    prompt: '检查当前沙箱隔离状态，并测试拦截未授权外网请求。',
  },
  {
    id: 'deliverable-audit',
    tag: 'Plan + 产物',
    title: '审计工作区并生成可下载报告',
    summary: '多步扫描契约文件并输出 audit-report.md 交付卡片（可直接点击下载）。',
    prompt: '审计当前沙箱工作区并生成 audit-report.md 报告文件。',
    mode: 'plan',
  },
];

export function detectPromptLanguage(text: string): 'zh' | 'en' {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) {
    // Keep English replies when the prompt itself is clearly English ASCII.
    return /[a-zA-Z]{3,}/.test(text) ? 'en' : 'zh';
  }
  return 'en';
}

export function matchPlaybookScenario(
  message: string,
  metadata?: Record<string, unknown>,
): PlaybookScenarioId {
  const lower = message.toLowerCase();
  if (
    /audit-report|audit|deliverable|artifact|export|报告|审计|生成文件/.test(lower) ||
    metadata?.mode === 'plan'
  ) {
    return 'deliverable-audit';
  }
  if (
    /malformed|xml|<function|parser|tool.?call|畸形|工具调用|解析|单测/.test(lower)
  ) {
    return 'malformed-tool';
  }
  if (
    /ground|veto|\/health|hallucin|幻觉|事实|核查|否决|200 ok/.test(lower)
  ) {
    return 'grounding-veto';
  }
  if (
    /sandbox|egress|seatbelt|bwrap|proxy|untrusted|沙箱|出口|代理|白名单|拦截/.test(lower)
  ) {
    return 'sandbox-egress';
  }
  return 'general';
}

export function buildPlaybookScript(input: {
  message: string;
  model: string;
  reasoningEffort?: string | null;
  execPolicy?: string | null;
  mode?: string | null;
  steerNote?: string | null;
}): PlaybookScript {
  const lang = detectPromptLanguage(input.message);
  const scenario = matchPlaybookScenario(input.message, { mode: input.mode });
  const modelLabel = input.model || 'glm-5.3-flash';
  const effortLabel = input.reasoningEffort ? ` @${input.reasoningEffort}` : '';

  if (scenario === 'malformed-tool') {
    if (lang === 'zh') {
      return {
        id: scenario,
        chatTitle: '畸形工具调用自动恢复',
        rounds: [
          {
            reasoning:
              `模型（${modelLabel}${effortLabel}）第一轮将工具调用写成了纯文本 XML 片段 <function=local_exec_shell>。` +
              'Steerable 恢复解析器提取参数并转为结构化调用，先运行测试定位失败原因。',
            actions: [
              {
                id: 'demo-rec-1',
                tool: 'local_exec_shell',
                mode: 'recovered_xml',
                sandbox: { backend: 'seatbelt', enforcement: 'full' },
                arguments: { command: 'pytest tests/test_parser.py -q' },
                result: {
                  success: false,
                  exitCode: 1,
                  output: 'FAILED tests/test_parser.py::test_nested_tag_recovery - AssertionError: unclosed tag',
                },
              },
            ],
          },
          {
            reasoning:
              '已拿到真实报错：test_nested_tag_recovery 断言失败。读取并修补 src/parser.py，然后复跑测试验证。',
            actions: [
              {
                id: 'demo-rec-2',
                tool: 'local_read_file',
                arguments: { path: 'src/parser.py', startLine: 40, endLine: 72 },
                result: {
                  success: true,
                  output: 'Read 33 lines from src/parser.py (recover_xml_tool_calls).',
                },
              },
              {
                id: 'demo-rec-3',
                tool: 'local_write_file',
                arguments: { path: 'src/parser.py', summary: 'Close trailing partial tag before JSON parse' },
                result: {
                  success: true,
                  output: 'Updated src/parser.py (+4 / -1 lines).',
                },
              },
              {
                id: 'demo-rec-4',
                tool: 'local_exec_shell',
                sandbox: { backend: 'seatbelt', enforcement: 'full' },
                arguments: { command: 'pytest tests/test_parser.py -q' },
                result: {
                  success: true,
                  exitCode: 0,
                  output: '12 passed in 0.41s',
                },
              },
            ],
          },
        ],
        reply: [
          `已通过 **Steerable 畸形调用恢复** 完成修复（${modelLabel}${effortLabel}）：`,
          '',
          '1. **捕获纯文本调用**：第一轮模型输出了 `<function=local_exec_shell>` 非标准格式，Harness 恢复解析器拦截后将其转为正常工具执行，未静默失败。',
          '2. **定位并修复**：`src/parser.py` 在嵌套标签未闭合时提前截断；补全尾部闭合处理。',
          '3. **复跑验证**：`pytest tests/test_parser.py -q` 输出 `12 passed in 0.41s`。',
        ].join('\n'),
        usage: {
          promptTokens: 6420,
          completionTokens: 485,
          totalTokens: 6905,
          cachedPromptTokens: 4100,
          costUsd: 0.0014,
        },
        suggestedReplies: [
          '模拟一次完成前事实核查否决',
          '检查 OS 沙箱和外网出口白名单拦截',
          '审计当前工作区并生成报告文件',
        ],
      };
    }

    return {
      id: scenario,
      chatTitle: 'Malformed tool call recovery',
      rounds: [
        {
          reasoning:
            `Model (${modelLabel}${effortLabel}) emitted a plain-text <function=local_exec_shell> block instead of structured tool_calls. ` +
            'Steerable recovered and executed the command inside the sandbox.',
          actions: [
            {
              id: 'demo-rec-1',
              tool: 'local_exec_shell',
              mode: 'recovered_xml',
              sandbox: { backend: 'seatbelt', enforcement: 'full' },
              arguments: { command: 'pytest tests/test_parser.py -q' },
              result: {
                success: false,
                exitCode: 1,
                output: 'FAILED tests/test_parser.py::test_nested_tag_recovery - AssertionError: unclosed tag',
              },
            },
          ],
        },
        {
          reasoning:
            'Observed failure in test_nested_tag_recovery. Reading src/parser.py, applying minimal patch, and re-running pytest.',
          actions: [
            {
              id: 'demo-rec-2',
              tool: 'local_read_file',
              arguments: { path: 'src/parser.py', startLine: 40, endLine: 72 },
              result: {
                success: true,
                output: 'Read 33 lines from src/parser.py (recover_xml_tool_calls).',
              },
            },
            {
              id: 'demo-rec-3',
              tool: 'local_write_file',
              arguments: { path: 'src/parser.py', summary: 'Normalize trailing partial XML tag before JSON parse' },
              result: {
                success: true,
                output: 'Updated src/parser.py (+4 / -1 lines).',
              },
            },
            {
              id: 'demo-rec-4',
              tool: 'local_exec_shell',
              sandbox: { backend: 'seatbelt', enforcement: 'full' },
              arguments: { command: 'pytest tests/test_parser.py -q' },
              result: {
                success: true,
                exitCode: 0,
                output: '12 passed in 0.41s',
              },
            },
          ],
        },
      ],
      reply: [
        `Fixed via **Steerable malformed-call recovery** (${modelLabel}${effortLabel}):`,
        '',
        '1. **Recovered text call**: Round 1 emitted `<function=local_exec_shell>` as plain text; CoreLoop parsed and ran it instead of dropping the turn.',
        '2. **Patched root cause**: `src/parser.py` truncated nested unclosed tags before JSON decoding.',
        '3. **Verified**: `pytest tests/test_parser.py -q` -> `12 passed in 0.41s`.',
      ].join('\n'),
      usage: {
        promptTokens: 6420,
        completionTokens: 485,
        totalTokens: 6905,
        cachedPromptTokens: 4100,
        costUsd: 0.0014,
      },
      suggestedReplies: [
        'Test the grounding judge & completion veto',
        'Check OS sandbox & egress allow-list denial',
        'Audit workspace and export audit-report.md',
      ],
    };
  }

  if (scenario === 'grounding-veto') {
    if (lang === 'zh') {
      return {
        id: scenario,
        chatTitle: '事实核查与完成否决',
        rounds: [
          {
            reasoning:
              '草稿试图直接回答「/health 返回 200 OK」，但当前回合没有任何工具结果支撑。' +
              'Completion Veto 判定 retry，强制先发真实探测工具。',
            actions: [
              {
                id: 'demo-gnd-1',
                tool: 'local_exec_shell',
                sandbox: { backend: 'seatbelt', enforcement: 'full' },
                arguments: { command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4787/health" },
                result: {
                  success: false,
                  exitCode: 1,
                  output: '503',
                },
              },
              {
                id: 'demo-gnd-2',
                tool: 'local_read_file',
                arguments: { path: 'logs/health-check.log', startLine: 1, endLine: 12 },
                result: {
                  success: true,
                  output: 'ERROR worker_pool: sidecar warm-up failed (missing SQLITE_TMPDIR)',
                },
              },
            ],
          },
        ],
        reply: [
          '结论：**`/health` 当前并未返回 `200`，实际返回 `503`**。',
          '',
          '- **拦截草稿**：第一版回答试图在未调用工具的情况下声称服务正常，被 **Grounding Judge** 否决并退回重试（`veto: retry`）。',
          '- **真实探测**：`curl` 实测状态码为 `503`；`logs/health-check.log` 显示 `worker_pool` 因缺少 `SQLITE_TMPDIR` 初始化失败。',
        ].join('\n'),
        usage: {
          promptTokens: 5180,
          completionTokens: 340,
          totalTokens: 5520,
          cachedPromptTokens: 3200,
          costUsd: 0.0011,
        },
        suggestedReplies: [
          '展示畸形工具调用恢复过程',
          '测试 OS 沙箱和域名白名单代理拦截',
          '生成工作区审计报告文件',
        ],
      };
    }

    return {
      id: scenario,
      chatTitle: 'Grounding judge & completion veto',
      rounds: [
        {
          reasoning:
            'Draft claimed "/health returns 200 OK" with zero tool evidence. ' +
            'Completion veto rejected the draft (retry), forcing a real check before replying.',
          actions: [
            {
              id: 'demo-gnd-1',
              tool: 'local_exec_shell',
              sandbox: { backend: 'seatbelt', enforcement: 'full' },
              arguments: { command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4787/health" },
              result: {
                success: false,
                exitCode: 1,
                output: '503',
              },
            },
            {
              id: 'demo-gnd-2',
              tool: 'local_read_file',
              arguments: { path: 'logs/health-check.log', startLine: 1, endLine: 12 },
              result: {
                success: true,
                output: 'ERROR worker_pool: sidecar warm-up failed (missing SQLITE_TMPDIR)',
              },
            },
          ],
        },
      ],
      reply: [
        'Result: **`/health` is not returning `200` — it returned `503`**.',
        '',
        '- **Veto triggered**: The initial ungrounded "all endpoints healthy" draft was rejected by the Grounding Judge (`veto: retry`).',
        '- **Verified evidence**: `curl` returned `503`, and `logs/health-check.log` reports `worker_pool` failed to initialize (`missing SQLITE_TMPDIR`).',
      ].join('\n'),
      usage: {
        promptTokens: 5180,
        completionTokens: 340,
        totalTokens: 5520,
        cachedPromptTokens: 3200,
        costUsd: 0.0011,
      },
      suggestedReplies: [
        'Demo malformed tool call recovery',
        'Test OS sandbox & egress allow-list denial',
        'Audit workspace and export audit-report.md',
      ],
    };
  }

  if (scenario === 'sandbox-egress') {
    if (lang === 'zh') {
      return {
        id: scenario,
        chatTitle: 'OS 沙箱与出口拦截演示',
        rounds: [
          {
            reasoning:
              '依次验证进程级隔离与域名白名单出口代理：工作区内只读命令允许执行，向未授权域名的出网请求被 fail-closed 拦截。',
            actions: [
              {
                id: 'demo-sbx-1',
                tool: 'local_exec_shell',
                sandbox: { backend: 'seatbelt', enforcement: 'full' },
                shellClassification: 'workspace_read',
                arguments: { command: 'ls -la /workspace/steerable-eval-sandbox' },
                result: {
                  success: true,
                  exitCode: 0,
                  output: 'README.md  package.json  src/  tests/',
                },
              },
              {
                id: 'demo-sbx-2',
                tool: 'local_exec_shell',
                sandbox: { backend: 'seatbelt', enforcement: 'full' },
                shellClassification: 'egress_network',
                arguments: { command: 'curl -fsS https://exfil.untrusted.example/dump' },
                result: {
                  success: false,
                  exitCode: 126,
                  output: 'EGRESS_DENIED: host exfil.untrusted.example is not in CONNECT allow-list',
                },
              },
            ],
          },
        ],
        reply: [
          '已完成沙箱与出网边界验证（Fail-closed）：',
          '',
          '- **工作区命令**：`ls -la` 在 Seatbelt 隔离下正常执行（仅授予当前工作区读写）。',
          '- **未授权外连**：`curl https://exfil.untrusted.example/dump` 被 **per-host CONNECT 出口代理** 拦截，返回 `EGRESS_DENIED`（退出码 `126`）。',
        ].join('\n'),
        usage: {
          promptTokens: 4390,
          completionTokens: 295,
          totalTokens: 4685,
          cachedPromptTokens: 2800,
          costUsd: 0.0009,
        },
        suggestedReplies: [
          '展示畸形工具调用恢复过程',
          '模拟完成前事实核查否决',
          '生成工作区审计报告文件',
        ],
      };
    }

    return {
      id: scenario,
      chatTitle: 'OS sandbox & egress allow-list',
      rounds: [
        {
          reasoning:
            'Checking OS confinement and per-host CONNECT egress allow-list: workspace reads succeed; untrusted network egress fails closed.',
          actions: [
            {
              id: 'demo-sbx-1',
              tool: 'local_exec_shell',
              sandbox: { backend: 'seatbelt', enforcement: 'full' },
              shellClassification: 'workspace_read',
              arguments: { command: 'ls -la /workspace/steerable-eval-sandbox' },
              result: {
                success: true,
                exitCode: 0,
                output: 'README.md  package.json  src/  tests/',
              },
            },
            {
              id: 'demo-sbx-2',
              tool: 'local_exec_shell',
              sandbox: { backend: 'seatbelt', enforcement: 'full' },
              shellClassification: 'egress_network',
              arguments: { command: 'curl -fsS https://exfil.untrusted.example/dump' },
              result: {
                success: false,
                exitCode: 126,
                output: 'EGRESS_DENIED: host exfil.untrusted.example is not in CONNECT allow-list',
              },
            },
          ],
        },
      ],
      reply: [
        'Verified fail-closed sandbox & egress boundaries:',
        '',
        '- **Workspace command**: `ls -la` succeeded inside Seatbelt confinement.',
        '- **Untrusted egress**: `curl https://exfil.untrusted.example/dump` was blocked by the per-host CONNECT proxy (`EGRESS_DENIED`, exit `126`).',
      ].join('\n'),
      usage: {
        promptTokens: 4390,
        completionTokens: 295,
        totalTokens: 4685,
        cachedPromptTokens: 2800,
        costUsd: 0.0009,
      },
      suggestedReplies: [
        'Demo malformed tool call recovery',
        'Test the grounding judge & completion veto',
        'Audit workspace and export audit-report.md',
      ],
    };
  }

  if (scenario === 'deliverable-audit') {
    const deliverable: TurnFile = {
      path: '/workspace/steerable-eval-sandbox/audit-report.md',
      kind: 'created',
      size: 512,
      additions: 15,
      category: 'deliverable',
      selection: 'resolved',
      deliverySource: 'present-files',
      description: lang === 'zh' ? '工作区架构与沙箱审计报告' : 'Workspace architecture & sandbox audit',
    };
    if (lang === 'zh') {
      return {
        id: scenario,
        chatTitle: '工作区审计与报告导出',
        rounds: [
          {
            reasoning:
              '按 Plan 步骤读取协议契约与包清单，汇总校验结果后生成 audit-report.md 作为本轮交付物。',
            actions: [
              {
                id: 'demo-aud-1',
                tool: 'local_read_file',
                arguments: { path: 'docs/spec/runtime-contract.json' },
                result: {
                  success: true,
                  output: 'sidecarRpcMethods: 38, protocolVersion: 1',
                },
              },
              {
                id: 'demo-aud-2',
                tool: 'local_write_file',
                arguments: { path: '/workspace/steerable-eval-sandbox/audit-report.md' },
                result: {
                  success: true,
                  output: 'Wrote 512 bytes to audit-report.md.',
                },
              },
            ],
          },
        ],
        reply: [
          '工作区审计已完成，并生成交付文件 `audit-report.md`（可直接点击下方文件卡片下载）：',
          '',
          '- **Sidecar 契约**：38 个 JSON-RPC 方法与协议 Schema 一致。',
          '- **安全基线**：Seatbelt 隔离与 CONNECT 出口白名单已启用。',
          '- **质量门控**：畸形调用恢复与完成否决均处于激活状态。',
        ].join('\n'),
        turnFiles: [deliverable],
        usage: {
          promptTokens: 7120,
          completionTokens: 540,
          totalTokens: 7660,
          cachedPromptTokens: 4900,
          costUsd: 0.0017,
        },
        suggestedReplies: [
          '检查畸形工具调用恢复场景',
          '测试完成前事实核查否决',
          '验证 OS 沙箱出口拦截',
        ],
      };
    }

    return {
      id: scenario,
      chatTitle: 'Workspace audit & report export',
      rounds: [
        {
          reasoning:
            'Inspecting runtime contract and package manifests, then writing audit-report.md as a downloadable turn deliverable.',
          actions: [
            {
              id: 'demo-aud-1',
              tool: 'local_read_file',
              arguments: { path: 'docs/spec/runtime-contract.json' },
              result: {
                success: true,
                output: 'sidecarRpcMethods: 38, protocolVersion: 1',
              },
            },
            {
              id: 'demo-aud-2',
              tool: 'local_write_file',
              arguments: { path: '/workspace/steerable-eval-sandbox/audit-report.md' },
              result: {
                success: true,
                output: 'Wrote 512 bytes to audit-report.md.',
              },
            },
          ],
        },
      ],
      reply: [
        'Workspace audit finished and exported `audit-report.md` (click the deliverable card below to download):',
        '',
        '- **Sidecar contract**: 38 JSON-RPC methods match protocol schema.',
        '- **Confinement**: Seatbelt + per-host CONNECT egress allow-list active.',
        '- **Quality guards**: Malformed call recovery & grounding veto enabled.',
      ].join('\n'),
      turnFiles: [deliverable],
      usage: {
        promptTokens: 7120,
        completionTokens: 540,
        totalTokens: 7660,
        cachedPromptTokens: 4900,
        costUsd: 0.0017,
      },
      suggestedReplies: [
        'Demo malformed tool call recovery',
        'Test grounding judge & completion veto',
        'Test OS sandbox & egress allow-list denial',
      ],
    };
  }

  // General interactive fallback for arbitrary user prompts
  const steerLine = input.steerNote
    ? lang === 'zh'
      ? `\n\n> 已接收轮中转向指令：「${input.steerNote}」，并在本轮响应中优先采纳。`
      : `\n\n> Applied mid-turn steering instruction: "${input.steerNote}".`
    : '';

  if (lang === 'zh') {
    return {
      id: 'general',
      chatTitle: input.message.slice(0, 28) || '交互剧本对话',
      rounds: [
        {
          reasoning:
            `当前在浏览器交互剧本模式下运行（模型选择：${modelLabel}${effortLabel}）。` +
            '先只读检查沙箱工作区文件，再按输入给出结构化回复。',
          actions: [
            {
              id: 'demo-gen-1',
              tool: 'local_read_file',
              arguments: { path: 'README.md', startLine: 1, endLine: 25 },
              result: {
                success: true,
                output: 'Steerable: 5-tier agent harness with CoreLoop, sandboxed sidecar, and React UI.',
              },
            },
          ],
        },
      ],
      reply: [
        `收到你的输入：「**${input.message}**」（${modelLabel}${effortLabel} · 浏览器交互剧本模式）。`,
        '',
        '当前演示页面跑在前端回放桥上（没有连接真实模型网关和本地 Python Sidecar），因此工具结果来自内置沙箱工作区剧本。你可以继续：',
        '- 点下方建议问题，体验 **畸形工具调用恢复**、**完成前事实核查否决**、**OS 沙箱拦截** 或 **可下载审计报告**；',
        '- 在本地运行 `npm install -g @steerable/agent-cli && steerable-cli login` 即可接入真实模型与 OS 沙箱。',
      ].join('\n') + steerLine,
      usage: {
        promptTokens: 2840,
        completionTokens: 210,
        totalTokens: 3050,
        cachedPromptTokens: 1900,
        costUsd: 0.0005,
      },
      suggestedReplies: [
        '演示畸形工具调用自动恢复',
        '演示事实核查与完成否决',
        '测试 OS 沙箱与出口白名单拦截',
      ],
    };
  }

  return {
    id: 'general',
    chatTitle: input.message.slice(0, 32) || 'Interactive playbook chat',
    rounds: [
      {
        reasoning:
          `Running in browser playbook mode (model: ${modelLabel}${effortLabel}). ` +
          'Inspecting sample workspace metadata before composing a grounded response.',
        actions: [
          {
            id: 'demo-gen-1',
            tool: 'local_read_file',
            arguments: { path: 'README.md', startLine: 1, endLine: 25 },
            result: {
              success: true,
              output: 'Steerable: 5-tier agent harness with CoreLoop, sandboxed sidecar, and React UI.',
            },
          },
        ],
      },
    ],
    reply: [
      `Received: "**${input.message}**" (${modelLabel}${effortLabel} · browser playbook mode).`,
      '',
      'This hosted demo runs against an in-browser CoreLoop playbook rather than a live model or local sidecar. Try one of the follow-ups below to inspect:',
      '- **Malformed tool-call recovery**, **grounding vetoes**, **OS sandbox & egress denial**, or **downloadable deliverables**.',
      '- Run `npm install -g @steerable/agent-cli && steerable-cli login` locally for live models and real OS confinement.',
    ].join('\n') + steerLine,
    usage: {
      promptTokens: 2840,
      completionTokens: 210,
      totalTokens: 3050,
      cachedPromptTokens: 1900,
      costUsd: 0.0005,
    },
    suggestedReplies: [
      'Demo malformed tool call recovery',
      'Test grounding judge & completion veto',
      'Test OS sandbox & egress allow-list denial',
    ],
  };
}
