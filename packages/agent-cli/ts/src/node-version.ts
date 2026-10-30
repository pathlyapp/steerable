/**
 * Minimum Node for the command line.
 *
 * `@opentui/core` 0.5.12 declares `engines.node` `>=26.4.0`. Its FFI packages
 * and the rest of the agent-cli dependency tree do not declare a higher
 * minimum. This module imports nothing: the bin loads it before the CLI.
 */

export const REQUIRED_NODE = '26.4.0';

export interface NodeVersionWriter {
  write(chunk: string): unknown;
}

/** @param current Installed version, with or without a leading `v`. @param required `major.minor.patch`. @returns Whether `current` is at least `required`. */
export function satisfies(current: string, required: string): boolean {
  const left = readVersion(current);
  const right = readVersion(required);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

/** @param current Installed version. @param stderr Where the failure text is written. @param product Command name, such as `agent`. @returns `0` when the version is new enough, otherwise `1`. */
export function ensureSupportedNode(
  current: string,
  stderr: NodeVersionWriter,
  product: string,
): number {
  if (satisfies(current, REQUIRED_NODE)) return 0;
  const shown = current.replace(/^v/, '');
  stderr.write(
    `${product} 需要 Node.js ${REQUIRED_NODE} 或更高版本，当前为 ${shown}。\n升级方法：https://nodejs.org/\n`,
  );
  return 1;
}

/** @param current Installed version. @returns One doctor row, including whether it meets {@link REQUIRED_NODE}. */
export function nodeDoctorLine(current: string): string {
  const shown = current.replace(/^v/, '');
  const mark = satisfies(current, REQUIRED_NODE) ? '✓' : '✗';
  return `Node.js: ${shown}（需要 ≥ ${REQUIRED_NODE}） ${mark}\n`;
}

function readVersion(value: string): [number, number, number] | null {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
