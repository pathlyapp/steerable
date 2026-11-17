import type { Meta, StoryObj } from '@storybook/react';
import { ThinkingProcessCard } from './ThinkingProcessCard.js';

const meta: Meta<typeof ThinkingProcessCard> = {
  title: 'Cards/ThinkingProcessCard',
  component: ThinkingProcessCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Collapsible reasoning block supporting streaming auto-expand, elapsed thinking duration, and custom markdown rendering.',
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
type Story = StoryObj<typeof ThinkingProcessCard>;

export const Expanded: Story = {
  args: {
    durationMs: 1420,
    payload: {
      defaultExpanded: true,
      body: 'Round 1 emitted a plain-text <function=local_exec_shell> block. Parsing arguments, running inside Seatbelt confinement, and verifying pytest output before replying.',
    },
  },
};

export const Streaming: Story = {
  args: {
    isStreaming: true,
    autoExpandWhileStreaming: true,
    payload: {
      defaultExpanded: true,
      body: 'Checking runtime contract against generated TypeScript and Pydantic schemas…',
    },
  },
};
