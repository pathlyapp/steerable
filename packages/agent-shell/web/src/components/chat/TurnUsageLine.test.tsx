/**
 * R6 回合账单行：用户问「这一轮花了多少」时，能读到的必须是**整轮**，
 * 而不是把子代理那几行加起来。
 *
 * 三条要锁住的行为：
 * - 总计永远显示（含父级）；
 * - 有子代理时才拆出占比，没有就不画那一段；
 * - 外部引擎子代理让合计变成下限时必须明说。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const { TurnUsageLine } = await import('./TurnUsageLine');

afterEach(cleanup);

describe('TurnUsageLine', () => {
  it('没有账单就不渲染', () => {
    const { container } = render(<TurnUsageLine usage={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('总计为 0 时不渲染空行', () => {
    const { container } = render(
      <TurnUsageLine
        usage={{ promptTokens: 0, completionTokens: 0, totalTokens: 0 }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('没派子代理的回合不渲染（需求只要看子代理的用量）', () => {
    const { container } = render(
      <TurnUsageLine
        usage={{ promptTokens: 800, completionTokens: 200, totalTokens: 1000 }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('有子代理时拆出总计与占比', () => {
    render(
      <TurnUsageLine
        usage={{
          // 父级 4000 + 子代理 1000 = 整轮 5000，子代理占 20%。
          promptTokens: 3200,
          completionTokens: 800,
          totalTokens: 4000,
          childTotalTokens: 1000,
        }}
      />,
    );

    expect(screen.getByTestId('turn-usage').textContent).toContain('5.0k');
    expect(screen.getByTestId('turn-usage-children').textContent).toContain('1.0k');
    expect(screen.getByTestId('turn-usage-children').textContent).toContain('20%');
  });

  it('外部引擎子代理让合计变成下限时必须标出来', () => {
    render(
      <TurnUsageLine
        usage={{
          promptTokens: 1000,
          completionTokens: 200,
          totalTokens: 1200,
          unknownUsageChildren: 1,
        }}
      />,
    );

    // 这一路一个 token 都没报，但子代理确实跑了——正是最需要说明的情形。
    expect(screen.getByTestId('turn-usage')).toBeTruthy();
    expect(screen.getByTestId('turn-usage-partial')).toBeTruthy();
  });

  it('合计完整时不加「不完整」那句', () => {
    render(
      <TurnUsageLine
        usage={{
          promptTokens: 1000,
          completionTokens: 200,
          totalTokens: 1200,
          childTotalTokens: 400,
        }}
      />,
    );

    expect(screen.queryByTestId('turn-usage-partial')).toBeNull();
  });
});
