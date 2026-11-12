/**
 * collectTurnFiles（回合产物文件收集）测试。
 *
 * 真实 fs + 临时目录，不 mock：扫描器本身就是文件系统边界。时间线靠
 * 「先建旧文件 → 记下 sinceMs → 再动新文件」排开，mtime 用 appendFile
 * 真实推进（不手设 utimes，避免与 birthtime 语义打架）。
 *
 * kind 标签跟生产代码同一条规则：birthtimeMs >= sinceMs 才是 created。
 * Linux 常暴露 > 0 但早于 sinceMs 的截断 birthtime，不能只看 birthtimeMs > 0。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  classifyFileCategory,
  collectTurnFiles,
  isIgnoredFileName,
  parseDiffStats,
} from '../../src/local-backend/turn-files.js';

let root: string;

/**
 * 扫描器对 mtime/birthtime 有 1s 容差（Linux 截断）。「旧文件应被排除」
 * 的用例必须等过这 1s，否则刚写入的旧文件会被容差收进来。
 */
async function sinceAfterExisting(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  return Date.now();
}

function turnStart(): number {
  return Date.now();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-files-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('collectTurnFiles 工作区扫描', () => {
  it('回合内新建的文件被收集，kind 按 birthtime 能力标 created/modified', async () => {
    const sinceMs = turnStart();
    const created = path.join(root, '自我介绍.pptx');
    await fs.writeFile(created, 'ppt-bytes');

    const files = await collectTurnFiles({ roots: [root], sinceMs });

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(created);
    expect(files[0].size).toBe(9);
    const stat = await fs.stat(created);
    expect(files[0].kind).toBe(stat.birthtimeMs >= sinceMs ? 'created' : 'modified');
  });

  it('回合前已存在、回合内被修改的文件标 modified', async () => {
    const existing = path.join(root, 'README.md');
    await fs.writeFile(existing, 'old');
    const sinceMs = await sinceAfterExisting();
    await fs.appendFile(existing, '-new');

    const files = await collectTurnFiles({ roots: [root], sinceMs });

    expect(files).toEqual([
      {
        path: existing,
        kind: 'modified',
        size: 7,
        category: 'intermediate',
        selection: 'resolved',
      },
    ]);
  });

  it('回合前存在且未触碰的文件不出现', async () => {
    await fs.writeFile(path.join(root, 'old.txt'), 'stale');
    const sinceMs = await sinceAfterExisting();

    const files = await collectTurnFiles({ roots: [root], sinceMs });

    expect(files).toEqual([]);
  });

  it('忽略目录（node_modules / .git / .steerable）里的新文件不出现', async () => {
    const sinceMs = turnStart();
    for (const dir of ['node_modules', '.git', '.steerable']) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
      await fs.writeFile(path.join(root, dir, 'noise.js'), 'x');
    }
    await fs.writeFile(path.join(root, 'real.txt'), 'y');

    const files = await collectTurnFiles({ roots: [root], sinceMs });

    expect(files.map((f) => f.path)).toEqual([path.join(root, 'real.txt')]);
  });

  it('不跟随符号链接（指到根外的目录不被扫）', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-files-outside-'));
    try {
      const sinceMs = turnStart();
      await fs.writeFile(path.join(outside, 'leak.txt'), 'x');
      await fs.symlink(outside, path.join(root, 'linked'));

      const files = await collectTurnFiles({ roots: [root], sinceMs });

      expect(files).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('多个根的结果合并并按路径排序', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-files-pack-'));
    try {
      const sinceMs = turnStart();
      const b = path.join(other, 'b.md');
      const a = path.join(root, 'a.md');
      await fs.writeFile(b, 'b');
      await fs.writeFile(a, 'a');

      const files = await collectTurnFiles({ roots: [root, other], sinceMs });

      expect(files.map((f) => f.path)).toEqual([a, b].sort((x, y) => x.localeCompare(y)));
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('扫描窗口内被删掉的文件不出现', async () => {
    const sinceMs = turnStart();
    const gone = path.join(root, 'gone.txt');
    await fs.writeFile(gone, 'x');
    await fs.rm(gone);

    const files = await collectTurnFiles({ roots: [root], sinceMs });

    expect(files).toEqual([]);
  });
});

describe('collectTurnFiles 写工具参数并集', () => {
  it('可写根之外的 local_write_file 产物经参数并集进入列表', async () => {
    // 扫描根是子目录；写工具落盘到根之外（「完整权限」模式的 Downloads 场景）。
    const sub = path.join(root, 'project');
    await fs.mkdir(sub);
    const outsideFile = path.join(root, 'downloads-report.pdf');
    const sinceMs = turnStart();
    await fs.writeFile(outsideFile, 'pdf');

    const files = await collectTurnFiles({
      roots: [sub],
      sinceMs,
      actions: [
        { tool: 'local_write_file', arguments: { path: outsideFile }, success: true },
      ],
    });

    expect(files.map((f) => f.path)).toEqual([outsideFile]);
  });

  it('相对路径参数按 projectRoot 解析', async () => {
    const sinceMs = turnStart();
    const rel = path.join(root, 'out', 'result.txt');
    await fs.mkdir(path.dirname(rel), { recursive: true });
    await fs.writeFile(rel, 'r');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      projectRoot: root,
      actions: [
        { tool: 'local_edit_file', arguments: { path: 'out/result.txt' }, success: true },
      ],
    });

    expect(files.map((f) => f.path)).toEqual([rel]);
  });

  it('success === false 的写调用不进列表', async () => {
    const sinceMs = turnStart();
    const target = path.join(root, 'failed.txt');
    await fs.writeFile(target, 'partial');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        { tool: 'local_write_file', arguments: { path: target }, success: false },
      ],
    });

    expect(files).toEqual([]);
  });

  it('只读工具（local_read_file 等）的参数不进列表', async () => {
    const sinceMs = turnStart();
    const target = path.join(root, 'read.txt');
    await fs.writeFile(target, 'r');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        { tool: 'local_read_file', arguments: { path: target }, success: true },
      ],
    });

    expect(files).toEqual([]);
  });

  it('写工具指向的文件已不存在时跳过', async () => {
    const sinceMs = turnStart();
    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        { tool: 'local_write_file', arguments: { path: path.join(root, 'ghost.txt') }, success: true },
      ],
    });

    expect(files).toEqual([]);
  });

  it('扫描与参数并集按路径去重', async () => {
    const sinceMs = turnStart();
    const target = path.join(root, 'dup.txt');
    await fs.writeFile(target, 'd');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      actions: [
        { tool: 'local_write_file', arguments: { path: target }, success: true },
      ],
    });

    expect(files).toHaveLength(1);
  });
});

