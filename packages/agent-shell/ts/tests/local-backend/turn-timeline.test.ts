import { describe, expect, it } from 'vitest';
import {
  appendTimelineDelta,
  dropAttemptBlocks,
  sealLastTimelineBlock,
  syncTimelineTools,
  type PersistedTurnBlock,
} from '../../src/local-backend/turn-timeline.js';

describe('local-backend turn-timeline', () => {
  it('interleaves text and tools in call order', () => {
    const blocks: PersistedTurnBlock[] = [];
    appendTimelineDelta(blocks, 'reasoning', '想');
    appendTimelineDelta(blocks, 'text', '读文件');
    syncTimelineTools(blocks, [{ tool: 'read' }]);
    appendTimelineDelta(blocks, 'text', '写回去');
    syncTimelineTools(blocks, [{ tool: 'read' }, { tool: 'write' }]);
    expect(blocks.map((b) => b.type)).toEqual(['reasoning', 'text', 'tools', 'text', 'tools']);
    expect(blocks[2]).toEqual({ type: 'tools', actions: [{ tool: 'read' }] });
    expect(blocks[4]).toEqual({ type: 'tools', actions: [{ tool: 'write' }] });
  });

  it('starts a new reasoning block after sealLastTimelineBlock', () => {
    const blocks: PersistedTurnBlock[] = [];
    appendTimelineDelta(blocks, 'reasoning', '第一轮');
    sealLastTimelineBlock(blocks);
    appendTimelineDelta(blocks, 'reasoning', '第二轮');
    expect(blocks[0]).toMatchObject({
      type: 'reasoning',
      content: '第一轮',
      sealed: true,
    });
    expect(typeof (blocks[0] as { durationMs?: number }).durationMs).toBe('number');
    expect(blocks[1]).toMatchObject({ type: 'reasoning', content: '第二轮' });
  });
});

describe('dropAttemptBlocks', () => {
  it('撤回本次尝试的正文与思考，保留工具块', () => {
    const blocks: PersistedTurnBlock[] = [];
    appendTimelineDelta(blocks, 'text', '上一轮的回答');
    const attemptStart = blocks.length;
    appendTimelineDelta(blocks, 'reasoning', '这次的想法');
    blocks.push({ type: 'tools', actions: [{ tool: 'read_file' }] });
    appendTimelineDelta(blocks, 'text', '半句话');

    dropAttemptBlocks(blocks, attemptStart);

    expect(blocks.map((b) => b.type)).toEqual(['text', 'tools']);
    expect((blocks[0] as { content: string }).content).toBe('上一轮的回答');
  });

  it('尝试期间没有正文时什么都不删', () => {
    const blocks: PersistedTurnBlock[] = [];
    appendTimelineDelta(blocks, 'text', '已有正文');
    dropAttemptBlocks(blocks, blocks.length);
    expect(blocks).toHaveLength(1);
  });

  it('同一块里既有正文又有工具时只删正文', () => {
    const blocks: PersistedTurnBlock[] = [];
    const attemptStart = 0;
    appendTimelineDelta(blocks, 'text', 'a');
    blocks.push({ type: 'tools', actions: [] });
    appendTimelineDelta(blocks, 'text', 'b');

    dropAttemptBlocks(blocks, attemptStart);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('tools');
  });
});
