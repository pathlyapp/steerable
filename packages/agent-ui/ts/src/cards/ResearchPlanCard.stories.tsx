import type { Meta, StoryObj } from '@storybook/react';
import { ResearchPlanCard } from './ResearchPlanCard.js';

const meta: Meta<typeof ResearchPlanCard> = {
  title: 'Cards/ResearchPlanCard',
  component: ResearchPlanCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Multi-round research planner card tracking sub-questions, evidence strength, and continuation decisions.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[520px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ResearchPlanCard>;

export const Default: Story = {
  args: {
    totalRounds: 3,
    payload: {
      topic: 'Flash-model tool-call failure modes on Terminal-Bench 2.1',
      round: 2,
      final: false,
      subQuestions: [
        {
          id: 'sq-1',
          question: 'How often do quantized models emit plain-text XML tool calls?',
          kind: 'fact',
          status: 'evidenced_strong',
          evidenceCount: 14,
          note: 'Measured across 89 TB 2.1 tasks.',
        },
        {
          id: 'sq-2',
          question: 'Which completion veto rule prevents false-positive success claims?',
          kind: 'risk',
          status: 'pending',
          evidenceCount: 2,
          note: null,
        },
      ],
      decision: {
        next: 'expand',
        reason: 'Collect token calibration traces for DeepSeek-V3.1-0731.',
      },
    },
  },
};
