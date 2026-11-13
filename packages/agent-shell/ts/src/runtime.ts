/**
 * 宿主运行时抽象：Tauri 监督的 Node 宿主与 BS 独立 Node server 共用的环境探测。
 *
 * 数据目录优先取 `DEEPPATH_USER_DATA_DIR`（Tauri 宿主总是注入），否则落到
 * 产品注入的 `~/<dataDirName>`（3.1）。两种模式共用同一份 SQLite / JSON
 * 存储代码，差异只在这一层。
 *
 * 本模块只允许依赖 node 内置模块（与 brand.ts 同约束）：storage 会被
 * vitest 直接 import。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProductConfig } from './product-config.js';

/** 应用数据目录（SQLite、JSON store、用户技能目录的根）。 */
export function getUserDataDir(): string {
  if (process.env.DEEPPATH_USER_DATA_DIR) return process.env.DEEPPATH_USER_DATA_DIR;
  // 目录名是产品注入配置（3.1，product.json dataDirName）；中性 shell 缺省 .agent-shell。
  const dirName = getProductConfig().dataDirName ?? '.agent-shell';
  return path.join(os.homedir(), dirName);
}

/**
 * 用户文档目录。项目默认家目录建在这里的「应用名」文件夹下
 * （见 project-home.ts）。测试可用 STEERABLE_DOCUMENTS_DIR 改锚点，
 * 避免写进真实 Documents。
 */
export function getDocumentsDir(): string {
  if (process.env.STEERABLE_DOCUMENTS_DIR) return process.env.STEERABLE_DOCUMENTS_DIR;
  return path.join(os.homedir(), 'Documents');
}

/**
 * 应用根目录（消费产品的仓库/打包根：含 products/manifest.json、assets、
 * scripts 的那层）。3.2 起 shell 是被消费的框架包，本模块自己的位置
 * （packages/agent-shell/ts/...）不再是应用根——产品组装根在入口最早
 *  import 时经 setAppRootDir 注入；未注入时（单测）回退到 cwd 探测。
 */
let appRootOverride: string | null = null;

/**
 * 注入应用根目录（产品组装根调用）。重复注入不同值抛错（组装期笔误，
 * fail fast——与 setProductBrand 同语义）。
 */
export function setAppRootDir(dir: string): void {
  if (appRootOverride && appRootOverride !== dir) {
    throw new Error('[runtime] app root already set');
  }
  appRootOverride = dir;
}

export function getAppRootDir(): string {
  if (appRootOverride) return appRootOverride;
  // 单测/脚本平面：从 cwd 向上找含 package.json 的目录。
  for (let dir = process.cwd(); ; ) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * 产品 web 产物目录（2.3）：产品入口（products/<id>/server.ts）用本函数
 * 把 DEEPPATH_WEB_DIST 注入环境，shell server 据此定位 web dist。双平面
 * 探测：源码平面入口在 products/<id>/（web dist 在同级 web/dist）；编译
 * 平面入口在 products/<id>/dist/products/<id>/（web dist 在仓库根的
 * products/<id>/web/dist）。两处都没有返回 null（打包后的 Tauri 宿主直接
 * 注入 DEEPPATH_WEB_DIST，不经本函数）。
 */
export function resolveProductWebDist(entryUrl: string): string | null {
  const here = path.dirname(fileURLToPath(entryUrl));
  const productId = path.basename(here);
  for (const candidate of [
    // 源码平面：入口在 products/<id>/（web dist 在同级 web/dist）。
    path.join(here, 'web', 'dist'),
    // 编译平面 A：入口在仓根 dist/products/<id>/（上溯 3 级到仓根）。
    path.resolve(here, '..', '..', '..', 'products', productId, 'web', 'dist'),
    // 编译平面 B：入口在产品内 products/<id>/dist/products/<id>/（上溯 5 级到仓根）。
    path.resolve(here, '..', '..', '..', '..', '..', 'products', productId, 'web', 'dist'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/** 用系统默认应用打开本地路径。返回空串表示成功，否则是错误消息。 */
export async function shellOpenPath(target: string): Promise<string> {
  const [cmd, args] = openCommand(target, false);
  return spawnDetached(cmd, args);
}

/** 用系统浏览器打开 URL。 */
export async function shellOpenExternal(url: string): Promise<void> {
  const [cmd, args] = openCommand(url, true);
  const error = await spawnDetached(cmd, args);
  if (error) throw new Error(error);
}

function openCommand(target: string, isUrl: boolean): [string, string[]] {
  if (process.platform === 'darwin') return ['open', [target]];
  if (process.platform === 'win32') {
    return isUrl
      ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
      : ['explorer', [target]];
  }
  return ['xdg-open', [target]];
}

/** 返回空串表示成功，否则是错误消息。 */
function spawnDetached(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => resolve(err.message));
      child.on('spawn', () => {
        child.unref();
        resolve('');
      });
    } catch (err) {
      resolve(err instanceof Error ? err.message : String(err));
    }
  });
}