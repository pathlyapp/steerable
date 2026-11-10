/**
 * Command-line copy. Product packs do not override these strings.
 *
 * Placeholders use `{name}` and are filled with `cliText(key, { name: value })`.
 * English is not shipped for the command line; the web UI is localized, the
 * terminal output is not.
 */
export const cliCopy = {
  'ask.unattended': '无人可答，请按最合理的默认继续。',
  'cli.approveAllWarning': '警告：--approve allow-all 会放行本次运行中的全部审批',
  'tui.approvalClosed': '审批已关闭',
  'tui.approvalRead': '只读自动放行',
  'tui.toolAuto': '自动',
  'tui.toolAutoAnswer': '自动回答',
  'tui.toolSessionAllow': '本会话已允许',

  // 预检：没有可用的 API key
  'preflight.missingKey': '还没有配置模型的 API key。任选一种：',
  'preflight.login': 'steerable-cli login',
  'preflight.envExport': 'export {env}=sk-...',
  'preflight.envExportPowerShell': '$env:{env}="sk-..."',
  'preflight.configSet': 'steerable-cli config set apiKey sk-...',
  'preflight.currentProvider': '当前提供方：{provider}，改提供方用 steerable-cli login。',

  // login / logout
  'login.pickProvider': '选择模型提供方（↑↓ 选择，回车确认，Esc 取消）',
  'login.groupCommon': '常用',
  'login.groupAll': '全部',
  'login.localNoKey': '本机，不需要 key',
  'login.custom': '自定义（兼容 OpenAI 的网关）',
  'login.current': '当前：{provider} · {model} · {key}。继续将覆盖。',
  'login.baseUrl': '输入 Base URL（例如 https://gateway.example.com/v1）',
  'login.enterKey': '输入 API key（输入时不显示，回车确认）',
  'login.createKeyAt': '在 {url} 创建',
  'login.verifying': '正在验证…',
  'login.verified': '已从服务端取到 {count} 个模型',
  'login.invalid': 'key 无效：服务端返回 {status}。请检查后重新输入（还可以试 {left} 次）',
  'login.unreachable': '连不上 {host}：{reason}',
  'login.retryOptions': '  [r] 重试   [s] 仍然保存（不验证）   [Esc] 取消',
  'login.pickModel': '选择默认模型（↑↓ 选择，回车确认；直接输入可筛选）',
  'login.saved': '已保存：{provider} · {model} · {key}',
  'login.savedUnverified': '未验证，第一次运行时如果失败请重新 login',
  'login.savedAt': '保存位置：{path}（仅当前用户可读）',
  'login.tryIt': '试一下：steerable-cli run "say hi"',
  'login.needsTty': 'login 需要在交互式终端中运行。脚本和 CI 中请用环境变量：',
  'login.cancelled': '已取消，配置未改动。',
  'logout.done': '已清除 {provider} 的 API key。环境变量中的 key 不受影响。',
  'logout.none': '没有已保存的 API key。',

  // 出口代理降级
  'egress.missing':
    '警告：未找到出口代理，网络只按端口放行，不按域名过滤。修复：npm install -g @steerable/agent-cli --include=optional，或设置 STEERABLE_EGRESS_PROXY_BIN。',

  // 运行时缺失
  'runtime.missing': '没有找到本平台（{target}）的 Steerable 运行时。',
  'runtime.missingFix': '补装：npm install -g @steerable/agent-cli --include=optional',
  'runtime.missingOverride': '或指定已有的运行时：export STEERABLE_SIDECAR_PYTHON=/path/to/python',
  'runtime.unsupported': 'Steerable 运行时暂不支持当前平台（{target}）。',
  'runtime.unsupportedTargets': '支持的平台：{targets}',
  'runtime.unsupportedManual':
    '自行准备：pip install steerable-sidecar，然后设置 STEERABLE_SIDECAR_PYTHON 和 STEERABLE_PYTHON',
  'runtime.digestMismatch': '运行时文件与发布清单不一致：{file}',
  'runtime.digestExpected': '期望 SHA-256：{sha}',
  'runtime.digestActual': '实际 SHA-256：{sha}',
  'runtime.invalidManifest': '运行时描述文件不可用：{detail}',
  'runtime.reinstall': '修复：重新安装 @steerable/agent-cli。',

  // doctor
  'doctor.title': '检查项',
  'doctor.fix': '修复：{fix}',
  'doctor.sameFix': '同上',
  'doctor.summaryOk': '全部通过。日志：{log}',
  'doctor.summaryFail': '{fail} 项失败，{warn} 项警告。日志：{log}',
  'doctor.verboseHint': '需要更多信息时加 --verbose。',
  'doctor.deepHint': '用 --deep 校验运行时文件的完整性。',

  // TUI
  'tui.nodeTooOld': '终端界面需要 Node.js {required} 或更高版本，当前为 {current}。',
  'tui.nodeTooOldWorkaround': '不升级也可以用：steerable-cli run "<任务>"',
  'tui.nodeTooOldUpgrade': '升级 Node.js：https://nodejs.org/',
  'tui.noKeyBanner': '还没有配置 API key。输入 /login 配置，或退出后设置 {env}。',
  'tui.noKeyLine': '还没有配置 API key，输入 /login',
  'tui.loginSaved': '✓ 已保存：{provider} · {model} · {key}',
} as const;

export type CliCopyKey = keyof typeof cliCopy;

/** Values substituted into `{name}` placeholders. */
export type CliCopyVars = Record<string, string | number>;

/**
 * Looks up a command-line string and fills its placeholders.
 *
 * @param key Dictionary key.
 * @param vars Values for `{name}` placeholders; unknown placeholders are left as written.
 * @returns The ready-to-print string.
 */
export function cliText(key: CliCopyKey, vars?: CliCopyVars): string {
  const template: string = cliCopy[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
