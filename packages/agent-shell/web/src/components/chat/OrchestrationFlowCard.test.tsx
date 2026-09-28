import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OrchestrationFlowCard } from './OrchestrationFlowCard';
import type { OrchestrationFlowData } from './orchestration-flow-model';

afterEach(cleanup);

const SAMPLE_FLOW: OrchestrationFlowData = {
  nodes: [
    {
      childId: '0.1',
      task: '心算 17+28',
      status: 'completed',
      answer: '45',
      steers: [{ message: '只要数字' }],
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

describe('OrchestrationFlowCard', () => {
  it('renders header with summary status', () => {
    render(<OrchestrationFlowCard flow={SAMPLE_FLOW} />);
    expect(screen.getByText('Multi-agent orchestration')).toBeTruthy();
    expect(screen.getByText('Fork-Join flow')).toBeTruthy();
    expect(screen.getByText('2/2 全部完成')).toBeTruthy();
  });

  it('can expand and render the flowchart nodes', () => {
    render(<OrchestrationFlowCard flow={SAMPLE_FLOW} />);

    // By default when completed, it might be collapsed; clicking header expands
    const headerBtn = screen.getByRole('button', { name: /Multi-agent orchestration/i });
    fireEvent.click(headerBtn);

    // Verify Fork, Nodes, Answers, and Join are rendered
    expect(screen.getByText(/Main agent goal dispatch \(Fork\)/i)).toBeTruthy();
    expect(screen.getByText('心算 17+28')).toBeTruthy();
    expect(screen.getByText('心算 6×7')).toBeTruthy();
    expect(screen.getByText('只要数字')).toBeTruthy();
    expect(screen.getByText('45')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText(/Result merge \(Join\)/i)).toBeTruthy();
  });

  it('respects defaultExpanded prop when passed', () => {
    const runningFlow: OrchestrationFlowData = {
      ...SAMPLE_FLOW,
      isAllCompleted: false,
      hasActive: true,
      runningCount: 1,
      completedCount: 1,
      summaryCopy: '协同执行中 (1/2 完成)...',
      nodes: [
        {
          childId: '0.1',
          task: '正在计算中',
          status: 'running',
          steers: [],
        },
      ],
    };

    render(<OrchestrationFlowCard flow={runningFlow} defaultExpanded />);
    // When defaultExpanded is true, body is expanded
    expect(screen.getByText(/Main agent goal dispatch \(Fork\)/i)).toBeTruthy();
    expect(screen.getByText('正在计算中')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });
});
