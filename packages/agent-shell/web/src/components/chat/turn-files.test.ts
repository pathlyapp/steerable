/**
 * turn-files 前端模型测试：parseTurnFiles 的形状校验（SSE 事件与持久化
 * 元数据共用一个解析器，坏数据一律 null 而不是半吊子列表），以及路径
 * 分段 / 文件大小的展示辅助，以及分类与分组统计。
 */
import { describe, expect, it } from 'vitest';

import {
  followedPreviewPath,
  formatFileSize,
  formatIntermediateDisplayPath,
  getDeliverableMeta,
  getTurnFileCategory,
  groupTurnFiles,
  isIgnoredTurnFile,
  parseTurnFiles,
  previewPathForTurn,
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

  it('保留后端已经解析的选择状态与证据来源', () => {
    expect(
      parseTurnFiles([
        {
          path: '/proj/报告.pdf',
          kind: 'created',
          category: 'deliverable',
          selection: 'resolved',
          deliverySource: 'final-reference',
        },
      ]),
    ).toEqual([
      {
        path: '/proj/报告.pdf',
        kind: 'created',
        category: 'deliverable',
        selection: 'resolved',
        deliverySource: 'final-reference',
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
    expect(isIgnoredTurnFile('/home/dev/Documents/~$公司介绍.pptx')).toBe(true);
    expect(isIgnoredTurnFile('/home/dev/Documents/.DS_Store')).toBe(true);
    expect(isIgnoredTurnFile('/home/dev/Documents/output.tmp')).toBe(true);
    expect(isIgnoredTurnFile('/home/dev/Documents/公司介绍.pptx')).toBe(false);
    expect(isIgnoredTurnFile('/home/dev/Documents/公司介绍.pdf')).toBe(false);
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
      formatIntermediateDisplayPath('/home/dev/code/proj/review_work/build_clean.mjs'),
    ).toBe('review_work/build_clean.mjs');
    expect(
      formatIntermediateDisplayPath('/home/dev/code/proj/src/components/Agent.tsx'),
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

  it('同名预览 PDF 不和幻灯片一起占卡片；只标了预览时改升幻灯片', () => {
    const deck = '/work/4432-自我介绍.pptx';
    const preview = '/work/4432-自我介绍-预览.pdf';
    const both = groupTurnFiles([
      { path: deck, kind: 'created', category: 'deliverable', description: '10 页可编辑自我介绍' },
      {
        path: preview,
        kind: 'created',
        category: 'deliverable',
        description: '图像版预览 PDF，用于快速查看与分享',
      },
    ]);
    expect(both.deliverables.map((f) => f.path)).toEqual([deck]);
    expect(both.intermediates.map((f) => f.path)).toEqual([preview]);

    const previewOnly = groupTurnFiles([
      { path: preview, kind: 'created', category: 'deliverable' },
      { path: deck, kind: 'created', category: 'intermediate' },
    ]);
    expect(previewOnly.deliverables.map((f) => f.path)).toEqual([deck]);
    expect(previewOnly.intermediates.map((f) => f.path)).toEqual([preview]);
  });

  it('后端已解析时保留结构化声明的两个同名 output', () => {
    const deck = '/work/介绍.pptx';
    const pdf = '/work/介绍.pdf';
    const grouped = groupTurnFiles([
      {
        path: deck,
        kind: 'created',
        category: 'deliverable',
        selection: 'resolved',
        deliverySource: 'generation',
      },
      {
        path: pdf,
        kind: 'created',
        category: 'deliverable',
        selection: 'resolved',
        deliverySource: 'generation',
      },
    ]);

    expect(grouped.deliverables.map((file) => file.path)).toEqual([deck, pdf]);
    expect(grouped.intermediates).toEqual([]);
  });

  it('旧历史记录也折叠预览子目录里的同名 PDF', () => {
    const deck = '/work/王泰-自我介绍-v4.pptx';
    const preview = '/work/preview4/王泰-自我介绍-v4-预览.pdf';
    const grouped = groupTurnFiles([
      { path: preview, kind: 'created', category: 'deliverable' },
      { path: deck, kind: 'created', category: 'deliverable' },
    ]);

    expect(grouped.deliverables.map((file) => file.path)).toEqual([deck]);
    expect(grouped.intermediates.map((file) => file.path)).toEqual([preview]);
  });
});

describe('previewPathForTurn', () => {
  it('交付的幻灯片优先于同轮的脚本和 Markdown', () => {
    expect(previewPathForTurn([
      { path: '/work/build.py', kind: 'created' },
      { path: '/work/notes.md', kind: 'created' },
      { path: '/work/deck.pptx', kind: 'created', category: 'deliverable' },
    ])).toBe('/work/deck.pptx');
  });

  it('没有可预览文件时返回空', () => {
    expect(previewPathForTurn([
      { path: '/work/build.py', kind: 'modified' },
    ])).toBeNull();
    expect(previewPathForTurn(undefined)).toBeNull();
  });
});

describe('followedPreviewPath', () => {
  const older = { id: 'a1', files: [{ path: '/work/old.md', kind: 'created' as const }] };
  const latest = { id: 'a2', files: [{ path: '/work/deck.pptx', kind: 'created' as const, category: 'deliverable' as const }] };

  it('停在底部时用最近一轮能预览的文件', () => {
    expect(followedPreviewPath([older, { id: 'a-empty' }, latest], {
      atBottom: true,
      focusedId: 'a1',
    })).toEqual({ messageId: 'a2', path: '/work/deck.pptx' });
  });

  it('往上翻时只看当前这条，没有文件就不改', () => {
    expect(followedPreviewPath([older, latest], {
      atBottom: false,
      focusedId: 'a1',
    })).toEqual({ messageId: 'a1', path: '/work/old.md' });
    expect(followedPreviewPath([older, { id: 'a-empty' }], {
      atBottom: false,
      focusedId: 'a-empty',
    })).toBeNull();
  });
});
