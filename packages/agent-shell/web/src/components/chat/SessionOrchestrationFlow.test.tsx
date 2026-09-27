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
});
