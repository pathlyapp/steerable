/**
 * `steerable-cli site-eval` offline private-model evaluation suite (Phase 9 R10).
 *
 * Drives 10–30 business tool-calling cases against an air-gapped OpenAI-compatible
 * endpoint (`baseUrl`, zero internet egress required) and computes:
 * - `toolHitRate` (native `tool_calls` accuracy)
 * - `pseudoToolRecoveryRate` (XML `<function=...>` / `<tool_call>` recovery)
 * - `promisedActionRescueRate` (single-shot continuation rescue when model narrates action without `tool_calls`)
 * - `latencyP50Ms` / `latencyP95Ms`
 * - `compatRecommendations` (e.g. `echoEmptyReasoningForToolCalls: true` on HTTP 400 `reasoning_content` errors)
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SiteEvalCase {
  readonly id: string;
  readonly prompt: string;
  readonly expectedTool: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }>;
  /** Optional multi-turn follow-up verification (triggers HTTP 400 if endpoint requires reasoning_content). */
  readonly verifyToolRoundtrip?: boolean;
}

export interface SiteEvalReport {
  readonly model: string;
  readonly baseUrl: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly toolHitRate: number;
  readonly pseudoToolRecoveries: number;
  readonly pseudoToolRecoveryRate: number;
  readonly promisedActionRescues: number;
  readonly promisedActionRescueRate: number;
  readonly http400Count: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly compatRecommendations: Readonly<Record<string, boolean>>;
}

const PSEUDO_TOOL_RE =
  /<function=([a-zA-Z0-9_:-]+)>|<tool_call>\s*\{[\s\S]*?"name"\s*:\s*"([a-zA-Z0-9_:-]+)"/;

const PROMISED_ACTION_CUE_RE =
  /(?:现在|马上|接下来|我将|我会|准备)[^\n。！？]{0,12}(?:调用|查询|搜索|执行|读取|核对)|(?:\bi\s+will|\blet\s+me|\bi'm\s+going\s+to)\s+(?:call|query|search|run|check)\b/i;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

export async function runSiteEvalSuite(options: {
  readonly model: string;
  readonly baseUrl: string;
  readonly suitePath?: string;
  readonly cases?: readonly SiteEvalCase[];
  readonly outFile?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<SiteEvalReport> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const cases: readonly SiteEvalCase[] = options.cases
    ? options.cases
    : options.suitePath
      ? loadSuiteFromPath(options.suitePath)
      : [];

  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
  };

  let directHits = 0;
  let pseudoRecoveries = 0;
  let promisedRescues = 0;
  let http400Count = 0;
  const compat: Record<string, boolean> = {};
  const latencies: number[] = [];

  for (const testCase of cases) {
    const openaiTools = testCase.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const t0 = performance.now();
    const resp = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: testCase.prompt }],
        tools: openaiTools,
      }),
    });
    latencies.push(performance.now() - t0);

    if (resp.status === 400) {
      http400Count += 1;
      const errText = await resp.text();
      if (/reasoning_content/i.test(errText)) {
        compat.echoEmptyReasoningForToolCalls = true;
      }
      if (/tool_choice/i.test(errText)) {
        compat.stripToolChoiceRequired = true;
      }
      continue;
    }

    const body = (await resp.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    const msg = body.choices?.[0]?.message;
    const calledName = msg?.tool_calls?.[0]?.function?.name;
    const text = msg?.content ?? '';

    if (calledName === testCase.expectedTool) {
      directHits += 1;

      if (testCase.verifyToolRoundtrip) {
        const tcId = msg?.tool_calls?.[0]?.id || 'call_1';
        const round2 = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: options.model,
            messages: [
              { role: 'user', content: testCase.prompt },
              {
                role: 'assistant',
                content: text || null,
                tool_calls: [
                  {
                    id: tcId,
                    type: 'function',
                    function: {
                      name: calledName,
                      arguments: msg?.tool_calls?.[0]?.function?.arguments ?? '{}',
                    },
                  },
                ],
              },
              { role: 'tool', tool_call_id: tcId, content: '{"ok":true}' },
            ],
            tools: openaiTools,
          }),
        });
        if (round2.status === 400) {
          http400Count += 1;
          const errText = await round2.text();
          if (/reasoning_content/i.test(errText)) {
            compat.echoEmptyReasoningForToolCalls = true;
          }
        }
      }
      continue;
    }

    // Check XML pseudo-tool recovery
    const pseudoMatch = PSEUDO_TOOL_RE.exec(text);
    const pseudoName = pseudoMatch?.[1] || pseudoMatch?.[2];
    if (pseudoName === testCase.expectedTool) {
      pseudoRecoveries += 1;
      continue;
    }

    // Check single-shot promised_action continuation rescue
    if (!calledName && PROMISED_ACTION_CUE_RE.test(text)) {
      const nudgeResp = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'user', content: testCase.prompt },
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                '[system notice] Emit the promised tool_call now instead of narrating.',
            },
          ],
          tools: openaiTools,
        }),
      });
      if (nudgeResp.status === 200) {
        const nudgeBody = (await nudgeResp.json()) as typeof body;
        const rescuedTool = nudgeBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.name;
        if (rescuedTool === testCase.expectedTool) {
          promisedRescues += 1;
        }
      }
    }
  }

  const total = cases.length;
  const passed = directHits + pseudoRecoveries + promisedRescues;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  const report: SiteEvalReport = {
    model: options.model,
    baseUrl: options.baseUrl,
    totalCases: total,
    passedCases: passed,
    toolHitRate: total > 0 ? Number((directHits / total).toFixed(4)) : 0,
    pseudoToolRecoveries: pseudoRecoveries,
    pseudoToolRecoveryRate: total > 0 ? Number((pseudoRecoveries / total).toFixed(4)) : 0,
    promisedActionRescues: promisedRescues,
    promisedActionRescueRate: total > 0 ? Number((promisedRescues / total).toFixed(4)) : 0,
    http400Count,
    latencyP50Ms: percentile(sortedLatencies, 50),
    latencyP95Ms: percentile(sortedLatencies, 95),
    compatRecommendations: compat,
  };

  if (options.outFile) {
    const resolvedOut = path.resolve(options.outFile);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

function loadSuiteFromPath(suitePath: string): SiteEvalCase[] {
  const stat = fs.statSync(suitePath);
  if (stat.isFile()) {
    return JSON.parse(fs.readFileSync(suitePath, 'utf8')) as SiteEvalCase[];
  }
  const cases: SiteEvalCase[] = [];
  for (const entry of fs.readdirSync(suitePath).sort()) {
    if (!entry.endsWith('.json')) continue;
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(suitePath, entry), 'utf8'));
    if (Array.isArray(parsed)) {
      cases.push(...(parsed as SiteEvalCase[]));
    } else if (parsed && typeof parsed === 'object') {
      cases.push(parsed as SiteEvalCase);
    }
  }
  return cases;
}
