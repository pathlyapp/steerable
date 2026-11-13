/**
 * R7 子代理面板：每行要能回答四个问题——这是谁、跑到哪一步、花了多少、还能不能继续。
 *
 * 面板读的是同一条 `ChildInfo` 列表（实时事件或落库回放），所以这里的用例
 * 同时锁住两件事：卡片真的挂上了（以前注释写着 "Currently unmounted"），
 * 以及「不计」与「0 tok」不会被画成同一件事。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORCHESTRATION_STATUS_LABEL } from '@steerable/agent-ui/cards';

const { OrchestrationChildrenCard } = await import('./OrchestrationChildrenCard');
type ChildInfo = import('./orchestration-children-model').ChildInfo;

afterEach(cleanup);

const AGENTS = [
  { id: 'a1', slug: 'explore', name: '探索者', color: '#2563eb' },
  { id: 'a2', slug: 'coder', name: '实现者', color: '#16a34a' },
];

/** `completed` folds onto the card's `ok` status (see STATUS_MAP). */
const STATUS_OF_COMPLETED = 'ok' as const;

function threeChildren(): ChildInfo[] {
  return [
    {
      childId: '0.1',
      task: '扫日志',
      depth: 1,
      profile: 'explore',
      status: 'completed',
      usage: { promptTokens: 7000, completionTokens: 1120, totalTokens: 8120 },
      elapsedMs: 12_400,
      recordId: 'chat-1:child:0.1',
    },
    {
      childId: '0.2',
      task: '改代码',
      depth: 1,
      profile: 'coder',
      status: 'running',
      recordId: 'chat-1:child:0.2',
    },
    {
      childId: '0.3',
      task: '查文档',
      depth: 1,
      profile: 'explore',
      status: 'interrupted',
      elapsedMs: 4_100,
      recordId: 'chat-1:child:0.3',
    },
  ];
}

describe('OrchestrationChildrenCard (R7)', () => {
  it('每行显示血统 id、画像、深度、状态与用量', () => {
    render(<OrchestrationChildrenCard children={threeChildren()} agents={AGENTS} />);

    const first = screen.getByTestId('orchestration-child-0.1');
    expect(first.textContent).toContain('0.1');
    expect(first.textContent).toContain('探索者');
    expect(first.textContent).toContain('Depth 1');
    expect(first.textContent).toContain('8.1k tok');
    // 12.4s：耗时列，让人能看出谁在拖时间。
    expect(first.textContent).toContain('12.4s');
  });

  it('只有两个以上子代理才渲染看板', () => {
    // 单次委派已经在工具行里有同一条进度，再画一遍是重复。
    const single = threeChildren().slice(0, 1);
    render(<OrchestrationChildrenCard children={single} agents={AGENTS} />);
    expect(screen.queryByTestId('orchestration-child-0.1')).toBeNull();
  });

  it('外部引擎的子代理显示「不计」，不是 0 tok', () => {
    const children: ChildInfo[] = [
      { childId: '0.1', profile: 'explore', status: 'completed', depth: 1 },
      { childId: '0.2', profile: 'coder', status: 'completed', depth: 1 },
    ];
    render(<OrchestrationChildrenCard children={children} agents={AGENTS} />);

    const row = screen.getByTestId('orchestration-child-0.1');
    expect(row.textContent).toContain('Not counted');
    expect(row.textContent).not.toContain('0 tok');
  });

  it('运行中的行给「停止」，可续的行给「继续」', () => {
    const onStop = vi.fn();
    const onContinue = vi.fn();
    render(
      <OrchestrationChildrenCard
        children={threeChildren()}
        agents={AGENTS}
        onStop={onStop}
        onContinue={onContinue}
      />,
    );

    fireEvent.click(screen.getByTestId('orchestration-child-stop-0.2'));
    expect(onStop).toHaveBeenCalledWith('0.2');

    // interrupted 是可续的；running 不是。
    fireEvent.click(screen.getByTestId('orchestration-child-continue-0.3'));
    expect(onContinue).toHaveBeenCalledWith('0.3', 'chat-1:child:0.3');
    expect(screen.queryByTestId('orchestration-child-continue-0.2')).toBeNull();
    expect(screen.queryByTestId('orchestration-child-stop-0.1')).toBeNull();
  });

  it('「查看过程」带上子代理自己的 recordId', () => {
    const onViewProcess = vi.fn();
    render(
      <OrchestrationChildrenCard
        children={threeChildren()}
        agents={AGENTS}
        onViewProcess={onViewProcess}
      />,
    );

    fireEvent.click(screen.getByTestId('orchestration-child-process-0.1'));
    expect(onViewProcess).toHaveBeenCalledWith('chat-1:child:0.1');
  });

  it('换模型 fork 显示「缓存重算」提示，状态点不变', () => {
    const children: ChildInfo[] = [
      {
        childId: '0.1',
        depth: 1,
        profile: 'explore',
        status: 'completed',
        cacheNote: 'cold',
        parentModel: 'deepseek-chat',
        childModel: 'glm-5.3-flash',
      },
      { childId: '0.2', depth: 1, profile: 'coder', status: 'completed' },
    ];
    render(<OrchestrationChildrenCard children={children} agents={AGENTS} />);

    const row = screen.getByTestId('orchestration-child-0.1');
    expect(row.textContent).toContain('Model switched · cache recomputed');
    // 状态仍是完成态：换模型是提示，不是失败。
    expect(row.textContent).toContain(
      ORCHESTRATION_STATUS_LABEL[STATUS_OF_COMPLETED],
    );
  });

  it('孙代理缩进一格，父行不折叠', () => {
    const children: ChildInfo[] = [
      { childId: '0.1', depth: 1, profile: 'coder', status: 'completed' },
      { childId: '0.1.1', depth: 2, profile: 'explore', status: 'completed' },
    ];
    render(<OrchestrationChildrenCard children={children} agents={AGENTS} />);

    const grandchild = screen.getByTestId('orchestration-child-0.1.1');
    expect(grandchild.getAttribute('style')).toContain('padding-left: 14px');
    // 两行都在：默认展开，深度靠缩进表达。
    expect(screen.getByTestId('orchestration-child-0.1')).toBeTruthy();
  });
});

describe('OrchestrationChildrenCard · 等待回答 (R7-3)', () => {
  it('等用户回答的行写「等待你的回答」，且不给「继续」', () => {
    const children: ChildInfo[] = [
      { childId: '0.3', depth: 1, profile: 'coder', status: 'needs_input', needsInput: { intro: '用哪个测试命令？' } },
      { childId: '0.4', depth: 1, profile: 'explore', status: 'completed' },
    ];
    const onContinue = vi.fn();
    render(
      <OrchestrationChildrenCard children={children} agents={AGENTS} onContinue={onContinue} />,
    );

    const row = screen.getByTestId('orchestration-child-0.3');
    expect(row.textContent).toContain('Waiting for your answer');
    // 继续一个在等答案的子代理只会把同一个问题再问一遍。
    expect(screen.queryByTestId('orchestration-child-continue-0.3')).toBeNull();
  });

  it('已转交的行写「已结束 · 已转交」', () => {
    const children: ChildInfo[] = [
      { childId: '0.3', depth: 1, profile: 'coder', status: 'completed', handedOver: true },
      { childId: '0.4', depth: 1, profile: 'coder', status: 'running' },
    ];
    render(<OrchestrationChildrenCard children={children} agents={AGENTS} />);
    expect(screen.getByTestId('orchestration-child-0.3').textContent).toContain(
      'Finished · handed over',
    );
  });
});
