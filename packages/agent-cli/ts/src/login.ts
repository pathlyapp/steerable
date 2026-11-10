/**
 * `login` and `logout`: where the command line learns a model credential.
 *
 * `login` verifies the key with one model-list request before saving it, so a
 * typo fails here instead of on the first real turn. The saved key lands in the
 * same store the desktop settings screen writes, so both surfaces agree.
 */

import type { AgentClient } from '@steerable/agent-client';
import {
  mergeLlmSettings,
  sanitizeLlmProvider,
  sanitizeVendorId,
  type LlmSettings,
} from '@steerable/agent-shell/storage/llm-settings';

import { maskApiKey, preflightApiKey } from './credentials.js';

import { cliText } from './copy.js';
import { EXIT_CONFIG, EXIT_OK, EXIT_USAGE } from './exit-codes.js';
import { chooseIndex, createLineReader, readSecret, type ProviderChoice, type VerifyResult } from './login-prompt.js';

/** Everything `login` needs from the caller. */
export interface LoginDeps {
  /** Open a host client without starting the sidecar for the prompt phase. */
  request: AgentClient['request'];
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  dataDir: string;
}

/** Vendors offered first, mirroring the web settings picker. */
const FEATURED = [
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'alibaba-cn',
  'moonshotai-cn',
  'zhipuai',
  'groq',
  'xai',
] as const;

/** Fallback when the sidecar cannot describe its catalog yet. */
const FALLBACK_PROVIDERS: ProviderChoice[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiBaseUrl: 'https://api.deepseek.com',
    wireKind: 'openai_compat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envVars: ['DEEPSEEK_API_KEY'],
    featured: true,
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    apiBaseUrl: 'https://api.openai.com/v1',
    wireKind: 'openai_compat',
    models: [],
    envVars: ['OPENAI_API_KEY'],
    featured: true,
    needsKey: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    apiBaseUrl: 'https://api.anthropic.com',
    wireKind: 'anthropic',
    models: [],
    envVars: ['ANTHROPIC_API_KEY'],
    featured: true,
    needsKey: true,
  },
  {
    id: 'google',
    label: 'Google Gemini',
    apiBaseUrl: 'https://generativelanguage.googleapis.com',
    wireKind: 'google',
    models: [],
    envVars: ['GEMINI_API_KEY'],
    featured: true,
    needsKey: true,
  },
];

/**
 * Runs the interactive login flow.
 *
 * @returns Process exit code.
 */