describe('collectTurnFiles exec cwd 浅扫描', () => {
  it('显式 cwd 在递归根之外：顶层新文件被收集，子目录与点文件被跳过', async () => {
    // 「完整权限」/无围栏场景：脚本在 cwd 落盘，cwd 不在任何递归根里。
    const proj = path.join(root, 'project');
    const work = path.join(root, 'work');
    await fs.mkdir(proj);
    await fs.mkdir(path.join(work, 'sub'), { recursive: true });
    const sinceMs = turnStart();
    const top = path.join(work, '报告.pptx');
    await fs.writeFile(top, 'ppt');
    await fs.writeFile(path.join(work, 'sub', 'nested.pptx'), 'ppt');
    await fs.writeFile(path.join(work, '.hidden'), 'x');

    const files = await collectTurnFiles({
      roots: [proj],
      sinceMs,
      actions: [
        { tool: 'local_exec_shell', arguments: { command: 'python3 gen.py', cwd: work }, success: true },
      ],
    });

    expect(files.map((f) => f.path)).toEqual([top]);
  });

  it('缺省 cwd + 无项目对话：回落到 home 顶层（无项目 exec 产物最常见的落点）', async () => {
    const home = path.join(root, 'fake-home');
    await fs.mkdir(home);
    const sinceMs = turnStart();
    const ppt = path.join(home, '自我介绍_张三.pptx');
    await fs.writeFile(ppt, 'ppt');
    await fs.writeFile(path.join(home, '.zsh_history'), 'noise');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      homeDir: home,
      actions: [
        { tool: 'local_exec_shell', arguments: { command: 'python3 gen_ppt.py' }, success: true },
      ],
    });

    expect(files.map((f) => f.path)).toEqual([ppt]);
  });

  it('缺省 cwd + 有项目：回落到项目根，由递归扫描覆盖（不重复）', async () => {
    const proj = path.join(root, 'project');
    await fs.mkdir(proj);
    const sinceMs = turnStart();
    const out = path.join(proj, 'out.txt');
    await fs.writeFile(out, 'o');

    const files = await collectTurnFiles({
      roots: [proj],
      sinceMs,
      projectRoot: proj,
      actions: [
        { tool: 'local_run_snippet', arguments: { language: 'python', code: 'open("out.txt","w")' }, success: true },
      ],
    });

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(out);
  });

  it('非 exec 工具的 cwd 字段不触发浅扫描', async () => {
    const work = path.join(root, 'work');
    await fs.mkdir(work);
    const sinceMs = turnStart();
    await fs.writeFile(path.join(work, 'x.txt'), 'x');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        { tool: 'local_read_file', arguments: { path: work, cwd: work }, success: true },
      ],
    });

    expect(files).toEqual([]);
  });
});

