/**
 * ChatInput 的 streaming 期交互契约（W6-2）：
 *   - ⌘/Ctrl+Enter 插队失败不再静默——hook 兜底后本组件按结果给反馈：'queued'
 *     提示「已改为排队」，三种结果都清草稿（消息必然已落地）；
 *   - 待发队列横幅展示数量、撤回入口与停止后恢复提示；
 *   - Enter 排队、⌘/Ctrl+Enter 插队快捷键在 streaming 期间有可见提示。
 * 队列 drain / 兜底决策本身由框架 useChatStream 的测试覆盖，这里只验
 * 呈现层接线。
 */
import { useState, type ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SteerOutcome } from '@steerable/agent-ui';
import { ChatInput, type ChatInputProps } from './ChatInput';
import * as electronBridge from '@/lib/host-bridge';

const tauriDrop = vi.hoisted(() => ({
  handler: null as
    | null
    | ((payload: {
        type: 'enter' | 'over' | 'drop' | 'leave';
        paths?: string[];
        position?: { x: number; y: number };
      }) => void),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (
      handler: (event: {
        payload: {
          type: 'enter' | 'over' | 'drop' | 'leave';
          paths?: string[];
          position?: { x: number; y: number };
        };
      }) => void,
    ) => {
      tauriDrop.handler = (payload) => handler({ payload });
      return Promise.resolve(() => {
        tauriDrop.handler = null;
      });
    },
  }),
}));

async function flushComposerSync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

afterEach(() => cleanup());

function renderInput(overrides: Partial<ChatInputProps> = {}) {
  const props: ChatInputProps = {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<ChatInput {...props} />);
  return props;
}

function pressEnter(init: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ...init });
}

describe('ChatInput streaming 期排队与插队（W6-2）', () => {
  it('Enter 直接排入 follow-up 队列并清空草稿', () => {
    const onFollowUp = vi.fn();
    const onSteer = vi.fn();
    const onChange = vi.fn();
    renderInput({ value: '排队这条', onChange, isStreaming: true, onFollowUp, onSteer });

    pressEnter();
    expect(onFollowUp).toHaveBeenCalledWith('排队这条');
    expect(onChange).toHaveBeenCalledWith('');
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('⌘/Ctrl+Enter 插队被兜底为排队（queued）：清空草稿并提示「已改为排队」', async () => {
    const onSteer = vi.fn<(text: string) => Promise<SteerOutcome>>().mockResolvedValue('queued');
    const onChange = vi.fn();
    renderInput({ value: '补充一下', onChange, isStreaming: true, onSteer });

    pressEnter({ metaKey: true });
    // 消息已交给 hook（进入待发队列），不是丢进虚空。
    expect(onSteer).toHaveBeenCalledWith('补充一下');

    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith('');
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe(
      'This turn cannot take an interjection. The message was queued and will be sent when this turn ends.',
    );
  });

  it('⌘/Ctrl+Enter 插队被接受（steered）：清空草稿且不显示排队提示', async () => {
    const onSteer = vi.fn<(text: string) => Promise<SteerOutcome>>().mockResolvedValue('steered');
    const onChange = vi.fn();
    renderInput({ value: '补一句', onChange, isStreaming: true, onSteer });

    pressEnter({ ctrlKey: true });
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses the browser text when the deferred controlled value trails the final keystroke', () => {
    const onSteer = vi.fn<(text: string) => Promise<SteerOutcome>>().mockResolvedValue('steered');
    renderInput({
      value: 'change directio',
      onChange: vi.fn(),
      isStreaming: true,
      onSteer,
    });
    const editor = screen.getByTestId('chat-composer');
    editor.textContent = 'change direction';

    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });

    expect(onSteer).toHaveBeenCalledWith('change direction');
  });

  it('⌘/Ctrl+Enter 遇到已结束回合时兜底为直发（sent）', async () => {
    const onSteer = vi.fn<(text: string) => Promise<SteerOutcome>>().mockResolvedValue('sent');
    const onChange = vi.fn();
    renderInput({ value: '来迟了', onChange, isStreaming: true, onSteer });

    pressEnter({ metaKey: true });
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.queryByRole('status')).toBeNull();
  });

});