export async function loginCommand(deps: LoginDeps): Promise<number> {
  if (!deps.stdinIsTTY) {
    deps.stderr.write(`${cliText('login.needsTty')}\n`);
    deps.stderr.write(`  ${cliText('preflight.envExport', { env: 'DEEPSEEK_API_KEY' })}\n`);
    deps.stderr.write(`  ${cliText('preflight.configSet')}\n`);
    return EXIT_USAGE;
  }
  const { settings, current } = await readSettings(deps);
  const providers = await loadProviders(deps, settings);
  const reader = createLineReader(deps.stdin, deps.stdout);

  deps.stdout.write(
    `${cliText('login.current', {
      provider: current.label,
      model: settings.model,
      key: maskApiKey(settings.apiKey) || '(无)',
    })}\n\n`,
  );
  const featured = providers.filter((entry) => entry.featured);
  const rest = providers.filter((entry) => !entry.featured);
  const rows = [...featured, ...rest];
  const defaultIndex = Math.max(0, rows.findIndex((entry) => entry.id === current.id));
  const picked = await chooseIndex(
    reader,
    rows,
    (row: ProviderChoice) => `${row.label.padEnd(18)} ${row.apiBaseUrl ?? ''}`.trimEnd(),
    cliText('login.pickProvider'),
    deps.stdout,
    defaultIndex,
  );
  if (picked === null) {
    deps.stdout.write(`${cliText('login.cancelled')}\n`);
    return EXIT_CONFIG;
  }
  const provider = rows[picked];
  if (!provider) return EXIT_USAGE;

  let baseUrl = provider.apiBaseUrl;
  if (!baseUrl) {
    const typed = await reader(`${cliText('login.baseUrl')}\n> `);
    if (typed === null) {
      deps.stdout.write(`${cliText('login.cancelled')}\n`);
      return EXIT_CONFIG;
    }
    baseUrl = typed.trim() || null;
  }

  let apiKey: string | null = null;
  let verified = false;
  if (provider.needsKey) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const entered = await readSecret(`${cliText('login.enterKey')}\n> `, deps.stdin, deps.stdout, reader);
      if (entered === null) {
        deps.stdout.write(`${cliText('login.cancelled')}\n`);
        return EXIT_CONFIG;
      }
      const key = entered.trim();
      if (!key) {
        deps.stdout.write('key 不能为空。\n');
        continue;
      }
      deps.stdout.write(`${cliText('login.verifying')}\n`);
      const result = await verifyKey(deps, provider, baseUrl, key);
      if (result.kind === 'ok') {
        apiKey = key;
        verified = true;
        deps.stdout.write(`${cliText('login.verified', { count: result.models.length })}\n`);
        provider.models = result.models.length > 0 ? result.models : provider.models;
        break;
      }
      if (result.kind === 'rejected') {
        const left = 3 - attempt;
        deps.stdout.write(
          `${cliText('login.invalid', { status: result.status, left })}\n`,
        );
        if (left === 0) {
          deps.stdout.write('多次验证失败，已取消，配置未改动。\n');
          return EXIT_CONFIG;
        }
        continue;
      }
      deps.stdout.write(`${cliText('login.unreachable', { host: hostOf(baseUrl), reason: result.reason })}\n`);
      deps.stdout.write(`${cliText('login.retryOptions')}\n`);
      const choice = (await reader('> '))?.trim().toLowerCase() ?? '';
      if (choice === 's') {
        apiKey = key;
        break;
      }
      if (choice === 'r') continue;
      deps.stdout.write(`${cliText('login.cancelled')}\n`);
      return EXIT_CONFIG;
    }
  }

  const models = provider.models;
  let model = models[0] ?? '';
  if (models.length > 0) {
    const modelIndex = await chooseIndex(
      reader,
      models,
      (row: string) => row,
      cliText('login.pickModel'),
      deps.stdout,
      0,
    );
    if (modelIndex === null) {
      deps.stdout.write(`${cliText('login.cancelled')}\n`);
      return EXIT_CONFIG;
    }
    model = models[modelIndex] ?? model;
  }

  const next = mergeLlmSettings({
    provider: sanitizeLlmProvider(provider.wireKind === 'openai_compat' ? 'openai-compat' : provider.wireKind),
    vendorId: sanitizeVendorId(provider.id),
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  const saved = await deps.request('POST', '/api/v2/local-settings/llm', next);
  if (saved.status !== 200) {
    deps.stderr.write(`保存失败（${saved.status}）\n`);
    return EXIT_CONFIG;
  }
  deps.stdout.write(
    `${cliText('login.saved', {
      provider: provider.label,
      model,
      key: maskApiKey(apiKey),
    })}\n`,
  );
  if (!verified && apiKey) deps.stdout.write(`${cliText('login.savedUnverified')}\n`);
  deps.stdout.write(`${cliText('login.savedAt', { path: settingsPath(deps.dataDir) })}\n`);
  deps.stdout.write(`${cliText('login.tryIt')}\n`);
  return EXIT_OK;
}

/**
 * Clears the stored credential. Environment variables are untouched.
 *
 * @returns Process exit code.
 */
export async function logoutCommand(deps: Pick<LoginDeps, 'request' | 'stdout' | 'stderr'>): Promise<number> {
  const { settings, current } = await readSettings(deps);
  if (!settings.apiKey) {
    deps.stdout.write(`${cliText('logout.none')}\n`);
    return EXIT_OK;
  }
  const { apiKey: _removed, ...rest } = settings;
  const saved = await deps.request('POST', '/api/v2/local-settings/llm', rest);
  if (saved.status !== 200) {
    deps.stderr.write(`保存失败（${saved.status}）\n`);
    return EXIT_CONFIG;
  }
  deps.stdout.write(`${cliText('logout.done', { provider: current.label })}\n`);
  return EXIT_OK;
}

async function readSettings(deps: Pick<LoginDeps, 'request' | 'stderr'>): Promise<{
  settings: LlmSettings;
  current: ProviderChoice;
}> {
  const response = await deps.request('GET', '/api/v2/local-settings/llm', undefined);
  const raw = (response.data ?? {}) as Partial<LlmSettings>;
  const settings = mergeLlmSettings({
    provider: sanitizeLlmProvider(raw.provider),
    model: typeof raw.model === 'string' ? raw.model : '',
    ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
    ...(typeof raw.apiKey === 'string' ? { apiKey: raw.apiKey } : {}),
    ...(typeof raw.vendorId === 'string' ? { vendorId: raw.vendorId } : {}),
  });
  const current: ProviderChoice = {
    id: settings.vendorId ?? settings.provider,
    label: settings.vendorId ?? settings.provider,
    apiBaseUrl: settings.baseUrl ?? null,
    wireKind: settings.provider,
    models: [],
    envVars: [],
    featured: true,
    needsKey: settings.provider !== 'ollama',
  };
  return { settings, current };
}

async function loadProviders(
  deps: Pick<LoginDeps, 'request' | 'stdout'>,
  settings: LlmSettings,
): Promise<ProviderChoice[]> {
  const response = await deps.request('GET', '/api/v2/llm/catalog', undefined);
  const rows = (response.data as { providers?: unknown[] } | undefined)?.providers;
  const parsed: ProviderChoice[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      if (typeof record.id !== 'string') continue;
      parsed.push({
        id: record.id,
        label: record.id,
        apiBaseUrl: typeof record.apiBaseUrl === 'string' ? record.apiBaseUrl : null,
        wireKind: typeof record.wireKind === 'string' ? record.wireKind : 'openai_compat',
        models: Array.isArray(record.models) ? record.models.filter((m): m is string => typeof m === 'string') : [],
        envVars: Array.isArray(record.envVars) ? record.envVars.filter((e): e is string => typeof e === 'string') : [],
        featured: (FEATURED as readonly string[]).includes(record.id),
        needsKey: record.wireKind !== 'ollama',
      });
    }
  }
  const base = parsed.length > 0 ? parsed : FALLBACK_PROVIDERS;
  const withLocal: ProviderChoice[] = base.some((entry) => entry.id === 'ollama')
    ? base
    : [
        ...base,
        {
          id: 'ollama',
          label: 'Ollama（本机）',
          apiBaseUrl: 'http://127.0.0.1:11434',
          wireKind: 'ollama',
          models: ['llama3.1:8b'],
          envVars: [],
          featured: false,
          needsKey: false,
        },
      ];
  const custom: ProviderChoice = {
    id: 'custom',
    label: cliText('login.custom'),
    apiBaseUrl: null,
    wireKind: 'openai_compat',
    models: [],
    envVars: [],
    featured: false,
    needsKey: true,
  };
  const ordered = withLocal.some((entry) => entry.id === 'custom') ? withLocal : [...withLocal, custom];
  // Keep the current vendor reachable even when the catalog does not list it.
  const known = ordered.some((entry) => entry.id === (settings.vendorId ?? settings.provider));
  return known
    ? ordered
    : [
        ...ordered,
        {
          ...(ordered[0] as ProviderChoice),
          id: settings.vendorId ?? settings.provider,
          label: settings.vendorId ?? settings.provider,
          featured: true,
        },
      ];
}

