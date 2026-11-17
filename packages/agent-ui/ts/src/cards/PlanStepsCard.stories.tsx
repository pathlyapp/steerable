import type { Meta, StoryObj } from '@storybook/react';
import { PlanStepsCard } from './PlanStepsCard.js';

const meta: Meta<typeof PlanStepsCard> = {
  title: 'Cards/PlanStepsCard',
  component: PlanStepsCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Compact inline plan-steps breadcrumb card emitted during quick multi-step execution.',
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
type Story = StoryObj<typeof PlanStepsCard>;

export const Default: Story = {
  args: {
    payload: {
      steps: ['Inspect schema', 'Run unit tests', 'Verify output'],
    },
  },
};
