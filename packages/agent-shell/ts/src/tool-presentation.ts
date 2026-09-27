/**
 * 一等工具的展示声明。
 *
 * 卡片种类和标题从这里按工具名取，不从名字前缀猜测。
 * 未声明的名字（MCP、插件、场景包）落到 generic / other，`declared: false`。
 * 宿主在 executed_actions 上盖 `view`，卡片读这份声明。
 */

export const TOOL_CARDS = ['generic', 'terminal', 'diff', 'search', 'read', 'web'] as const;
export type ToolCard = (typeof TOOL_CARDS)[number];

export const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'other',
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export interface ToolCallView {
  card: ToolCard;
  kind: ToolKind;
  title: string;
  /** 名字在声明表里。false 表示通用回退，不是从名字前缀推断出来的。 */
  declared: boolean;
}

type Args = Record<string, unknown>;

interface Presenter {
  card: ToolCard;
  kind: ToolKind;
  title: (args: Args, result?: unknown) => string;
}

function clip(text: string, max = 60): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function str(args: Args, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function dataOf(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const data = (result as { data?: unknown }).data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return result as Record<string, unknown>;
}

function failed(result: unknown): boolean {
  return Boolean(
    result && typeof result === 'object' && (result as { success?: unknown }).success === false,
  );
}

function commandTitle(args: Args): string {
  return clip(str(args, 'command')) || 'shell';
}

function pathTitle(args: Args, fallback: string): string {
  return clip(str(args, 'path') || str(args, 'file') || str(args, 'target'), 72) || fallback;
}

function webSearchTitle(args: Args, result?: unknown): string {
  const query = str(args, 'query');
  const head = `搜索“${clip(query, 40) || '…'}”`;
  if (result === undefined || failed(result)) return head;
  const data = dataOf(result);
  const count = data && typeof data.result_count === 'number' ? data.result_count : null;
  return count === null ? head : `${head} → ${count} 条结果`;
}

function shortUrl(raw: string): string {
  if (!raw) return '未知地址';
  try {
    const url = new URL(raw);
    const path = url.pathname === '/' ? '' : url.pathname;
    return clip(`${url.host}${path}`, 48);
  } catch {
    return clip(raw, 48);
  }
}

function webFetchTitle(args: Args, result?: unknown): string {
  const head = `抓取 ${shortUrl(str(args, 'url'))}`;
  if (result === undefined || failed(result)) return head;
  const data = dataOf(result);
  if (!data) return head;
  const parts: string[] = [];
  if (typeof data.status === 'number') parts.push(String(data.status));
  if (typeof data.bytes === 'number' && Number.isFinite(data.bytes)) {
    parts.push(data.bytes < 1024 ? `${data.bytes} B` : `${(data.bytes / 1024).toFixed(1)} KB`);
  }
  if (data.truncated === true) parts.push('已截断');
  return parts.length > 0 ? `${head} → ${parts.join(' · ')}` : head;
}

function taskRunTitle(args: Args, result?: unknown): string {
  const task = clip(str(args, 'task'));
  if (!task) return '后台任务';
  const status = dataOf(result)?.status;
  if (status === 'blocked') return `${task} · 等待依赖`;
  if (args.worktree === true) return `${task} · 隔离工作区`;
  return task;
}

function jobIdTitle(args: Args, fallback: string): string {
  const id = str(args, 'job_id') || str(args, 'taskId');
  return id ? id.slice(0, 8) : fallback;
}

function runCodeTitle(args: Args, result?: unknown): string {
  const description = clip(str(args, 'description'), 40) || '程序';
  if (failed(result)) return `程序「${description}」失败`;
  const calls = dataOf(result)?.calls;
  const count = Array.isArray(calls) ? calls.length : 0;
  return count > 0 ? `程序「${description}」· ${count} 个内层工具` : `程序「${description}」`;
}

function goalTitle(args: Args, fallback: string): string {
  return clip(str(args, 'objective'), 72) || fallback;
}

const PRESENTERS: Record<string, Presenter> = {
  local_exec_shell: { card: 'terminal', kind: 'execute', title: commandTitle },
  pwsh: { card: 'terminal', kind: 'execute', title: commandTitle },
  bash: { card: 'terminal', kind: 'execute', title: commandTitle },
  bash_session: { card: 'terminal', kind: 'execute', title: commandTitle },
  write_stdin: {
    card: 'terminal',
    kind: 'execute',
    title: (args) => clip(str(args, 'chars'), 40) || str(args, 'sessionId').slice(0, 8) || 'stdin',
  },
  local_run_snippet: {
    card: 'terminal',
    kind: 'execute',
    title: (args) => clip(str(args, 'code'), 48) || str(args, 'language') || 'snippet',
  },
  local_run_script: {
    card: 'terminal',
    kind: 'execute',
    title: (args) => str(args, 'scriptId') || 'script',
  },
  run_code: { card: 'generic', kind: 'execute', title: runCodeTitle },
  run_js: { card: 'generic', kind: 'execute', title: runCodeTitle },
  wait_js: {
    card: 'generic',
    kind: 'execute',
    title: (args) => str(args, 'id').slice(0, 8) || 'wait_js',
  },

  local_read_file: { card: 'read', kind: 'read', title: (args) => pathTitle(args, 'read') },
  read_file: { card: 'read', kind: 'read', title: (args) => pathTitle(args, 'read') },
  view_image: { card: 'read', kind: 'read', title: (args) => pathTitle(args, 'image') },
  capture_display: {
    card: 'read',
    kind: 'read',
    title: (args) => clip(str(args, 'target'), 48) || 'display',
  },
  local_list_scripts: { card: 'read', kind: 'read', title: () => '已保存的脚本' },

  local_write_file: { card: 'diff', kind: 'edit', title: (args) => pathTitle(args, 'write') },
  write_file: { card: 'diff', kind: 'edit', title: (args) => pathTitle(args, 'write') },
  local_edit_file: { card: 'diff', kind: 'edit', title: (args) => pathTitle(args, 'edit') },
  edit_file: { card: 'diff', kind: 'edit', title: (args) => pathTitle(args, 'edit') },
  apply_patch: { card: 'diff', kind: 'edit', title: () => 'apply_patch' },

  grep: {
    card: 'search',
    kind: 'search',
    title: (args) => clip(str(args, 'pattern')) || 'grep',
  },
  glob: {
    card: 'search',
    kind: 'search',
    title: (args) => clip(str(args, 'pattern')) || 'glob',
  },
  tool_search: {
    card: 'search',
    kind: 'search',
    title: (args) => clip(str(args, 'query')) || 'tool_search',
  },

  web_search: { card: 'web', kind: 'search', title: webSearchTitle },
  web_fetch: { card: 'web', kind: 'fetch', title: webFetchTitle },

  task_run: { card: 'generic', kind: 'other', title: taskRunTitle },
  task_send: {
    card: 'generic',
    kind: 'other',
    title: (args) => clip(str(args, 'message')) || '转达任务',
  },
  task_status: {
    card: 'generic',
    kind: 'read',
    title: (args, result) => {
      const id = str(args, 'taskId');
      if (id) return id.slice(0, 8);
      const total = dataOf(result)?.total;
      return typeof total === 'number' ? `${total} 个任务` : '本会话';
    },
  },
  task_result: {
    card: 'generic',
    kind: 'read',
    title: (args) => jobIdTitle(args, '收取结果'),
  },
  job_list: {
    card: 'generic',
    kind: 'read',
    title: (_args, result) => {
      const total = dataOf(result)?.total;
      return typeof total === 'number' ? `${total} 个任务` : '后台任务';
    },
  },
  job_output: { card: 'generic', kind: 'read', title: (args) => jobIdTitle(args, '任务输出') },
  job_kill: { card: 'generic', kind: 'delete', title: (args) => jobIdTitle(args, '结束任务') },
  worktree_create: {
    card: 'generic',
    kind: 'other',
    title: (args) => str(args, 'name') || '新建工作区',
  },
  worktree_list: { card: 'read', kind: 'read', title: () => '工作区列表' },
  worktree_remove: {
    card: 'generic',
    kind: 'delete',
    title: (args) => str(args, 'name') || '移除工作区',
  },

  get_goal: { card: 'generic', kind: 'read', title: () => '当前目标' },
  create_goal: { card: 'generic', kind: 'other', title: (args) => goalTitle(args, '新建目标') },
  update_goal: {
    card: 'generic',
    kind: 'other',
    title: (args) => {
      const action = str(args, 'action');
      const objective = clip(str(args, 'objective'), 48);
      return objective ? `${action || 'update'} ${objective}` : action || '更新目标';
    },
  },

  present_files: { card: 'generic', kind: 'other', title: () => '交付文件' },
  local_open_path: {
    card: 'generic',
    kind: 'other',
    title: (args) => pathTitle(args, 'open'),
  },
  todo_write: { card: 'generic', kind: 'other', title: () => '待办' },
  ask_user: {
    card: 'generic',
    kind: 'other',
    title: (args) => clip(str(args, 'intro') || str(args, 'question')) || '提问',
  },
  skill: { card: 'generic', kind: 'read', title: (args) => str(args, 'name') || 'skill' },
  delegate_subagent: {
    card: 'generic',
    kind: 'other',
    title: (args) => clip(str(args, 'task')) || str(args, 'subagent_type') || '子代理',
  },

  mcp_list_tools: { card: 'generic', kind: 'fetch', title: () => 'MCP 工具' },
  mcp_tool_exec: {
    card: 'generic',
    kind: 'fetch',
    title: (args) => str(args, 'toolName') || 'MCP',
  },
  plugin_list: { card: 'generic', kind: 'read', title: () => '插件' },
  plugin_enable: { card: 'generic', kind: 'other', title: (args) => str(args, 'name') || '启用插件' },
  plugin_disable: { card: 'generic', kind: 'delete', title: (args) => str(args, 'name') || '停用插件' },
  plugin_reload: { card: 'generic', kind: 'other', title: (args) => str(args, 'name') || '重载插件' },
};

/**
 * 取一次调用的展示。`result` 缺省时只根据参数出标题；结果到达后用同一声明补计数和状态。
 */
export function presentToolCall(name: string, args: unknown, result?: unknown): ToolCallView {
  const record =
    args && typeof args === 'object' && !Array.isArray(args) ? (args as Args) : {};
  const presenter = PRESENTERS[name];
  if (!presenter) {
    return { card: 'generic', kind: 'other', title: name, declared: false };
  }
  const title = presenter.title(record, result).trim() || name;
  return { card: presenter.card, kind: presenter.kind, title, declared: true };
}

export function declaredToolNames(): readonly string[] {
  return Object.keys(PRESENTERS);
}