describe('ChatInput 待发队列可见性（W6-2）', () => {
  it('排队横幅展示数量与停止恢复提示，可撤回单条，快捷键提示可见', () => {
    const onRemoveFollowUp = vi.fn();
    renderInput({
      isStreaming: true,
      onFollowUp: vi.fn(),
      pendingFollowUps: ['第一条', '第二条'],
      onRemoveFollowUp,
    });

    expect(
      screen.getByText(
        'Queued (2) · Sent when this turn ends · Restored to the input box if stopped',
      ),
    ).toBeTruthy();
    expect(screen.getByText('第一条')).toBeTruthy();
    expect(screen.getByText('第二条')).toBeTruthy();
    // 发现性：streaming 期间快捷键区展示 Enter 排队。
    expect(screen.getByText('Queue')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw queued message 2' }));
    expect(onRemoveFollowUp).toHaveBeenCalledWith(1);
  });

  it('无排队消息时不渲染横幅', () => {
    renderInput({ isStreaming: true, pendingFollowUps: [] });
    expect(screen.queryByText(/Queued \(/)).toBeNull();
  });
});

describe('ChatInput 停止交互（W6-2）', () => {
  it('有排队消息时 title 提示将恢复 N 条，无排队时不提示', () => {
    const base: Partial<ChatInputProps> = { isStreaming: true, onCancel: vi.fn() };
    const { rerender } = render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        {...base}
        pendingFollowUps={['第一条', '第二条']}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Stop generating' }).getAttribute('title'),
    ).toContain('2 queued messages will be restored to the input box');

    rerender(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        {...base}
        pendingFollowUps={[]}
      />,
    );
    const title = screen.getByRole('button', { name: 'Stop generating' }).getAttribute('title');
    expect(title).toContain('Stop generating');
    expect(title).not.toContain('restored');
  });

  it('Escape 停止生成，⌘/Ctrl+. 仍作为兼容快捷键', () => {
    const onCancel = vi.fn();
    renderInput({ isStreaming: true, onCancel });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: '.', metaKey: true });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe('ChatInput IME composition (Pinyin)', () => {
  it('does not sync the first composing letter until composition ends', () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <ChatInput
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const editor = screen.getByRole('textbox');

    fireEvent.compositionStart(editor);
    editor.textContent = 'n';
    fireEvent.input(editor);

    expect(onChange).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('n');
    expect(editor.getAttribute('data-composing')).toBe('true');

    fireEvent.compositionEnd(editor);
    expect(onChange).toHaveBeenCalledWith('n');
    expect(editor.getAttribute('data-composing')).toBeNull();
  });

  it('does not commit a letter that is followed by compositionstart before the deferred sync', async () => {
    const onChange = vi.fn();
    render(<ChatInput value="" onChange={onChange} onSubmit={vi.fn()} />);
    const editor = screen.getByRole('textbox');

    editor.textContent = 'n';
    fireEvent.input(editor);
    fireEvent.compositionStart(editor);
    await flushComposerSync();

    expect(onChange).not.toHaveBeenCalled();
    expect(editor.getAttribute('data-composing')).toBe('true');
  });

  it('does not treat a keyCode 229 keydown without compositionstart as composition', async () => {
    const onChange = vi.fn();
    render(<ChatInput value="你" onChange={onChange} onSubmit={vi.fn()} />);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Process', keyCode: 229 });
    editor.textContent = '你好';
    fireEvent.input(editor);
    await flushComposerSync();
    expect(onChange).toHaveBeenCalledWith('你好');
  });

  it('WKWebView Enter keyCode 229 sends and does not stick composition', () => {
    const onSubmit = vi.fn();
    render(<ChatInput value="hello" onChange={vi.fn()} onSubmit={onSubmit} />);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(editor.getAttribute('data-composing')).toBeNull();
  });

  it('does not send or swallow Enter while an IME composition is open', () => {
    const onSubmit = vi.fn();
    render(<ChatInput value="你好" onChange={vi.fn()} onSubmit={onSubmit} />);
    const editor = screen.getByRole('textbox');
    fireEvent.compositionStart(editor);
    const canceled = !fireEvent.keyDown(editor, {
      key: 'Enter',
      keyCode: 229,
      isComposing: true,
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(canceled).toBe(false);
    expect(editor.getAttribute('data-composing')).toBe('true');
  });

  it('leaves Backspace to the browser and keeps the typed text node', async () => {
    function Harness() {
      const [value, setValue] = useState('');
      return <ChatInput value={value} onChange={setValue} onSubmit={vi.fn()} />;
    }
    render(<Harness />);
    const editor = screen.getByRole('textbox');
    editor.focus();
    editor.textContent = '你好';
    const typed = editor.firstChild;
    fireEvent.input(editor);
    await flushComposerSync();
    expect(editor.firstChild).toBe(typed);
    const canceled = !fireEvent.keyDown(editor, { key: 'Backspace', keyCode: 229 });
    expect(canceled).toBe(false);
  });

  it('restores composing state on the first Pinyin letter keydown', () => {
    render(<ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'n' });
    expect(editor.getAttribute('data-composing')).toBe('true');
  });

  it('does not rewrite contenteditable DOM while composing', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ChatInput value="" onChange={onChange} onSubmit={vi.fn()} />,
    );
    const editor = screen.getByRole('textbox');

    fireEvent.compositionStart(editor);
    editor.textContent = 'ni';
    rerender(
      <ChatInput value="should-not-apply" onChange={onChange} onSubmit={vi.fn()} />,
    );

    expect(editor.textContent).toBe('ni');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a text node in an empty editor so IME can attach marked text', () => {
    render(<ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const editor = screen.getByRole('textbox');
    expect(editor.querySelector('br')).not.toBeNull();
    expect(
      Array.from(editor.childNodes).some((node) => node.nodeType === Node.TEXT_NODE),
    ).toBe(true);
  });

  it('keeps the placeholder mounted so the first IME letter does not remount siblings', () => {
    render(<ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(document.querySelector('.chat-input-placeholder')).not.toBeNull();
  });

  it('still syncs ordinary non-IME typing', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <ChatInput
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const editor = screen.getByRole('textbox');
    editor.textContent = 'hello';
    fireEvent.input(editor);
    await flushComposerSync();
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('does not mount the highlight mirror before the first letter is committed', () => {
    render(<ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'n' });
    editor.textContent = 'n';
    fireEvent.input(editor);
    expect(document.querySelector('.chat-input-mirror')).toBeNull();
  });
});

describe('ChatInput composer meta row', () => {
  const agent = {
    id: 'local-assistant',
    slug: 'local-assistant',
    name: '电脑操作员',
    icon: null,
    color: '#7c3aed',
    description: null,
    rolePrompt: null,
    isBuiltin: true,
  };

  function renderComposer(ui: ReactElement) {
    return render(<MemoryRouter>{ui}</MemoryRouter>);
  }

  it('renders the agent picker after leadingChrome, above the input box', () => {
    renderComposer(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        currentAgent={agent}
        agents={[agent]}
        onSelectAgent={vi.fn()}
        leadingChrome={<button type="button">选择项目</button>}
      />,
    );

    const row = screen.getByTestId('composer-meta-row');
    const project = screen.getByRole('button', { name: '选择项目' });
    const picker = screen.getByTestId('agent-select');
    const composer = screen.getByTestId('chat-composer');

    expect(row.contains(project)).toBe(true);
    expect(row.contains(picker)).toBe(true);
    expect(
      project.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      picker.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders trailingChrome on the right side of composer-meta-row', () => {
    renderComposer(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        currentAgent={agent}
        agents={[agent]}
        onSelectAgent={vi.fn()}
        leadingChrome={<button type="button">选择项目</button>}
        trailingChrome={<div data-testid="test-todo">任务清单</div>}
      />,
    );

    const row = screen.getByTestId('composer-meta-row');
    const trailing = screen.getByTestId('test-todo');
    expect(row.contains(trailing)).toBe(true);
    expect(row.className).toContain('items-end');
    expect(trailing.parentElement?.className).toContain('ml-auto');
  });

  it('clicking another expert switches the current agent instead of inserting @mention', () => {
    const other = {
      ...agent,
      id: 'all-round-assistant',
      slug: 'all-round-assistant',
      name: '智能助手',
    };
    const onSelectAgent = vi.fn();
    const onChange = vi.fn();
    renderComposer(
      <ChatInput
        value=""
        onChange={onChange}
        onSubmit={vi.fn()}
        currentAgent={agent}
        selectedAgentId={agent.id}
        agents={[agent, other]}
        onSelectAgent={onSelectAgent}
      />,
    );

    fireEvent.click(screen.getByTestId('agent-select'));
    fireEvent.click(screen.getByTestId('agent-option-all-round-assistant'));

    expect(onSelectAgent).toHaveBeenCalledWith('all-round-assistant');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows selectedAgentId as the current expert even if currentAgent is stale', () => {
    const other = {
      ...agent,
      id: 'all-round-assistant',
      slug: 'all-round-assistant',
      name: '智能助手',
    };
    renderComposer(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        currentAgent={agent}
        selectedAgentId={other.id}
        agents={[agent, other]}
        onSelectAgent={vi.fn()}
      />,
    );

    expect(screen.getByTestId('agent-select').textContent).toContain('Assistant');
    fireEvent.click(screen.getByTestId('agent-select'));
    expect(screen.getByTestId('agent-option-all-round-assistant').textContent).toContain('Current');
  });

  it('opens 智能体管理 from the picker footer', () => {
    function LocationProbe() {
      const loc = useLocation();
      return (
        <div data-testid="loc">
          {loc.pathname}
          {loc.search}
        </div>
      );
    }
    render(
      <MemoryRouter>
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          currentAgent={agent}
          agents={[agent]}
          onSelectAgent={vi.fn()}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('agent-select'));
    fireEvent.click(screen.getByTestId('agent-manage'));
    expect(screen.getByTestId('loc').textContent).toBe('/settings?section=plugins&tab=agents');
  });

  it('turns an @mention into a chip that click-removes it', () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('@电脑操作员 你好');
      return (
        <ChatInput
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onSubmit={vi.fn()}
          currentAgent={agent}
          agents={[agent]}
          onSelectAgent={vi.fn()}
        />
      );
    }
    renderComposer(<Harness />);

    const chip = screen.getByRole('button', { name: 'Remove @电脑操作员' });
    expect(chip.className).toContain('px-1.5');
    expect(chip.className).toContain('py-0.5');
    const remove = chip.querySelector('[data-mention-remove]');
    expect(remove?.className).toContain('opacity-0');
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith('你好');
  });

  it('renders mention chips inside the editor without blocking trailing text', () => {
    renderComposer(
      <ChatInput
        value="@电脑操作员 111"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        currentAgent={agent}
        agents={[agent]}
      />,
    );

    const editor = screen.getByRole('textbox');
    const chip = screen.getByRole('button', { name: 'Remove @电脑操作员' });
    expect(editor.contains(chip)).toBe(true);
    // Trailing text ' 111' is a sibling node after chip in the editor layout flow
    expect(editor.textContent).toBe('@电脑操作员 111');
    expect(chip.nextSibling?.textContent).toBe(' 111');
  });

  it('turns a tool into a chip that click-removes it and does not block text', () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('/mcp__sqlite__query 查询数据');
      return (
        <ChatInput
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<Harness />);

    const chip = screen.getByRole('button', { name: 'Remove /mcp__sqlite__query' });
    expect(chip.className).toContain('px-1.5');
    expect(chip.className).toContain('py-0.5');
    expect(chip.getAttribute('data-mention-type')).toBe('mcp');
    const remove = chip.querySelector('[data-mention-remove]');
    expect(remove?.className).toContain('opacity-0');
    expect(chip.nextSibling?.textContent).toBe(' 查询数据');

    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith('查询数据');
  });

  it('turns a skill tool into a chip with amber styling and click-removes it', () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('/read-workspace 看看工区');
      return (
        <ChatInput
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onSubmit={vi.fn()}
          skills={[{ name: 'read-workspace', description: 'Read workspace' }]}
        />
      );
    }
    render(<Harness />);

    const chip = screen.getByRole('button', { name: 'Remove /read-workspace' });
    expect(chip.className).toContain('px-1.5');
    expect(chip.className).toContain('py-0.5');
    expect(chip.getAttribute('data-mention-type')).toBe('skill');
    const remove = chip.querySelector('[data-mention-remove]');
    expect(remove?.className).toContain('opacity-0');
    expect(chip.nextSibling?.textContent).toBe(' 看看工区');

    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith('看看工区');
  });

  it('selecting an option from slash menu inserts and renders a tool chip', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <ChatInput
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onSubmit={vi.fn()}
          skills={[{ name: 'web-search', displayName: '网络搜索', description: '网页检索' }]}
        />
      );
    }
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    editor.textContent = '/';
    fireEvent.input(editor);
    await flushComposerSync();

    const slashOption = screen.getByTestId('slash-option-skill-web-search');
    fireEvent.click(slashOption);
    await flushComposerSync();

    const chip = screen.getByRole('button', { name: 'Remove /web-search' });
    expect(chip.className).toContain('px-1.5');
    expect(chip.className).toContain('py-0.5');
    expect(chip.getAttribute('data-mention-type')).toBe('skill');
    expect(onChange).toHaveBeenCalledWith('/web-search ');
  });

  it('filters out internal skills like plan-mode, identity, and tool-usage from slash suggestions', async () => {
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          skills={[
            { name: 'identity', id: '00-identity', description: 'Identity skill' },
            { name: 'plan-mode', id: '70-plan-mode', description: 'Plan mode skill' },
            { name: 'tool-usage', id: '80-tool-usage', description: 'Tool usage' },
            { name: 'anti-deferred-execution', id: '81-anti-deferred', description: 'Anti deferred' },
            { name: 'data-grounding', id: '82-data-grounding', description: 'Data grounding' },
            { name: 'local-exec', id: '85-local-exec', description: 'Local exec' },
            { name: 'proactive-coding', id: '86-proactive-coding', description: 'Proactive coding' },
            { name: 'goal', id: '10-goal', displayName: '目标跟踪', description: '目标与验收' },
            { name: 'loop', id: '11-loop', displayName: '循环执行', description: '重复执行' },
            {
              name: 'create-skill',
              id: '12-create-skill',
              displayName: '创建技能',
              description: '创建本地技能',
            },
            { name: 'web-search', displayName: '网络搜索', description: '网页检索' },
          ]}
        />
      );
    }
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    editor.textContent = '/';
    fireEvent.input(editor);
    await flushComposerSync();

    expect(screen.queryByTestId('slash-option-skill-identity')).toBeNull();
    expect(screen.queryByTestId('slash-option-skill-plan-mode')).toBeNull();
    expect(screen.queryByTestId('slash-option-skill-tool-usage')).toBeNull();
    expect(screen.queryByTestId('slash-option-skill-anti-deferred-execution')).toBeNull();
    expect(screen.queryByTestId('slash-option-skill-data-grounding')).toBeNull();
    expect(screen.queryByTestId('slash-option-skill-local-exec')).toBeNull();
    expect(screen.queryByTestId('slash-option-skill-proactive-coding')).toBeNull();
    // 场景包技能的隐藏（如某场景包的 90-xxx 技能）由包渲染层声明，
    // 覆盖在消费方产品的包测试中。
    expect(screen.getByTestId('slash-option-skill-web-search')).toBeTruthy();
    // 面向用户的内置工作流技能必须留在菜单里
    expect(screen.getByTestId('slash-option-skill-goal')).toBeTruthy();
    expect(screen.getByTestId('slash-option-skill-loop')).toBeTruthy();
    expect(screen.getByTestId('slash-option-skill-create-skill')).toBeTruthy();
  });
});

