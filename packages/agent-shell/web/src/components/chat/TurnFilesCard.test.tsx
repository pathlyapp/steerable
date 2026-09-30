/**
 * TurnFilesCard 契约（Codex 样式）：
 * 1. 最终文件（Deliverables）：展示为独立文件卡片（含图标、类型标签如 Presentation · PPTX、Open in 下拉按钮）；
 * 2. 中间修改文件（Edited files）：展示为 Edited N files 卡片，含增删统计与 Review 按钮；
 * 3. 过滤临时锁定文件（如 ~$*.pptx）；
 * 4. 点击文件或打开按钮均调 openLocalPath 用系统默认应用打开；
 * 5. 打开失败在卡片内给出原因；空列表不渲染。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalPath } from '@/lib/local-api';
import { TurnFilesCard } from './TurnFilesCard';
import type { TurnFile } from './turn-files';

vi.mock('@/lib/local-api', () => ({
  openLocalPath: vi.fn(async () => ({ success: true })),
}));

const openLocalPathMock = vi.mocked(openLocalPath);

afterEach(() => {
  cleanup();
  openLocalPathMock.mockClear();
  openLocalPathMock.mockResolvedValue({ success: true });
});

function makeFile(overrides: Partial<TurnFile> = {}): TurnFile {
  return {
    path: '/proj/自我介绍.pptx',
    kind: 'created',
    size: 2048,
    ...overrides,
  };
}

describe('TurnFilesCard', () => {
  it('空列表或仅临时锁定文件时不渲染', () => {
    const { container: empty } = render(<TurnFilesCard files={[]} />);
    expect(empty.querySelector('[data-turn-files]')).toBeNull();

    const { container: locked } = render(
      <TurnFilesCard files={[makeFile({ path: '/proj/~$自我介绍.pptx' })]} />,
    );
    expect(locked.querySelector('[data-turn-files]')).toBeNull();
  });

  it('分开渲染最终交付文件与中间修改文件（Codex 样式）', () => {
    render(
      <TurnFilesCard
        files={[
          makeFile(), // 最终文件：自我介绍.pptx
          makeFile({
            path: '/proj/review_work/build.mjs',
            kind: 'created',
            additions: 110,
            deletions: 0,
          }),
        ]}
      />,
    );

    // 最终文件卡片
    expect(screen.getByText('自我介绍.pptx')).toBeTruthy();
    expect(screen.getByText('Presentation · PPTX')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('Open with')).toBeTruthy();
    expect(document.querySelector('[data-deliverable-card]')).toBeTruthy();

    // 中间修改文件卡片（默认折叠，点击 查看详情 展开）
    expect(screen.getByText('Changed 1 files')).toBeTruthy();
    expect(screen.getByText('View details')).toBeTruthy();
    expect(document.querySelector('[data-edited-files-card]')).toBeTruthy();
    expect(screen.queryByText('review_work/build.mjs')).toBeNull();

    // 点击 查看详情 展开文件列表
    fireEvent.click(screen.getByText('View details'));
    expect(screen.getAllByText('+110').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-0').length).toBeGreaterThan(0);
    expect(screen.getByText('review_work/build.mjs')).toBeTruthy();

    // 再次点击折叠收起
    fireEvent.click(screen.getByText('View details'));
    expect(screen.queryByText('review_work/build.mjs')).toBeNull();
  });

  it('后端 category 优先于扩展名：声明外的图片进 Edited files，说明替代类型标签', () => {
    render(
      <TurnFilesCard
        files={[
          makeFile({ category: 'deliverable', description: '公司介绍 12 页' }),
          makeFile({ path: '/proj/_预览_大事记页.png', category: 'intermediate', size: 100 }),
        ]}
      />,
    );

    expect(screen.getByText('公司介绍 12 页')).toBeTruthy();
    expect(screen.queryByText('Presentation · PPTX')).toBeNull();
    expect(document.querySelectorAll('[data-deliverable-card]')).toHaveLength(1);
    expect(screen.getByText('Changed 1 files')).toBeTruthy();

    // 展开查看 intermediate 文件
    fireEvent.click(screen.getByText('View details'));
    expect(screen.getByText('proj/_预览_大事记页.png')).toBeTruthy();
  });

  it('同名预览 PDF 收进已编辑，卡片只留幻灯片', () => {
    render(
      <TurnFilesCard
        files={[
          makeFile({
            path: '/proj/4432-自我介绍.pptx',
            category: 'deliverable',
            description: '10 页可编辑自我介绍',
          }),
          makeFile({
            path: '/proj/preview4/4432-自我介绍-预览.pdf',
            category: 'deliverable',
            description: '图像版预览 PDF，用于快速查看与分享',
          }),
        ]}
      />,
    );

    expect(screen.getByText('4432-自我介绍.pptx')).toBeTruthy();
    expect(screen.getByText('10 页可编辑自我介绍')).toBeTruthy();
    expect(document.querySelectorAll('[data-deliverable-card]')).toHaveLength(1);
    expect(screen.queryByText('4432-自我介绍-预览.pdf')).toBeNull();
    expect(screen.getByText('Changed 1 files')).toBeTruthy();
  });

  it('点击 打开方式 按钮打开交付物文件', async () => {
    render(<TurnFilesCard files={[makeFile()]} />);

    fireEvent.click(screen.getByText('Open with'));
    expect(openLocalPathMock).toHaveBeenCalledWith('/proj/自我介绍.pptx');

    // 成功后不出现行内错误
    expect(screen.queryByText(/Could not open/)).toBeNull();
  });

  it('点击交付物标题打开文件', async () => {
    render(<TurnFilesCard files={[makeFile()]} />);

    fireEvent.click(screen.getByText('自我介绍.pptx'));
    expect(openLocalPathMock).toHaveBeenCalledWith('/proj/自我介绍.pptx');
    expect(screen.queryByText(/Could not open/)).toBeNull();
  });

  it('点击中间修改文件行用系统应用打开', async () => {
    render(
      <TurnFilesCard
        files={[
          makeFile({
            path: '/proj/src/index.ts',
            kind: 'modified',
            size: 512,
          }),
        ]}
      />,
    );

    // 默认折叠，先展开
    fireEvent.click(screen.getByText('View details'));

    fireEvent.click(screen.getByText('src/index.ts'));
    expect(openLocalPathMock).toHaveBeenCalledWith('/proj/src/index.ts');
  });

  it('打开失败时在卡片内显示错误原因', async () => {
    openLocalPathMock.mockResolvedValue({ success: false, error: '没有应用能打开该文件' });
    render(<TurnFilesCard files={[makeFile()]} />);

    fireEvent.click(screen.getByText('Open with'));
    await screen.findByText(/没有应用能打开该文件/);
  });

  it('bridge 抛错时同样落成行内错误', async () => {
    openLocalPathMock.mockRejectedValue(new Error('Host bridge unavailable'));
    render(<TurnFilesCard files={[makeFile()]} />);

    fireEvent.click(screen.getByText('Open with'));
    await screen.findByText(/Host bridge unavailable/);
  });

  it('打开方式 下拉菜单提供更多操作选项', () => {
    render(<TurnFilesCard files={[makeFile()]} />);

    const moreButton = screen.getByLabelText('More actions');
    fireEvent.click(moreButton);

    expect(screen.getByText('Open with default app')).toBeTruthy();
    expect(screen.getByText('Show in folder')).toBeTruthy();
    expect(screen.getByText('Copy file path')).toBeTruthy();
  });
});