async function verifyKey(
  deps: Pick<LoginDeps, 'request'>,
  provider: ProviderChoice,
  baseUrl: string | null,
  apiKey: string,
): Promise<VerifyResult> {
  const query = new URLSearchParams({ apiKey, refresh: '1' });
  if (baseUrl) query.set('baseUrl', baseUrl);
  if (provider.wireKind) query.set('provider', provider.wireKind);
  let response: { status: number; data: unknown };
  try {
    response = await deps.request('GET', `/api/v2/llm/models?${query.toString()}`, undefined);
  } catch (error) {
    return { kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) };
  }
  const data = (response.data ?? {}) as { models?: unknown[]; catalogStatus?: string; error?: string };
  if (response.status === 401 || response.status === 403) return { kind: 'rejected', status: response.status };
  if (response.status !== 200) {
    return { kind: 'unreachable', reason: data.error ?? `HTTP ${response.status}` };
  }
  const models = Array.isArray(data.models)
    ? data.models
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
              ? (entry as { id: string }).id
              : null,
        )
        .filter((id): id is string => typeof id === 'string')
    : [];
  if (data.catalogStatus === 'offline' && models.length === 0) {
    return { kind: 'no-models', reason: data.error ?? 'offline' };
  }
  return { kind: 'ok', models };
}

function hostOf(baseUrl: string | null): string {
  if (!baseUrl) return '(未填写 Base URL)';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/** Where the settings live, for the "saved" line. */
export function settingsPath(dataDir: string): string {
  return `${dataDir}/agent-shell.db`;
}

/**
 * The three ways to configure a key, in the order to offer them.
 *
 * @param envNames Environment variables the provider accepts, in order.
 * @param platform Host platform, choosing the PowerShell export form.
 * @returns Runnable lines.
 */
export function preflightFixes(envNames: readonly string[], platform: string = process.platform): string[] {
  const env = envNames[0] ?? 'DEEPSEEK_API_KEY';
  return [
    cliText('preflight.login'),
    platform === 'win32'
      ? cliText('preflight.envExportPowerShell', { env })
      : cliText('preflight.envExport', { env }),
    cliText('preflight.configSet'),
  ];
}
