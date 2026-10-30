import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `~` 展开后收成真实路径。
 * 绝对路径按自身解析。相对路径在给了 `baseDir` 时按该目录解析
 * （项目家目录或对话工作区），否则按进程当前目录解析。
 * 围栏比较前路径与根都要过这一步，这样 `/tmp` 与 `/private/tmp` 是同一目录。
 */
export function resolveFencePath(inputPath: string, baseDir?: string | null): string {
  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  if (path.isAbsolute(expanded) || !baseDir?.trim()) {
    return canonicalFencePath(path.resolve(expanded));
  }
  const base = canonicalFencePath(path.resolve(baseDir));
  return canonicalFencePath(path.resolve(base, expanded));
}

/** `~` 展开后 resolve，再解析符号链接。相对路径按进程当前目录解析。 */
export function expandFencePath(inputPath: string): string {
  return resolveFencePath(inputPath);
}

/**
 * `target` 是否就是 `root`，或落在它里面。两边都先解析符号链接，
 * 所以 `/tmp` 与 `/private/tmp` 是同一目录，指向外面的链接不算在里面。
 */
export function canonicalPathInside(root: string, target: string): boolean {
  const relative = path.relative(
    canonicalFencePath(path.resolve(root)),
    canonicalFencePath(path.resolve(target)),
  );
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** 把已 resolve 的绝对路径收成真实路径。解析失败时保留原路径。 */
export function canonicalFencePath(resolved: string): string {
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.reduceRight((dir, name) => path.join(dir, name), real);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return resolved;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
