/**
 * The `doctor` check list.
 *
 * Each check reports `ok`, `warn`, `fail`, or `skip` and, when it is not `ok`,
 * one runnable fix. Nothing here throws: a broken install must produce a
 * report, not a stack trace, so every check catches its own failure and turns
 * it into `fail` with the reason.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { apiKeyEnvNames, maskApiKey, resolveApiKey, type LlmSettings } from '@steerable/agent-shell/storage/llm-settings';
import {
  resolvePlatformRuntime,
  verifyPlatformRuntimeDeep,
  type PlatformRuntimeResult,
} from '@steerable/agent-runtime';
import { getEgressPosture } from '@steerable/agent-shell/sidecar/egress-proxy';

import { cliText } from './copy.js';
import { EXIT_CONFIG, EXIT_OK } from './exit-codes.js';
import { REQUIRED_NODE, REQUIRED_NODE_TUI, satisfies } from './node-version.js';

/** One check's outcome. */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

/** One row of the report. */
export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  /** Command or path that resolves a `warn` or `fail`. */
  fix?: string;
}

/** Inputs the checks read. */
export interface DoctorContext {
  nodeVersion: string;
  dataDir: string;
  logPath: string;
  settings: LlmSettings | null;
  settingsError?: string;
  /** Boot the sidecar and report the outcome; omitted when it cannot be tried. */
  bootSidecar?: () => Promise<{ ok: true; detail: string } | { ok: false; detail: string }>;
  /** Busy chats, when the store could be read. */
  busyChats?: string[] | null;
  /** Verify every declared runtime file, not only the executables. */
  deep: boolean;
  /** Platform runtime resolution, overridable for tests. */
  platformRuntime?: PlatformRuntimeResult;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs every check and returns the rows in display order.
 *
 * @param context Values the checks read.
 * @returns The report rows.
 */
export async function runDoctorChecks(context: DoctorContext): Promise<DoctorCheck[]> {
  const env = context.env ?? process.env;
  const platform = context.platformRuntime ?? resolvePlatformRuntime();
  const checks: DoctorCheck[] = [];
  checks.push(nodeCheck(context.nodeVersion));
  checks.push(writableDirCheck(context.dataDir));
  checks.push(...runtimeChecks(platform, env, context.deep));
  checks.push(egressCheck(platform, env));
  const key = apiKeyCheck(context);
  checks.push(key);
  checks.push(await sidecarCheck(context, key));
  checks.push(busyCheck(context.busyChats ?? null));
  return checks;
}

/**
 * @returns The process exit code: 78 when any check failed, else 0.
 */
export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((check) => check.status === 'fail') ? EXIT_CONFIG : EXIT_OK;
}

/**
 * Renders the report for a terminal.
 *
 * @param checks Rows from {@link runDoctorChecks}.
 * @param context Log path and hints.
 * @returns Lines to write.
 */
export function renderDoctor(checks: readonly DoctorCheck[], context: { logPath: string; verbose: boolean }): string[] {
  const lines: string[] = [];
  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) {
    const label = check.label.padEnd(width);
    lines.push(`  ${check.status.padEnd(4)}  ${label}  ${check.detail}`.trimEnd());
    if (check.fix && check.status !== 'ok' && check.status !== 'skip') {
      lines.push(`        ${cliText('doctor.fix', { fix: check.fix })}`);
    }
  }
  const fail = checks.filter((check) => check.status === 'fail').length;
  const warn = checks.filter((check) => check.status === 'warn').length;
  lines.push('');
  lines.push(
    fail > 0
      ? `${cliText('doctor.summaryFail', { fail, warn, log: context.logPath })}`
      : `${cliText('doctor.summaryOk', { log: context.logPath })}`,
  );
  if (!context.verbose) lines.push(cliText('doctor.verboseHint'));
  return lines;
}

function nodeCheck(version: string): DoctorCheck {
  const runs = satisfies(version, REQUIRED_NODE);
  const tui = satisfies(version, REQUIRED_NODE_TUI);
  const detail = tui
    ? `${version}（需要 ≥ ${REQUIRED_NODE}）`
    : `${version}（需要 ≥ ${REQUIRED_NODE}；tui 需要 ≥ ${REQUIRED_NODE_TUI}）`;
  if (!runs) {
    return {
      id: 'node',
      label: 'Node.js',
      status: 'fail',
      detail,
      fix: '升级 Node.js：https://nodejs.org/',
    };
  }
  return {
    id: 'node',
    label: 'Node.js',
    status: 'ok',
    detail,
  };
}

function writableDirCheck(dataDir: string): DoctorCheck {
  try {
    if (!existsSync(dataDir)) {
      return {
        id: 'data_dir',
        label: '数据目录',
        status: 'ok',
        detail: `${dataDir}（尚不存在，首次运行时创建）`,
      };
    }
    return { id: 'data_dir', label: '数据目录', status: 'ok', detail: dataDir };
  } catch {
    return { id: 'data_dir', label: '数据目录', status: 'fail', detail: dataDir, fix: '检查目录权限' };
  }
}

