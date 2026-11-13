/**
 * 失败卡片：主提示按错误类别选择、不出现英文异常名；技术原因与追踪编号
 * 只在「详情」里；按钮由调用方决定能不能用。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnFailureCard, buildDiagnostics } from './TurnFailureCard';
import { failurePresentation, readFailureDetail } from './turn-failure';

afterEach(cleanup);

const TRANSPORT = {
  kind: 'transport' as const,
  proxy: 'http://127.0.0.1:7890',
  attempts: 5,
};

const RAW =
  'openai_compat: transport error: ConnectError <- EndOfStream <- SSLEOFError: [SSL: UNEXPECTED_EOF_WHILE_READING]';

describe('失败卡片的提示', () => {
  it('网络失败给出可执行的下一步，并把已完成的步数写进说明', () => {
    const p = failurePresentation(TRANSPORT, { completedSteps: 8 });
    expect(p.title).toBe("Can't reach the model service right now");
    expect(p.body).toContain('8');
    expect(p.primary).toEqual({ kind: 'retry' });
    expect(p.secondary).toEqual([{ kind: 'network-diagnostics' }]);
  });

  it('没有已完成步骤时不提「已完成的 0 步」', () => {
    expect(failurePresentation(TRANSPORT, { completedSteps: 0 }).body).not.toContain('0');
  });

  it('认证失败的主按钮是打开模型设置，继续降为次按钮', () => {
    const p = failurePresentation({ kind: 'auth' });
    expect(p.primary).toEqual({ kind: 'open-model-settings' });
    expect(p.secondary).toEqual([{ kind: 'retry' }]);
  });

  it('对话过长的建议新建对话，因为继续大概率再失败', () => {
    expect(failurePresentation({ kind: 'context_overflow' }).primary).toEqual({
      kind: 'new-chat',
    });
  });

  it('没有类别时退回通用文案并标记为未分类', () => {
    const p = failurePresentation(undefined);
    expect(p.title).toBe('Reply failed');
    expect(p.classified).toBe(false);
  });

  it('重试次数写进说明，次数为 1 时不写', () => {
    expect(failurePresentation({ kind: 'transport', attempts: 5 }).body).toContain('4');
    expect(failurePresentation({ kind: 'transport', attempts: 1 }).body).not.toContain('Retried');
  });
});

describe('失败卡片', () => {
  it('主提示里没有英文异常名', () => {
    render(<TurnFailureCard detail={TRANSPORT} reason={RAW} completedSteps={8} />);
    const card = screen.getByTestId('turn-failure');
    expect(card.textContent).not.toContain('SSLEOFError');
    expect(card.textContent).not.toContain('ConnectError');
    expect(card.textContent).not.toContain('7890');
  });

  it('详情里能看到具体原因、连接方式和追踪编号', () => {
    render(
      <TurnFailureCard detail={TRANSPORT} reason={RAW} traceId="trace_0d5e" />,
    );
    expect(screen.queryByTestId('turn-failure-details')).toBeNull();

    fireEvent.click(screen.getByText('Details'));

    const details = screen.getByTestId('turn-failure-details');
    expect(details.textContent).toContain('SSLEOFError');
    expect(details.textContent).toContain('127.0.0.1:7890');
    expect(details.textContent).toContain('trace_0d5e');
    expect(details.textContent).toContain('5 attempts');
  });

  it('未分类的失败在详情里显示原始原因', () => {
    render(<TurnFailureCard reason="some weird failure" traceId="t1" />);
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByTestId('turn-failure-details').textContent).toContain(
      'some weird failure',
    );
  });

  it('只画调用方能执行的动作', () => {
    render(
      <TurnFailureCard
        detail={TRANSPORT}
        reason={RAW}
        action={(a) => (a.kind === 'retry' ? { onClick: () => {} } : null)}
      />,
    );
    expect(screen.getByText('Continue')).toBeTruthy();
    expect(screen.queryByText('Network diagnostics')).toBeNull();
  });

  it('不可用的动作显示为禁用并带原因', () => {
    render(
      <TurnFailureCard
        detail={TRANSPORT}
        reason={RAW}
        action={() => ({ onClick: () => {}, disabled: true, hint: 'busy' })}
      />,
    );
    const retry = screen.getByText('Continue') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('title')).toBe('busy');
  });

  it('一个动作都不可用时卡片仍然可读，详情照常可展开', () => {
    render(<TurnFailureCard detail={TRANSPORT} reason={RAW} />);
    expect(screen.getByText("Can't reach the model service right now")).toBeTruthy();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByTestId('turn-failure-details')).toBeTruthy();
  });
});

describe('复制诊断信息', () => {
  it('内容有类别、原因、连接方式与追踪编号', () => {
    const text = buildDiagnostics({
      detail: TRANSPORT,
      reason: RAW,
      traceId: 'trace_0d5e',
    });
    expect(text).toContain('Network');
    expect(text).toContain('SSLEOFError');
    expect(text).toContain('127.0.0.1:7890');
    expect(text).toContain('trace_0d5e');
  });

  it('复制后按钮显示已复制', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    // jsdom 的 navigator 上 clipboard 只有 getter，必须用 defineProperty 覆盖。
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<TurnFailureCard detail={TRANSPORT} reason={RAW} traceId="t1" />);
    fireEvent.click(screen.getByText('Details'));
    fireEvent.click(screen.getByText('Copy diagnostic info'));
    expect(writeText).toHaveBeenCalledOnce();
    expect(await screen.findByText('Copied')).toBeTruthy();
    for (const [text] of writeText.mock.calls) {
      expect(text).not.toContain('sk-');
    }
  });
});

describe('readFailureDetail', () => {
  it('读出后端写入的类别与细节', () => {
    expect(readFailureDetail({ errorKind: 'transport', proxy: 'http://p:1', attempts: 3 })).toEqual({
      kind: 'transport',
      proxy: 'http://p:1',
      attempts: 3,
    });
  });

  it('没有类别时返回 undefined，旧记录按未分类处理', () => {
    expect(readFailureDetail({ proxy: 'http://p:1' })).toBeUndefined();
    expect(readFailureDetail(null)).toBeUndefined();
    expect(readFailureDetail('transport')).toBeUndefined();
  });

  it('未知类别不猜测', () => {
    expect(readFailureDetail({ errorKind: 'brand-new-kind' })).toBeUndefined();
  });

  it('类型不对的字段被丢弃而不是透传', () => {
    expect(readFailureDetail({ errorKind: 'transport', attempts: '3', proxy: 42 })).toEqual({
      kind: 'transport',
    });
  });
});
