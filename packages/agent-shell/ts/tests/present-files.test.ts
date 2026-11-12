/**
 * present_files：只接受已存在的普通文件，路径按项目根解析，任一不合格即
 * 整次失败并说明原因；经 ToolRouter 分发且进入模型可见的只读工具列表。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executePresentFiles, resolvePresentedPath } from '../src/present-files.js';
import { ToolRouter } from '../src/tool-router.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'present-files-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('executePresentFiles', () => {
  it('相对路径按项目根解析，返回绝对路径与说明', async () => {
    await fs.writeFile(path.join(root, '报价.xlsx'), 'x');

    const result = await executePresentFiles(
      { files: [{ path: '报价.xlsx', description: '客户版报价' }] },
      root,
    );

    expect(result).toEqual({
      success: true,
      presented: [{ path: path.join(root, '报价.xlsx'), description: '客户版报价' }],
    });
  });

  it('保留 output / preview / intermediate 的结构化用途', async () => {
    await fs.writeFile(path.join(root, '介绍.pptx'), 'deck');
    await fs.writeFile(path.join(root, '介绍-预览.pdf'), 'preview');

    const result = await executePresentFiles(
      {
        files: [
          { path: '介绍.pptx', purpose: 'output' },
          { path: '介绍-预览.pdf', purpose: 'preview' },
        ],
      },
      root,
    );

    expect(result).toEqual({
      success: true,
      presented: [
        { path: path.join(root, '介绍.pptx'), purpose: 'output' },
        { path: path.join(root, '介绍-预览.pdf'), purpose: 'preview' },
      ],
    });
  });

  it('文件不存在、是目录、或无项目根的相对路径：整次失败并逐个说明', async () => {
    await fs.mkdir(path.join(root, 'out'));
    await fs.writeFile(path.join(root, 'ok.pdf'), 'p');

    const result = await executePresentFiles(
      {
        files: [
          { path: path.join(root, 'ok.pdf') },
          { path: path.join(root, 'missing.pptx') },
          { path: path.join(root, 'out') },
        ],
      },
      root,
    );
    expect(result.success).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('missing.pptx: file not found');
    expect(error).toContain(`${path.join(root, 'out')}: not a regular file`);

    const relative = await executePresentFiles({ files: [{ path: 'a.pdf' }] }, null);
    expect(relative).toEqual({
      success: false,
      error: 'Cannot present: a.pdf: use an absolute path (no project root to resolve a relative path).',
    });
  });

  it('空列表与超过 4 个文件都被拒绝', async () => {
    expect(await executePresentFiles({ files: [] }, root)).toMatchObject({ success: false });
    const five = Array.from({ length: 5 }, (_, i) => ({ path: path.join(root, `${i}.pdf`) }));
    expect(await executePresentFiles({ files: five }, root)).toMatchObject({
      success: false,
      error: expect.stringContaining('at most 4'),
    });
  });
});

describe('resolvePresentedPath', () => {
  it('展开 ~/ 到 home', () => {
    expect(resolvePresentedPath('~/Downloads/a.pdf', null, '/home/u')).toBe(
      path.join('/home/u', 'Downloads/a.pdf'),
    );
  });
});

describe('ToolRouter 接线', () => {
  it('present_files 以只读模式注册，并经 execute 分发', async () => {
    const router = new ToolRouter({} as never, { list: () => [] } as never);
    expect(router.getSchemaByName('present_files')?.mode).toBe('read');

    await fs.writeFile(path.join(root, 'r.docx'), 'd');
    const result = await router.execute(
      { name: 'present_files', arguments: { files: [{ path: 'r.docx' }] } },
      { projectRoot: root },
    );
    expect(result).toEqual({ success: true, presented: [{ path: path.join(root, 'r.docx') }] });
  });
});
