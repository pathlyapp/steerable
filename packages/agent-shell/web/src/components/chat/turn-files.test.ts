/**
 * turn-files 前端模型测试：parseTurnFiles 的形状校验（SSE 事件与持久化
 * 元数据共用一个解析器，坏数据一律 null 而不是半吊子列表），以及路径
 * 分段 / 文件大小的展示辅助，以及分类与分组统计。
 */
import { describe, expect, it } from 'vitest';

import {
  formatFileSize,
  formatIntermediateDisplayPath,
  getDeliverableMeta,
  getTurnFileCategory,
  groupTurnFiles,
  isIgnoredTurnFile,
  parseTurnFiles,
  splitTurnFilePath,
  type TurnFile,
} from './turn-files';

describe('parseTurnFiles', () => {
  it('合法列表原样解析（size 可选）', () => {
    const files = parseTurnFiles([
      { path: '/proj/自我介绍.pptx', kind: 'created', size: 1024 },
      { path: '/proj/README.md', kind: 'modified' },
    ]);
    expect(files).toEqual([
      { path: '/proj/自我介绍.pptx', kind: 'created', size: 1024 },
      { path: '/proj/README.md', kind: 'modified' },
    ]);
  });

  it('空数组 / 非数组 → null（调用方按「无列表」处理）', () => {
    expect(parseTurnFiles([])).toBeNull();
    expect(parseTurnFiles('files')).toBeNull();
    expect(parseTurnFiles(undefined)).toBeNull();
  });

  it('任一条目形状不符 → 整体 null', () => {
    expect(parseTurnFiles([{ path: '/a', kind: 'created' }, { path: 1, kind: 'created' }])).toBeNull();
    expect(parseTurnFiles([{ path: '/a' }])).toBeNull();
    expect(parseTurnFiles([{ path: '/a', kind: 'deleted' }])).toBeNull();
    expect(parseTurnFiles([null])).toBeNull();
  });

  it('保留可选的 additions / deletions / category', () => {
    const files = parseTurnFiles([
      {
        path: '/proj/review_work/build.mjs',
        kind: 'created',
        additions: 110,
        deletions: 0,
        category: 'intermediate',
      },
    ]);
    expect(files).toEqual([
      {
        path: '/proj/review_work/build.mjs',
        kind: 'created',
        additions: 110,
        deletions: 0,
        category: 'intermediate',
      },
    ]);
  });
});

describe('splitTurnFilePath', () => {
  it('POSIX 路径拆成目录 + 文件名', () => {
    expect(splitTurnFilePath('/proj/out/result.txt')).toEqual({
      dir: '/proj/out/',
      name: 'result.txt',
    });
  });

  it('Windows 路径同样可拆', () => {
    expect(splitTurnFilePath('C:\\work\\proj\\a.md')).toEqual({
      dir: 'C:\\work\\proj\\',
      name: 'a.md',
    });
  });

  it('裸文件名没有目录部分；尾部斜杠先归一', () => {
    expect(splitTurnFilePath('a.md')).toEqual({ dir: '', name: 'a.md' });
    expect(splitTurnFilePath('/proj/out/')).toEqual({ dir: '/proj/', name: 'out' });
  });
});

describe('formatFileSize', () => {
  it('按量级取 B / KB / MB；缺省与非法值返回 null', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatFileSize(undefined)).toBeNull();
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize(Number.NaN)).toBeNull();
  });
});

describe('isIgnoredTurnFile', () => {
  it('过滤 Office 临时锁定文件与交换文件', () => {
    expect(isIgnoredTurnFile('/Users/wangtai/Documents/~$公司介绍.pptx')).toBe(true);
    expect(isIgnoredTurnFile('/Users/wangtai/Documents/.DS_Store')).toBe(true);
    expect(isIgnoredTurnFile('/Users/wangtai/Documents/output.tmp')).toBe(true);
    expect(isIgnoredTurnFile('/Users/wangtai/Documents/公司介绍.pptx')).toBe(false);
    expect(isIgnoredTurnFile('/Users/wangtai/Documents/公司介绍.pdf')).toBe(false);
  });
});

describe('getTurnFileCategory & getDeliverableMeta', () => {
  it('产物类型分类正确', () => {
    expect(getTurnFileCategory({ path: '/work/报价方案.xlsx', kind: 'created' })).toBe('deliverable');
    expect(getTurnFileCategory({ path: '/work/公司介绍.pptx', kind: 'created' })).toBe('deliverable');
    expect(getTurnFileCategory({ path: '/work/公司介绍.pdf', kind: 'created' })).toBe('deliverable');
    expect(getTurnFileCategory({ path: '/work/大事记.png', kind: 'created' })).toBe('deliverable');
    expect(getTurnFileCategory({ path: '/work/review_work/build.mjs', kind: 'created' })).toBe('intermediate');
    expect(getTurnFileCategory({ path: '/work/src/index.ts', kind: 'modified' })).toBe('intermediate');
  });

  it('提供正确的展示元数据', () => {
    expect(getDeliverableMeta('/work/报价.xlsx')).toEqual({
      label: 'Spreadsheet',
      extBadge: 'XLSX',
      kind: 'spreadsheet',
      themeColor: 'emerald',
    });
    expect(getDeliverableMeta('/work/演示.pptx')).toEqual({
      label: 'Presentation',
      extBadge: 'PPTX',
      kind: 'presentation',
      themeColor: 'amber',
    });
    expect(getDeliverableMeta('/work/文档.pdf')).toEqual({
      label: 'Document',
      extBadge: 'PDF',
      kind: 'pdf',
      themeColor: 'rose',
    });
    expect(getDeliverableMeta('/work/图片.png')).toEqual({
      label: 'Image',
      extBadge: 'PNG',
      kind: 'image',
      themeColor: 'purple',
    });
  });
});

describe('formatIntermediateDisplayPath', () => {
  it('提取清晰的相对路径', () => {
    expect(
      formatIntermediateDisplayPath('/Users/wangtai/code/proj/review_work/build_clean.mjs'),
    ).toBe('review_work/build_clean.mjs');
    expect(
      formatIntermediateDisplayPath('/Users/wangtai/code/proj/src/components/Agent.tsx'),
    ).toBe('src/components/Agent.tsx');
  });
});

describe('groupTurnFiles', () => {
  it('正确拆分最终文件与中间修改文件，并计算 diff 增删总数', () => {
    const rawFiles: TurnFile[] = [
      { path: '/work/中国矿产AI智能体项目报价方案_99.9万元_客户版.xlsx', kind: 'created', size: 10240 },
      { path: '/work/~$公司介绍.pptx', kind: 'created', size: 165 }, // 应被过滤
      { path: '/work/review_work/help_worksheet_delete.mjs', kind: 'created', additions: 4, deletions: 0 },
      { path: '/work/review_work/build_clean_current_quote.mjs', kind: 'created', additions: 110, deletions: 0 },
      { path: '/work/review_work/audit_clean_quote.mjs', kind: 'created', additions: 91, deletions: 0 },
    ];

    const { deliverables, intermediates, totalAdditions, totalDeletions } = groupTurnFiles(rawFiles);

    expect(deliverables).toHaveLength(1);
    expect(deliverables[0].path).toBe('/work/中国矿产AI智能体项目报价方案_99.9万元_客户版.xlsx');
    expect(deliverables[0].category).toBe('deliverable');

    expect(intermediates).toHaveLength(3);
    expect(totalAdditions).toBe(205);
    expect(totalDeletions).toBe(0);
  });
});
