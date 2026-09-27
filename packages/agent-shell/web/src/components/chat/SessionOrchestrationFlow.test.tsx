import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionOrchestrationFlow } from './SessionOrchestrationFlow';
import type { OrchestrationFlowData } from './orchestration-flow-model';

afterEach(cleanup);

const SAMPLE_FLOW: OrchestrationFlowData = {
  nodes: [
    {
      childId: '0.1',
      task: '心算 17+28',
      status: 'completed',
      answer: '45',
      steers: [],
    },
    {
      childId: '0.2',
      task: '心算 6×7',
      status: 'completed',
      answer: '42',
      steers: [],
    },
  ],
  totalCount: 2,
  completedCount: 2,
  runningCount: 0,
  failedCount: 0,
  interruptedCount: 0,
  closedCount: 0,
  isAllCompleted: true,
  hasActive: false,
  summaryCopy: '2/2 全部完成',
};

describe('SessionOrchestrationFlow', () => {
  it('renders trigger capsule with summary badge', () => {
    render(<SessionOrchestrationFlow flow={SAMPLE_FLOW} />);
    expect(screen.getByTestId('session-orchestration-flow')).toBeTruthy();
    expect(screen.getByText('协同编排已就绪')).toBeTruthy();
    expect(screen.getByText('2/2 全部完成')).toBeTruthy();
  });

  it('expands on click and shows the todo-like flowchart list', () => {
    render(<SessionOrchestrationFlow flow={SAMPLE_FLOW} />);

    // Click trigger to expand
    fireEvent.click(screen.getByRole('button', { name: /协同编排已就绪/i }));

    expect(screen.getByText('多智能体协同流程')).toBeTruthy();
    expect(screen.getByText('目标分发 (Fork)')).toBeTruthy();
    expect(screen.getByText(/心算 17\+28/)).toBeTruthy();
    expect(screen.getByText(/心算 6×7/)).toBeTruthy();
    expect(screen.getByText('45')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('结果汇聚 (Join)')).toBeTruthy();
  });

  it('renders 3-branch orchestration flow without badge distortion', () => {
    const THREE_BRANCH_FLOW: OrchestrationFlowData = {
      nodes: [
        {
          childId: '0.1',
          task: '只读代码侦察任务 1',
          status: 'running',
          recordId: 'rec-1',
          steers: [],
        },
        {
          childId: '0.2',
          task: '只读代码侦察任务 2',
          status: 'completed',
          recordId: 'rec-2',
          answer: '完成',
          steers: [],
        },
        {
          childId: '0.3',
          task: '深度外部调研任务',
          status: 'running',
          recordId: 'rec-3',
          steers: [],
        },
      ],
      totalCount: 3,
      completedCount: 1,
      runningCount: 2,
      failedCount: 0,
      interruptedCount: 0,
      closedCount: 0,
      isAllCompleted: false,
      hasActive: true,
      summaryCopy: '协同执行中 (1/3 完成)',
    };

    render(
      <SessionOrchestrationFlow
        flow={THREE_BRANCH_FLOW}
        chatId="chat-1"
        onInspectTask={() => {}}
      />
    );

    expect(screen.getByText('并发 3 分支')).toBeTruthy();
    expect(screen.getByText('分支 #1')).toBeTruthy();
    expect(screen.getByText('分支 #2')).toBeTruthy();
    expect(screen.getByText('分支 #3')).toBeTruthy();
    expect(screen.getAllByText('执行中').length).toBe(2);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getAllByText('过程').length).toBe(3);
  });

  it('shows a stopped flow instead of waiting on join', () => {
    const STOPPED_FLOW: OrchestrationFlowData = {
      nodes: [
        {
          childId: '0.1',
          task: '已完成的侦察',
          status: 'completed',
          answer: '结论',
          steers: [],
        },
        {
          childId: '0.2',
          task: '被停掉的侦察',
          status: 'cancelled',
          steers: [],
        },
      ],
      totalCount: 2,
      completedCount: 1,
      runningCount: 0,
      failedCount: 0,
      interruptedCount: 0,
      closedCount: 1,
      isAllCompleted: false,
      hasActive: false,
      summaryCopy: '1 完成 · 1 结束 (2 个子任务)',
    };

    render(<SessionOrchestrationFlow flow={STOPPED_FLOW} />);
    fireEvent.click(screen.getByRole('button', { name: /协同编排已停止/ }));

    expect(screen.getAllByText('已停止').length).toBeGreaterThan(0);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getAllByText('1 完成 · 1 结束 (2 个子任务)').length).toBeGreaterThan(0);
    expect(screen.queryByText('等待分支就绪...')).toBeNull();
    expect(screen.queryByText(/协同执行中/)).toBeNull();
  });
});

