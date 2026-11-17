import type { Meta, StoryObj } from '@storybook/react';
import { SummaryMessageCard } from './SummaryMessageCard.js';

const meta: Meta<typeof SummaryMessageCard> = {
  title: 'Cards/SummaryMessageCard',
  component: SummaryMessageCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Displays compacted conversation history summaries with card and inline appearances.',
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
type Story = StoryObj<typeof SummaryMessageCard>;

export const CardExpanded: Story = {
  args: {
    defaultExpanded: true,
    payload: {
      summarizedCount: 14,
      status: 'complete',
      type: null,
      body: 'Earlier turns inspected the 5-tier workspace, verified 38 sidecar RPC methods, and patched XML tool-call recovery in src/parser.py.',
    },
  },
};

export const Inline: Story = {
  args: {
    appearance: 'inline',
    payload: {
      summarizedCount: 8,
      status: 'complete',
      type: null,
      body: 'Compacted 8 earlier turns.',
    },
  },
};
