/**
 * 侧栏和输入框各自的项目列表读同一份缓存，一侧刷新另一侧跟着变。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '@/lib/local-api';

const listProjects = vi.fn();
const reorderProjects = vi.fn();

vi.mock('@/lib/host-bridge', () => ({
  hasHostBridge: () => true,
}));

vi.mock('@/lib/local-api', () => ({
  listProjects: () => listProjects(),
  reorderProjects: (ids: string[]) => reorderProjects(ids),
}));

const { persistProjectOrder, useProjects, resetProjectsStoreForTests } = await import('./useProjects');

function project(name: string, id = name): LocalProject {
  return {
    id,
    name,
    folderPath: `/tmp/${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function ListView({ id }: { id: string }) {
  const { projects, refresh } = useProjects();
  return (
    <div>
      <div data-testid={id}>{projects.map((item) => item.name).join(',')}</div>
      <button type="button" onClick={() => void refresh()}>
        refresh-{id}
      </button>
    </div>
  );
}

beforeEach(() => {
  resetProjectsStoreForTests();
  listProjects.mockReset();
  reorderProjects.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useProjects', () => {
  it('一侧刷新后，另一侧列表一起更新', async () => {
    listProjects.mockResolvedValue({ projects: [project('项目甲')] });
    render(
      <>
        <ListView id="sidebar" />
        <ListView id="picker" />
      </>,
    );

    await waitFor(() => expect(screen.getByTestId('sidebar').textContent).toBe('项目甲'));
    expect(screen.getByTestId('picker').textContent).toBe('项目甲');

    listProjects.mockResolvedValue({
      projects: [project('项目甲'), project('项目乙', 'proj-b')],
    });
    fireEvent.click(screen.getByRole('button', { name: 'refresh-picker' }));

    await waitFor(() =>
      expect(screen.getByTestId('sidebar').textContent).toBe('项目甲,项目乙'),
    );
    expect(screen.getByTestId('picker').textContent).toBe('项目甲,项目乙');
  });

  it('保存失败时两侧列表都回到拖拽前的顺序', async () => {
    const first = project('项目甲', 'a');
    const second = project('项目乙', 'b');
    listProjects.mockResolvedValue({ projects: [first, second] });
    reorderProjects.mockRejectedValue(new Error('排序失败'));
    render(
      <>
        <ListView id="sidebar" />
        <ListView id="picker" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('sidebar').textContent).toBe('项目甲,项目乙'));

    await expect(persistProjectOrder(['b', 'a'])).rejects.toThrow('排序失败');
    expect(screen.getByTestId('sidebar').textContent).toBe('项目甲,项目乙');
    expect(screen.getByTestId('picker').textContent).toBe('项目甲,项目乙');
  });
});