describe('collectTurnFiles 命令文本路径字面量', () => {
  it('python 代码里引号包裹的绝对路径（prs.save 场景）被收集', async () => {
    // 产物写到与 cwd 无关的位置：只有命令文本里出现过这个路径。
    const cwd = path.join(root, 'cwd');
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(cwd);
    await fs.mkdir(elsewhere);
    const sinceMs = turnStart();
    const ppt = path.join(elsewhere, '自我介绍_张三.pptx');
    await fs.writeFile(ppt, 'ppt');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        {
          tool: 'local_exec_shell',
          arguments: { command: `python3 -c "from pptx import Presentation; prs.save('${ppt}')"`, cwd },
          success: true,
        },
      ],
    });

    expect(files.map((f) => f.path)).toEqual([ppt]);
  });

  it('裸路径（shell 重定向）与 run_snippet 的 code 字段都被提取', async () => {
    const cwd = path.join(root, 'cwd');
    await fs.mkdir(cwd);
    const sinceMs = turnStart();
    const csv = path.join(root, 'report.csv');
    const png = path.join(root, 'chart.png');
    await fs.writeFile(csv, 'a,b');
    await fs.writeFile(png, 'png');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        { tool: 'local_exec_shell', arguments: { command: `python3 gen.py > ${csv}`, cwd }, success: true },
        { tool: 'local_run_snippet', arguments: { language: 'python', code: `fig.savefig("${png}")`, cwd }, success: true },
      ],
    });

    expect(files.map((f) => f.path)).toEqual([csv, png].sort((a, b) => a.localeCompare(b)));
  });

  it('~/ 前缀展开到 home 目录', async () => {
    const home = path.join(root, 'fake-home');
    const cwd = path.join(root, 'cwd');
    await fs.mkdir(home);
    await fs.mkdir(cwd);
    const sinceMs = turnStart();
    const doc = path.join(home, 'notes.md');
    await fs.writeFile(doc, 'n');

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      homeDir: home,
      actions: [
        { tool: 'local_exec_shell', arguments: { command: 'python3 gen.py --out ~/notes.md', cwd }, success: true },
      ],
    });

    expect(files.map((f) => f.path)).toEqual([doc]);
  });

  it('命令里提到的旧文件（回合前存在且未动）不被误收', async () => {
    const cwd = path.join(root, 'cwd');
    await fs.mkdir(cwd);
    const stale = path.join(root, 'stale.pptx');
    await fs.writeFile(stale, 'old');
    const sinceMs = await sinceAfterExisting();

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        { tool: 'local_exec_shell', arguments: { command: `ls -la ${stale}`, cwd }, success: true },
      ],
    });

    expect(files).toEqual([]);
  });

  it('不存在的路径与指向目录的字面量都被 stat 把关跳过', async () => {
    const cwd = path.join(root, 'cwd');
    const bundle = path.join(root, 'Demo.app');
    await fs.mkdir(cwd);
    await fs.mkdir(bundle);
    const sinceMs = turnStart();

    const files = await collectTurnFiles({
      roots: [],
      sinceMs,
      actions: [
        {
          tool: 'local_exec_shell',
          arguments: {
            command: `open ${bundle} && ls ${path.join(root, 'ghost.pdf')}`,
            cwd,
          },
          success: true,
        },
      ],
    });

    expect(files).toEqual([]);
  });

  it('排除 Office 临时锁定文件与交换文件（如 ~$公司介绍.pptx）', async () => {
    const sinceMs = turnStart();
    const realFile = path.join(root, '公司介绍.pptx');
    const lockFile = path.join(root, '~$公司介绍.pptx');
    const tmpFile = path.join(root, 'output.tmp');
    await fs.writeFile(realFile, 'real-content');
    await fs.writeFile(lockFile, 'lock-content');
    await fs.writeFile(tmpFile, 'temp-content');

    const files = await collectTurnFiles({ roots: [root], sinceMs });

    expect(files.map((f) => path.basename(f.path))).toEqual(['公司介绍.pptx']);
    expect(isIgnoredFileName('~$公司介绍.pptx')).toBe(true);
    expect(isIgnoredFileName('.DS_Store')).toBe(true);
    expect(isIgnoredFileName('test.tmp')).toBe(true);
    expect(isIgnoredFileName('公司介绍.pptx')).toBe(false);
  });

  it('预览 PDF 和幻灯片都点名时只留可编辑文件；只点名预览时改升幻灯片', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '4432-自我介绍.pptx');
    const preview = path.join(root, '4432-自我介绍-预览.pdf');
    const shot = path.join(root, '_预览_大事记页.png');
    await fs.writeFile(deck, 'ppt');
    await fs.writeFile(preview, 'pdf');
    await fs.writeFile(shot, 'png');

    const both = await collectTurnFiles({
      roots: [root],
      sinceMs,
      projectRoot: root,
      actions: [
        {
          tool: 'present_files',
          arguments: {
            files: [
              { path: deck, description: '10 页可编辑自我介绍' },
              { path: preview, description: '图像版预览 PDF，用于快速查看与分享' },
            ],
          },
          success: true,
        },
      ],
    });
    expect(
      Object.fromEntries(
        both.map((f) => [path.basename(f.path), { category: f.category, description: f.description ?? null }]),
      ),
    ).toEqual({
      '4432-自我介绍-预览.pdf': { category: 'intermediate', description: null },
      '4432-自我介绍.pptx': { category: 'deliverable', description: '10 页可编辑自我介绍' },
      '_预览_大事记页.png': { category: 'intermediate', description: null },
    });

    const previewOnly = await collectTurnFiles({
      roots: [root],
      sinceMs,
      projectRoot: root,
      actions: [
        {
          tool: 'present_files',
          arguments: { files: [{ path: preview, description: '图像版预览' }] },
          success: true,
        },
      ],
    });
    expect(previewOnly.find((f) => f.path === deck)?.category).toBe('deliverable');
    expect(previewOnly.find((f) => f.path === preview)?.category).toBe('intermediate');
  });

  it('生成流程的结构化 purpose 高于最终引用和文件名启发式', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '介绍.pptx');
    const preview = path.join(root, '介绍-预览.pdf');
    await fs.writeFile(deck, 'deck');
    await fs.writeFile(preview, 'preview');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      finalText: `[下载幻灯片](<${deck}>) [下载预览](<${preview}>)`,
      actions: [
        {
          tool: 'artifact_generator',
          result: {
            artifacts: [
              {
                path: deck,
                purpose: 'output',
                description: '可编辑幻灯片',
              },
              { path: preview, purpose: 'preview' },
            ],
          },
          success: true,
        },
      ],
    });

    expect(
      files.map((file) => ({
        name: path.basename(file.path),
        category: file.category,
        source: file.deliverySource ?? null,
        description: file.description ?? null,
      })),
    ).toEqual([
      {
        name: '介绍-预览.pdf',
        category: 'intermediate',
        source: null,
        description: null,
      },
      {
        name: '介绍.pptx',
        category: 'deliverable',
        source: 'generation',
        description: '可编辑幻灯片',
      },
    ]);
  });

  it('生成流程明确声明两个独立 output 时不折叠同名 PDF', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '介绍.pptx');
    const pdf = path.join(root, '介绍.pdf');
    await fs.writeFile(deck, 'deck');
    await fs.writeFile(pdf, 'pdf');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      actions: [
        {
          result: {
            data: {
              artifacts: [
                { path: deck, purpose: 'output' },
                { path: pdf, purpose: 'output' },
              ],
            },
          },
          success: true,
        },
      ],
    });

    expect(files.map((file) => [path.basename(file.path), file.category, file.deliverySource])).toEqual([
      ['介绍.pdf', 'deliverable', 'generation'],
      ['介绍.pptx', 'deliverable', 'generation'],
    ]);
  });

  it('最终回复明确引用的同名 PDF 与幻灯片都保留', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '介绍.pptx');
    const pdf = path.join(root, '介绍.pdf');
    await fs.writeFile(deck, 'deck');
    await fs.writeFile(pdf, 'pdf');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      finalText:
        `可编辑版：\`${deck}\`\n` +
        `分享版：:codex-file-citation{path="${pdf}" purpose="output"}`,
    });

    expect(files.map((file) => [path.basename(file.path), file.category, file.deliverySource])).toEqual([
      ['介绍.pdf', 'deliverable', 'final-reference'],
      ['介绍.pptx', 'deliverable', 'final-reference'],
    ]);
  });

  it('最终回复的普通路径引用仍会纠正明显的跨目录预览 PDF', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '王泰-自我介绍-v4.pptx');
    const preview = path.join(root, 'preview4', '王泰-自我介绍-v4-预览.pdf');
    await fs.mkdir(path.dirname(preview));
    await fs.writeFile(deck, 'deck');
    await fs.writeFile(preview, 'preview');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      finalText: `- \`${deck}\`\n- \`${preview}\``,
    });

    expect(
      files.map((file) => [path.basename(file.path), file.category, file.deliverySource ?? null]),
    ).toEqual([
      ['王泰-自我介绍-v4-预览.pdf', 'intermediate', null],
      ['王泰-自我介绍-v4.pptx', 'deliverable', 'final-reference'],
    ]);
  });

  it('present_files 的显式 purpose 优先，旧调用才使用启发式纠错', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '介绍.pptx');
    const preview = path.join(root, '介绍-预览.pdf');
    await fs.writeFile(deck, 'deck');
    await fs.writeFile(preview, 'preview');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      actions: [
        {
          tool: 'present_files',
          arguments: {
            files: [
              { path: deck, purpose: 'output' },
              { path: preview, purpose: 'preview' },
            ],
          },
          success: true,
        },
      ],
    });

    expect(files.map((file) => [path.basename(file.path), file.category, file.deliverySource ?? null])).toEqual([
      ['介绍-预览.pdf', 'intermediate', null],
      ['介绍.pptx', 'deliverable', 'present-files'],
    ]);
  });

  it('没点名时只自动升办公文件；单独一张图会升，超过四张不猜', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '介绍.pptx');
    const preview = path.join(root, '介绍-预览.pdf');
    await fs.writeFile(deck, 'ppt');
    await fs.writeFile(preview, 'pdf');
    const withDeck = await collectTurnFiles({ roots: [root], sinceMs });
    expect(withDeck.map((f) => [path.basename(f.path), f.category])).toEqual([
      ['介绍-预览.pdf', 'intermediate'],
      ['介绍.pptx', 'deliverable'],
    ]);

    const posterDir = path.join(root, 'posters');
    await fs.mkdir(posterDir);
    await fs.writeFile(path.join(posterDir, '海报.png'), 'png');
    const oneImage = await collectTurnFiles({ roots: [posterDir], sinceMs });
    expect(oneImage.map((f) => f.category)).toEqual(['deliverable']);

    const manyDir = path.join(root, 'shots');
    await fs.mkdir(manyDir);
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']) {
      await fs.writeFile(path.join(manyDir, name), name);
    }
    const many = await collectTurnFiles({ roots: [manyDir], sinceMs });
    expect(many.every((f) => f.category === 'intermediate')).toBe(true);
  });

  it('文档和同名 PDF 都点名时两张卡片都留', async () => {
    const sinceMs = turnStart();
    const doc = path.join(root, '报告.docx');
    const pdf = path.join(root, '报告.pdf');
    await fs.writeFile(doc, 'doc');
    await fs.writeFile(pdf, 'pdf');
    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      actions: [
        {
          tool: 'present_files',
          arguments: { files: [{ path: doc }, { path: pdf }] },
          success: true,
        },
      ],
    });
    expect(files.map((f) => f.category)).toEqual(['deliverable', 'deliverable']);
  });

  it('NFD 声明路径和扫描到的 NFC 文件名是同一份交付', async () => {
    const sinceMs = turnStart();
    const name = '公司介绍.pptx';
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, 'ppt');
    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      projectRoot: root,
      actions: [
        {
          tool: 'present_files',
          arguments: {
            files: [{ path: path.join(root, name.normalize('NFD')), description: '12 页' }],
          },
          success: true,
        },
      ],
    });
    const decks = files.filter((f) => path.basename(f.path).normalize('NFC') === name);
    expect(decks).toHaveLength(1);
    expect(decks[0].category).toBe('deliverable');
  });

  it('正确分类交付物与中间修改文件', () => {
    expect(classifyFileCategory('/work/报价方案.xlsx')).toBe('deliverable');
    expect(classifyFileCategory('/work/介绍.pptx')).toBe('deliverable');
    expect(classifyFileCategory('/work/报告.pdf')).toBe('deliverable');
    expect(classifyFileCategory('/work/预览图.png')).toBe('deliverable');
    expect(classifyFileCategory('/work/review_work/build.mjs')).toBe('intermediate');
    expect(classifyFileCategory('/work/scripts/generate.py')).toBe('intermediate');
    expect(classifyFileCategory('/work/src/index.ts')).toBe('intermediate');
  });

  it('有 present_files 声明时，声明的是交付物，其余一律是中间文件', async () => {
    const sinceMs = turnStart();
    const deck = path.join(root, '公司介绍.pptx');
    const preview = path.join(root, '_预览_大事记页.png');
    const pdf = path.join(root, '公司介绍.pdf');
    await fs.writeFile(deck, 'ppt');
    await fs.writeFile(preview, 'png');
    await fs.writeFile(pdf, 'pdf');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      projectRoot: root,
      actions: [
        {
          tool: 'present_files',
          arguments: { files: [{ path: '公司介绍.pptx', description: '12 页介绍' }] },
          success: true,
        },
      ],
    });

    expect(
      files.map((f) => [path.basename(f.path), f.category, f.description ?? null]),
    ).toEqual([
      ['_预览_大事记页.png', 'intermediate', null],
      ['公司介绍.pdf', 'intermediate', null],
      ['公司介绍.pptx', 'deliverable', '12 页介绍'],
    ]);
  });

  it('声明本轮没动过的已有文件也会列出；失败的声明调用不生效', async () => {
    const existing = path.join(root, '年度报告.docx');
    await fs.writeFile(existing, 'docx');
    const sinceMs = await sinceAfterExisting();
    const ghost = path.join(root, 'ghost.xlsx');

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      actions: [
        { tool: 'present_files', arguments: { files: [{ path: existing }] }, success: true },
        { tool: 'present_files', arguments: { files: [{ path: ghost }] }, success: false },
      ],
    });

    expect(files).toEqual([
      {
        path: existing,
        kind: 'modified',
        size: 4,
        category: 'deliverable',
        selection: 'resolved',
        deliverySource: 'present-files',
      },
    ]);
  });

  it('从 diff 中统计增删行数并在 collectTurnFiles 中注入', async () => {
    const sinceMs = turnStart();
    const file = path.join(root, 'src', 'util.ts');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'export function add() {}');

    const diff = `--- a/src/util.ts\n+++ b/src/util.ts\n@@ -1,1 +1,4 @@\n export function add() {}\n+export function sub() {}\n+export function mul() {}\n-export function old() {}`;
    const stats = parseDiffStats(diff);
    expect(stats).toEqual({ additions: 2, deletions: 1 });

    const files = await collectTurnFiles({
      roots: [root],
      sinceMs,
      actions: [
        {
          tool: 'local_edit_file',
          arguments: { path: file },
          result: { success: true, diff },
          success: true,
        },
      ],
    });

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(file);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
  });
});
