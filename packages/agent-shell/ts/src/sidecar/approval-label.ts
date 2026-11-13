import { homedir } from 'node:os';
import path from 'node:path';

import { canonicalFencePath, canonicalPathInside } from '../fence-path.js';

const COMMAND_TOOLS = new Set(['local_exec_shell', 'local_run_snippet']);
// Only the shell starts an explicit cwd outside the writable roots. A snippet
// is rejected before it runs, so its card must not say the command still runs.
const OUTSIDE_CWD_TOOLS = new Set(['local_exec_shell']);

const BUILTIN_CATEGORY_LABEL: Record<string, string> = {
  network_egress: 'Internet access',
  sandbox_escalation: 'Sandbox',
};

export interface ApprovalCategoryLabelInput {
  locale: string;
  category: string;
  toolName: string;
  declaredLabel?: Readonly<Record<string, string>>;
  translate: (message: string) => string;
}

/**
 * Display name for an approval category.
 * Pack declarations win. Built-in categories and shell tools use the shell dictionary.
 *
 * @param input Locale, category, and the tool's declared labels.
 * @returns A label for the card, or undefined when the category is just the tool name.
 */
export function resolveApprovalCategoryLabel(input: ApprovalCategoryLabelInput): string | undefined {
  const declared = declaredLabel(input.declaredLabel, input.locale);
  if (declared) return declared;
  const builtin = BUILTIN_CATEGORY_LABEL[input.category];
  if (builtin) return input.translate(builtin);
  if (COMMAND_TOOLS.has(input.toolName) || COMMAND_TOOLS.has(input.category)) return input.translate('Command');
  return undefined;
}

/** English source string for the approval card. The web view translates it. */
export function hostApprovalCategoryLabel(input: {
  category: string;
  toolName: string;
  declaredLabel?: Readonly<Record<string, string>>;
}): string | undefined {
  return resolveApprovalCategoryLabel({
    locale: 'en',
    category: input.category,
    toolName: input.toolName,
    ...(input.declaredLabel ? { declaredLabel: input.declaredLabel } : {}),
    translate: (message) => message,
  });
}

export type CwdFence = 'project' | 'workspace';

/**
 * Which approval sentence to show when `local_exec_shell` names a cwd
 * outside the writable root. A bound project uses its folder and source
 * folders. A chat without a project uses the conversation workspace.
 *
 * @param input Tool name, cwd, and the chat's project or workspace root.
 * @returns `false` when the card should not mention an outside directory.
 */
export function approvalCwdFence(input: {
  toolName: string;
  cwd: unknown;
  projectRoot: string | null;
  workspaceRoot: string | null;
  sourceFolders: readonly string[];
  home?: string;
}): CwdFence | false {
  const bound = Boolean(input.projectRoot);
  const outside = shellCwdOutsideProject({
    toolName: input.toolName,
    cwd: input.cwd,
    projectRoot: input.projectRoot ?? input.workspaceRoot,
    sourceFolders: bound ? input.sourceFolders : [],
    ...(input.home ? { home: input.home } : {}),
  });
  if (!outside) return false;
  return bound ? 'project' : 'workspace';
}

/**
 * True when `local_exec_shell` names a cwd outside the given root and its source folders.
 *
 * The root is the project folder, or the conversation workspace when the chat
 * has no project. `home` defaults to the process home directory, the same
 * directory the shell fence uses when it expands `~`.
 *
 * @param input Tool name, cwd argument, and the chat's writable folders.
 * @returns Whether that cwd is outside those folders.
 */
export function shellCwdOutsideProject(input: {
  toolName: string;
  cwd: unknown;
  projectRoot: string | null;
  sourceFolders: readonly string[];
  home?: string;
}): boolean {
  if (!OUTSIDE_CWD_TOOLS.has(input.toolName)) return false;
  if (!input.projectRoot || typeof input.cwd !== 'string' || !input.cwd.trim()) return false;
  const target = resolveCwd(input.cwd.trim(), input.projectRoot, input.home ?? homedir());
  const roots = [input.projectRoot, ...input.sourceFolders];
  return !roots.some((root) => canonicalPathInside(root, target));
}

function declaredLabel(
  label: Readonly<Record<string, string>> | undefined,
  locale: string,
): string | undefined {
  if (!label) return undefined;
  const exact = label[locale];
  if (exact) return exact;
  const normalized = locale.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return label['zh-CN'] || label.zh || label['zh-Hans'];
  }
  if (normalized === 'en' || normalized.startsWith('en-')) return label.en;
  return label.en;
}

function resolveCwd(cwd: string, projectRoot: string, home: string): string {
  // Same `~` rule as ToolRouter.applyProjectCwdSandbox: slice(1) keeps the
  // separator, and path.join folds it into the home directory. The fence
  // comparison uses the real path, so `/tmp` and `/private/tmp` match.
  const expanded = cwd.startsWith('~') ? path.join(home, cwd.slice(1)) : cwd;
  const root = canonicalFencePath(path.resolve(projectRoot));
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  return canonicalFencePath(resolved);
}
