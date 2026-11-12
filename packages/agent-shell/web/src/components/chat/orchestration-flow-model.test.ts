import { describe, it, expect } from 'vitest';
import {
  extractOrchestrationFlow,
  isOrchestrationTool,
  resolveLatestSessionOrchestrationFlow,
} from './orchestration-flow-model';

describe('orchestration-flow-model', () => {
  it('identifies orchestration tools', () => {
    expect(isOrchestrationTool('agent_spawn')).toBe(true);
    expect(isOrchestrationTool('agent_wait')).toBe(true);
    expect(isOrchestrationTool('agent_send')).toBe(true);
    expect(isOrchestrationTool('agent_interrupt')).toBe(true);
    expect(isOrchestrationTool('agent_close')).toBe(true);
    expect(isOrchestrationTool('agent_list')).toBe(true);
    expect(isOrchestrationTool('local_read_file')).toBe(false);
    expect(isOrchestrationTool('delegate_subagent')).toBe(false);
  });

  it('returns null when no orchestration tools or children exist', () => {
    expect(extractOrchestrationFlow([], [])).toBeNull();
    expect(
      extractOrchestrationFlow([
        { tool: 'local_read_file', arguments: { path: '/tmp' }, result: { success: true } },
      ]),
    ).toBeNull();
  });

  it('aggregates agent_spawn and agent_wait into nodes and flow', () => {
    const actions = [
      {
        tool: 'agent_spawn',
        arguments: { task: '心算 17+28' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', status: 'running' }), data: { childId: '0.1' } },
      },
      {
        tool: 'agent_spawn',
        arguments: { task: '心算 6×7' },
        result: { success: true, message: JSON.stringify({ childId: '0.2', status: 'running' }), data: { childId: '0.2' } },
      },
      {
        tool: 'agent_wait',
        arguments: { childId: '0.1' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', status: 'completed', answer: '45' }) },
      },
      {
        tool: 'agent_wait',
        arguments: { childId: '0.2' },
        result: { success: true, message: JSON.stringify({ childId: '0.2', status: 'completed', answer: '42' }) },
      },
    ];

    const flow = extractOrchestrationFlow(actions);
    expect(flow).not.toBeNull();
    expect(flow?.totalCount).toBe(2);
    expect(flow?.completedCount).toBe(2);
    expect(flow?.runningCount).toBe(0);
    expect(flow?.isAllCompleted).toBe(true);
    expect(flow?.summaryCopy).toBe('2/2 all done');

    const node1 = flow?.nodes.find((n) => n.childId === '0.1');
    expect(node1?.task).toBe('心算 17+28');
    expect(node1?.status).toBe('completed');
    expect(node1?.answer).toBe('45');

    const node2 = flow?.nodes.find((n) => n.childId === '0.2');
    expect(node2?.task).toBe('心算 6×7');
    expect(node2?.status).toBe('completed');
    expect(node2?.answer).toBe('42');
  });

  it('handles agent_send steering and agent_interrupt / agent_close', () => {
    const actions = [
      {
        tool: 'agent_spawn',
        arguments: { task: '分析日志' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', status: 'running' }) },
      },
      {
        tool: 'agent_send',
        arguments: { childId: '0.1', message: '注意只要 error 级别' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', delivery: 'steered' }) },
      },
      {
        tool: 'agent_interrupt',
        arguments: { childId: '0.1' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', interrupted: true }) },
      },
      {
        tool: 'agent_close',
        arguments: { childId: '0.1' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', closed: true }) },
      },
    ];

    const flow = extractOrchestrationFlow(actions);
    expect(flow).not.toBeNull();
    const node = flow?.nodes[0];
    expect(node?.childId).toBe('0.1');
    expect(node?.steers).toHaveLength(1);
    expect(node?.steers[0].message).toBe('注意只要 error 级别');
    expect(node?.closed).toBe(true);
    expect(node?.status).toBe('closed');
  });

  it('merges live SSE ChildInfo with actions', () => {
    const children = [
      { childId: '0.1', task: '实时任务', status: 'running' as const, recordId: 'rec-123' },
    ];
    const actions = [
      {
        tool: 'agent_wait',
        arguments: { childId: '0.1' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', status: 'completed', answer: '完成结果' }) },
      },
    ];

    const flow = extractOrchestrationFlow(actions, children);
    expect(flow).not.toBeNull();
    expect(flow?.nodes[0].recordId).toBe('rec-123');
    expect(flow?.nodes[0].task).toBe('实时任务');
    expect(flow?.nodes[0].status).toBe('completed');
    expect(flow?.nodes[0].answer).toBe('完成结果');
  });

  it('resolveLatestSessionOrchestrationFlow prefers live turn, then walks history', () => {
    const historicalActions = [
      {
        tool: 'agent_spawn',
        arguments: { task: '历史子任务' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', status: 'completed' }) },
      },
      {
        tool: 'agent_wait',
        arguments: { childId: '0.1' },
        result: { success: true, message: JSON.stringify({ childId: '0.1', status: 'completed', answer: '历史答案' }) },
      },
    ];

    // 1. 只有历史回合时，返回历史 flow
    const historyOnly = resolveLatestSessionOrchestrationFlow({
      messages: [{ id: 'msg-1' }],
      executedActionsByMessageId: { 'msg-1': historicalActions },
    });
    expect(historyOnly?.nodes[0].task).toBe('历史子任务');

    // 2. 有正在进行的回合时，优先返回实时 flow
    const liveActions = [
      {
        tool: 'agent_spawn',
        arguments: { task: '实时子任务' },
        result: { success: true, message: JSON.stringify({ childId: '0.2', status: 'running' }) },
      },
    ];
    const withLive = resolveLatestSessionOrchestrationFlow({
      messages: [{ id: 'msg-1' }],
      executedActionsByMessageId: { 'msg-1': historicalActions },
      currentTurnActions: liveActions,
    });
    expect(withLive?.nodes[0].task).toBe('实时子任务');
    expect(withLive?.hasActive).toBe(true);
  });

  it('settles leftover running branches once the parent turn has stopped', () => {
    const actions = [
      {
        tool: 'agent_spawn',
        arguments: { task: '已完成的侦察' },
        result: { success: true, message: JSON.stringify({ childId: '0.1' }) },
      },
      {
        tool: 'agent_spawn',
        arguments: { task: '还在跑的侦察' },
        result: { success: true, message: JSON.stringify({ childId: '0.2' }) },
      },
      {
        tool: 'agent_wait',
        arguments: { childId: '0.1' },
        result: {
          success: true,
          message: JSON.stringify({ childId: '0.1', status: 'completed', answer: '结论' }),
        },
      },
    ];
    const children = [
      { childId: '0.1', task: '已完成的侦察', status: 'completed' },
      { childId: '0.2', task: '还在跑的侦察', status: 'running' },
    ];

    const live = resolveLatestSessionOrchestrationFlow({
      messages: [],
      currentTurnActions: actions,
      currentTurnChildren: children,
      turnActive: true,
    });
    expect(live?.hasActive).toBe(true);
    expect(live?.summaryCopy).toBe('Running together (1/2 done)...');
    expect(live?.nodes.find((node) => node.childId === '0.2')?.status).toBe('running');

    const stopped = resolveLatestSessionOrchestrationFlow({
      messages: [],
      currentTurnActions: actions,
      currentTurnChildren: children,
      turnActive: false,
    });
    expect(stopped?.hasActive).toBe(false);
    expect(stopped?.isAllCompleted).toBe(false);
    expect(stopped?.summaryCopy).toBe('1 done · 1 ended (2 subtasks)');
    expect(stopped?.nodes.find((node) => node.childId === '0.1')?.status).toBe('completed');
    expect(stopped?.nodes.find((node) => node.childId === '0.1')?.answer).toBe('结论');
    expect(stopped?.nodes.find((node) => node.childId === '0.2')?.status).toBe('cancelled');
  });

  it('keeps a cancelled child out of the executing count', () => {
    const flow = extractOrchestrationFlow(
      [
        {
          tool: 'agent_spawn',
          arguments: { task: '侦察' },
          result: { success: true, message: JSON.stringify({ childId: '0.1' }) },
        },
      ],
      [{ childId: '0.1', task: '侦察', status: 'cancelled' }],
    );
    expect(flow?.nodes[0].status).toBe('cancelled');
    expect(flow?.hasActive).toBe(false);
    expect(flow?.summaryCopy).not.toContain('Running together');
  });
});
