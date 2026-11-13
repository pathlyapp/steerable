/**
 * 包命令行注册表。产品组装根在启动 CLI 前注册；agent-cli 在内置命令之后分发。
 * 注册发生在 import 期或 createCli 的当次调用，不依赖宿主装配。
 */

import type { CliCommandSpec } from '../scenario/pack.js';

export type { CliCommandSpec };

const RESERVED = new Set(['run', 'chat', 'skills', 'mcp', 'config', 'doctor', 'tui']);
const NAME = /^[a-z][a-z0-9-]*$/;

const byPack = new Map<string, readonly CliCommandSpec[]>();

/** 名字必须是小写命令，且不能占用内置命令。 */
export function assertPackCliCommandName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(`[pack-cli] command name "${name}" must match ${NAME}`);
  }
  if (RESERVED.has(name)) {
    throw new Error(`[pack-cli] command "${name}" is reserved`);
  }
}

/** 注册一个包的命令。同包或同名重复注册抛错。 */
export function registerPackCliCommands(packId: string, commands: readonly CliCommandSpec[]): void {
  if (byPack.has(packId)) {
    throw new Error(`[pack-cli] duplicate registration for pack: ${packId}`);
  }
  const taken = new Set(listPackCliCommands().map((command) => command.name));
  for (const command of commands) {
    assertPackCliCommandName(command.name);
    if (taken.has(command.name)) {
      throw new Error(`[pack-cli] duplicate command: ${command.name}`);
    }
    taken.add(command.name);
  }
  byPack.set(packId, commands);
}

/** 已注册命令，按注册序。 */
export function listPackCliCommands(): readonly CliCommandSpec[] {
  return [...byPack.values()].flat();
}

/**
 * 合并注册表和本次调用额外传入的命令。额外命令不写入注册表，
 * 所以 createCli 可以重复调用。
 */
export function collectPackCliCommands(extra: readonly CliCommandSpec[] = []): CliCommandSpec[] {
  const merged = [...listPackCliCommands()];
  const taken = new Set(merged.map((command) => command.name));
  for (const command of extra) {
    assertPackCliCommandName(command.name);
    if (taken.has(command.name)) {
      throw new Error(`[pack-cli] duplicate command: ${command.name}`);
    }
    taken.add(command.name);
    merged.push(command);
  }
  return merged;
}

/** 测试钩子。 */
export function resetPackCliCommands(): void {
  byPack.clear();
}