function runtimeChecks(
  platform: PlatformRuntimeResult,
  env: NodeJS.ProcessEnv,
  deep: boolean,
): DoctorCheck[] {
  const envPython = env.STEERABLE_SIDECAR_PYTHON?.trim();
  const envRunner = env.STEERABLE_PYTHON?.trim();
  if (envPython || envRunner) {
    const rows: DoctorCheck[] = [];
    if (envPython) {
      rows.push({
        id: 'sidecar_python',
        label: 'sidecar Python',
        status: existsSync(envPython) ? 'ok' : 'fail',
        detail: `env ${envPython}`,
        ...(existsSync(envPython) ? {} : { fix: '检查 STEERABLE_SIDECAR_PYTHON 指向的文件是否存在' }),
      });
    }
    if (envRunner) {
      rows.push({
        id: 'run_code_python',
        label: 'run_code Python',
        status: existsSync(envRunner) ? 'ok' : 'fail',
        detail: `env ${envRunner}`,
        ...(existsSync(envRunner) ? {} : { fix: '检查 STEERABLE_PYTHON 指向的文件是否存在' }),
      });
    }
    return rows;
  }
  if (platform.kind === 'ok') {
    const runtime = platform.runtime;
    const deepFailure = deep ? verifyPlatformRuntimeDeep(runtime) : null;
    const detail = `package ${runtime.packageName} ${runtime.manifest.packageVersion}`.trim();
    if (deepFailure) {
      return [
        {
          id: 'sidecar_python',
          label: 'sidecar Python',
          status: 'fail',
          detail: `${detail}；${deepFailure.detail}`,
          fix: cliText('runtime.reinstall'),
        },
        {
          id: 'run_code_python',
          label: 'run_code Python',
          status: 'fail',
          detail: cliText('doctor.sameFix'),
          fix: cliText('runtime.reinstall'),
        },
      ];
    }
    return [
      { id: 'sidecar_python', label: 'sidecar Python', status: 'ok', detail },
      { id: 'run_code_python', label: 'run_code Python', status: 'ok', detail: 'package' },
    ];
  }
  const fix =
    platform.reason === 'unsupported_platform'
      ? '自行准备运行时，见 steerable-cli doctor --verbose 的说明'
      : 'npm install -g @steerable/agent-cli --include=optional';
  return [
    {
      id: 'sidecar_python',
      label: 'sidecar Python',
      status: 'fail',
      detail: platform.detail,
      fix,
    },
    {
      id: 'run_code_python',
      label: 'run_code Python',
      status: 'fail',
      detail: cliText('doctor.sameFix'),
      fix,
    },
  ];
}

function egressCheck(platform: PlatformRuntimeResult, env: NodeJS.ProcessEnv): DoctorCheck {
  const fromEnv = env.STEERABLE_EGRESS_PROXY_BIN?.trim();
  if (fromEnv) {
    return {
      id: 'egress_proxy',
      label: '出口代理',
      status: existsSync(fromEnv) ? 'ok' : 'fail',
      detail: `env ${fromEnv}`,
      ...(existsSync(fromEnv) ? {} : { fix: '检查 STEERABLE_EGRESS_PROXY_BIN 指向的文件是否存在' }),
    };
  }
  if (platform.kind === 'ok' && platform.runtime.egressProxy) {
    return { id: 'egress_proxy', label: '出口代理', status: 'ok', detail: 'package' };
  }
  const posture = getEgressPosture();
  return {
    id: 'egress_proxy',
    label: '出口代理',
    status: 'warn',
    detail: posture?.reason ?? '未找到，网络规则会降为端口级',
    fix: 'npm install -g @steerable/agent-cli --include=optional',
  };
}

function apiKeyCheck(context: DoctorContext): DoctorCheck {
  if (!context.settings) {
    return {
      id: 'api_key',
      label: 'API key',
      status: 'fail',
      detail: context.settingsError ?? '读不到设置',
      fix: 'steerable-cli login',
    };
  }
  const resolved = resolveApiKey(context.settings, context.env ?? process.env);
  if (resolved.key) {
    const source = resolved.source.kind === 'env' ? `env:${resolved.source.name}` : 'config';
    return {
      id: 'api_key',
      label: 'API key',
      status: 'ok',
      detail: `${source} ${maskApiKey(resolved.key)}`,
    };
  }
  if (resolved.source.kind === 'not_required') {
    return { id: 'api_key', label: 'API key', status: 'ok', detail: 'not_required（本地提供方）' };
  }
  const names = apiKeyEnvNames(context.settings);
  return {
    id: 'api_key',
    label: 'API key',
    status: 'fail',
    detail: names.length > 0 ? `未配置；可设 ${names.join(' 或 ')}` : '未配置',
    fix: 'steerable-cli login',
  };
}

async function sidecarCheck(context: DoctorContext, key: DoctorCheck): Promise<DoctorCheck> {
  if (key.status === 'fail' || !context.bootSidecar) {
    return {
      id: 'sidecar_boot',
      label: 'sidecar 启动',
      status: 'skip',
      detail: '前置检查未通过，未尝试',
    };
  }
  try {
    const result = await context.bootSidecar();
    return result.ok
      ? { id: 'sidecar_boot', label: 'sidecar 启动', status: 'ok', detail: result.detail }
      : { id: 'sidecar_boot', label: 'sidecar 启动', status: 'fail', detail: result.detail, fix: '查看日志：' };
  } catch (error) {
    return {
      id: 'sidecar_boot',
      label: 'sidecar 启动',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      fix: '加 --verbose 重跑，查看日志',
    };
  }
}

function busyCheck(busy: string[] | null): DoctorCheck {
  if (busy === null) {
    return { id: 'busy_chats', label: '忙碌会话', status: 'warn', detail: '读不到锁目录' };
  }
  return {
    id: 'busy_chats',
    label: '忙碌会话',
    status: 'ok',
    detail: busy.length === 0 ? '无' : `${busy.length} 个（${busy.join(', ')}）`,
  };
}

/** @returns The default log file path under a data directory. */
export function logFilePath(dataDir: string): string {
  return join(dataDir, 'logs', 'main.log');
}
