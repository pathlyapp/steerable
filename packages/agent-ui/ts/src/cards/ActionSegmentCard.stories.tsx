import type { Meta, StoryObj } from '@storybook/react';
import { ActionSegmentCard } from './ActionSegmentCard.js';

const meta: Meta<typeof ActionSegmentCard> = {
  title: 'Cards/ActionSegmentCard',
  component: ActionSegmentCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Groups sequential or parallel tool segments inside a single assistant turn using `ToolExecutionCard` rows.',
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
type Story = StoryObj<typeof ActionSegmentCard>;

export const Default: Story = {
  args: {
    payload: {
      segments: [
        {
          id: 'seg-1',
          kind: 'local_read_file',
          status: 'succeeded',
          label: 'Read docs/spec/runtime-contract.json',
          args: { path: 'docs/spec/runtime-contract.json' },
          output: '38 RPC methods loaded',
          error: null,
          startedAt: null,
          finishedAt: null,
        },
        {
          id: 'seg-2',
          kind: 'local_exec_shell',
          status: 'running',
          label: 'Running conformance checks',
          args: { command: 'pnpm --filter @steerable/agent-protocol test' },
          output: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
    },
  },
};
