import { describe, expect, it } from 'vitest';
import { applyProjectIdOrder, nextProjectOrder } from './project-order';

describe('nextProjectOrder', () => {
  const ids = ['a', 'b', 'c'];

  it('插到目标前面', () => {
    expect(nextProjectOrder(ids, 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
  });

  it('插到目标后面', () => {
    expect(nextProjectOrder(ids, 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
    expect(nextProjectOrder(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
  });

  it('落点没有改变顺序时返回 null', () => {
    expect(nextProjectOrder(ids, 'a', 'b', 'before')).toBeNull();
    expect(nextProjectOrder(ids, 'b', 'a', 'after')).toBeNull();
    expect(nextProjectOrder(ids, 'a', 'a', 'before')).toBeNull();
  });
});

describe('applyProjectIdOrder', () => {
  const projects = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
    { id: 'c', name: '丙' },
  ];

  it('按给定 id 重排，并给每项写上序号', () => {
    expect(applyProjectIdOrder(projects, ['c', 'a', 'b']).map((item) => item.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(applyProjectIdOrder(projects, ['c', 'a', 'b']).map((item) => item.sortOrder)).toEqual([
      0, 1, 2,
    ]);
  });

  it('未知 id 忽略，没点到的项目按原相对顺序接在后面', () => {
    expect(applyProjectIdOrder(projects, ['missing', 'b']).map((item) => item.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
});