describe('ChatInput 命令沙箱选择器', () => {
  it('renders the picker and forwards a switch to full access', () => {
    const onExecPolicyChange = vi.fn();
    renderInput({
      execPolicy: 'workspace',
      onExecPolicyChange,
    });

    fireEvent.click(screen.getByTestId('exec-policy-picker'));
    fireEvent.click(screen.getByTestId('exec-policy-full'));
    expect(onExecPolicyChange).toHaveBeenCalledWith('full');
  });

  it('hides the picker when the change handler is omitted', () => {
    renderInput({ execPolicy: 'workspace' });
    expect(screen.queryByTestId('exec-policy-picker')).toBeNull();
  });
});

function pasteClipboard(
  clipboardData: {
    items?: Array<{ kind: string; type: string; getAsFile: () => File | null }>;
    files?: File[];
    getData: (type: string) => string;
  },
) {
  fireEvent.paste(screen.getByTestId('chat-composer'), { clipboardData });
}

describe('ChatInput 粘贴图片', () => {
  it('截图（image.png）进入附件并改成唯一文件名，不写入正文', () => {
    const onChange = vi.fn();
    renderInput({ onChange });
    const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
    pasteClipboard({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: () => '',
    });
    expect(screen.getByText(/^pasted-.*\.png$/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('带真实文件名的图片保留原名', () => {
    renderInput();
    const file = new File(['x'], '截图.png', { type: 'image/png' });
    pasteClipboard({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: () => '',
    });
    expect(screen.getByText('截图.png')).toBeTruthy();
  });

  it('纯文本粘贴仍写入输入框', () => {
    const onChange = vi.fn();
    renderInput({ onChange });
    pasteClipboard({
      items: [],
      getData: (type) => (type === 'text/plain' ? '你好' : ''),
    });
    expect(onChange).toHaveBeenCalledWith('你好');
    expect(screen.queryByText(/^pasted-/)).toBeNull();
  });

  it('没有宿主剪贴板时，空剪贴板的粘贴交给浏览器默认行为', () => {
    renderInput();
    const editor = screen.getByTestId('chat-composer');
    const canceled = !fireEvent.paste(editor, {
      clipboardData: { items: [], files: [], getData: () => '' },
    });
    expect(canceled).toBe(false);
  });

  it('输入过中文后再粘贴，内容立即显示', async () => {
    function Harness() {
      const [value, setValue] = useState('');
      return <ChatInput value={value} onChange={setValue} onSubmit={vi.fn()} />;
    }
    render(<Harness />);
    const editor = screen.getByTestId('chat-composer');
    editor.focus();
    fireEvent.keyDown(editor, { key: 'n' });
    fireEvent.keyDown(editor, { key: 'Process', keyCode: 229 });
    fireEvent.compositionStart(editor);
    editor.textContent = '你好';
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Process', keyCode: 229 });
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(editor, new CustomEvent('hostpaste', { detail: '世界', cancelable: true }));
    await flushComposerSync();
    expect(editor.textContent).toBe('你好世界');
    expect(editor.getAttribute('data-composing')).toBeNull();
  });

  it('Tauri 拖到输入框上的文件成为附件，框外的放下不收', async () => {
    window.__TAURI_INTERNALS__ = {};
    try {
      renderInput();
      await act(async () => {});
      const box = document.querySelector('.chat-input-box');
      if (!(box instanceof HTMLElement)) throw new Error('missing composer box');
      vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 80,
        width: 200,
        height: 80,
        toJSON() {
          return {};
        },
      });
      await act(async () => {
        tauriDrop.handler?.({ type: 'over', position: { x: 10, y: 10 } });
      });
      expect(box.className).toContain('border-blue-500');
      await act(async () => {
        tauriDrop.handler?.({
          type: 'drop',
          paths: ['/tmp/纪要.docx'],
          position: { x: 10, y: 10 },
        });
      });
      expect(screen.getByText('纪要.docx')).toBeTruthy();
      expect(box.className).not.toContain('border-blue-500');
      await act(async () => {
        tauriDrop.handler?.({
          type: 'drop',
          paths: ['/tmp/other.txt'],
          position: { x: 900, y: 900 },
        });
      });
      expect(screen.queryByText('other.txt')).toBeNull();
    } finally {
      delete window.__TAURI_INTERNALS__;
    }
  });

  it('系统剪贴板里的文件路径进入附件，不写入正文', async () => {
    const onChange = vi.fn();
    const readClipboard = vi.fn().mockResolvedValue({
      text: '',
      files: [{ name: '纪要.docx', path: '/tmp/纪要.docx' }],
    });
    const spy = vi.spyOn(electronBridge, 'getHostBridge').mockReturnValue({
      readClipboard,
    } as Partial<electronBridge.HostBridge> as electronBridge.HostBridge);
    renderInput({ onChange });
    const editor = screen.getByTestId('chat-composer');
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: { items: [], files: [], getData: () => '' },
    });
    try {
      await act(async () => {});
      expect(readClipboard).toHaveBeenCalled();
      expect(screen.getByText('纪要.docx')).toBeTruthy();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('系统剪贴板里的截图进入附件', async () => {
    const readClipboard = vi.fn().mockResolvedValue({
      text: '',
      files: [{ name: 'image.png', dataBase64: btoa('png'), mime: 'image/png' }],
    });
    const spy = vi.spyOn(electronBridge, 'getHostBridge').mockReturnValue({
      readClipboard,
    } as Partial<electronBridge.HostBridge> as electronBridge.HostBridge);
    renderInput();
    fireEvent.paste(screen.getByTestId('chat-composer'), {
      clipboardData: { items: [], files: [], getData: () => '' },
    });
    try {
      await act(async () => {});
      expect(screen.getByText(/^pasted-.*\.png$/)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('Ctrl+V 读系统剪贴板，输入法把 key 标成非 v 时也粘贴', async () => {
    const onChange = vi.fn();
    const readClipboard = vi.fn().mockResolvedValue({ text: '快捷键', files: [] });
    const spy = vi.spyOn(electronBridge, 'getHostBridge').mockReturnValue({
      readClipboard,
    } as Partial<electronBridge.HostBridge> as electronBridge.HostBridge);
    renderInput({ onChange });
    const editor = screen.getByTestId('chat-composer');
    editor.focus();
    const canceled = !fireEvent.keyDown(editor, { key: 'Unidentified', code: 'KeyV', ctrlKey: true });
    try {
      await act(async () => {});
      expect(canceled).toBe(true);
      expect(readClipboard).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledWith('快捷键');
    } finally {
      spy.mockRestore();
    }
  });

  it('富剪贴板命令被拒绝时，Ctrl+V 仍粘贴纯文本', async () => {
    const onChange = vi.fn();
    const readClipboard = vi.fn().mockRejectedValue(new Error('not allowed'));
    const readClipboardText = vi.fn().mockResolvedValue('纯文本');
    const spy = vi.spyOn(electronBridge, 'getHostBridge').mockReturnValue({
      readClipboard,
      readClipboardText,
    } as Partial<electronBridge.HostBridge> as electronBridge.HostBridge);
    renderInput({ onChange });
    const editor = screen.getByTestId('chat-composer');
    editor.focus();
    fireEvent.keyDown(editor, { key: 'v', ctrlKey: true });
    try {
      await act(async () => {});
      expect(readClipboardText).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledWith('纯文本');
    } finally {
      spy.mockRestore();
    }
  });

  it('Tauri 页面剪贴板为空时改读系统剪贴板', async () => {
    const onChange = vi.fn();
    const readClipboardText = vi.fn().mockResolvedValue('系统剪贴板');
    const spy = vi.spyOn(electronBridge, 'getHostBridge').mockReturnValue({
      readClipboardText,
    } as Partial<electronBridge.HostBridge> as electronBridge.HostBridge);
    renderInput({ onChange });
    const editor = screen.getByTestId('chat-composer');
    editor.focus();
    fireEvent.paste(editor, {
      clipboardData: { items: [], files: [], getData: () => '' },
    });
    try {
      await act(async () => {});
      expect(readClipboardText).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledWith('系统剪贴板');
    } finally {
      spy.mockRestore();
    }
  });
});
