import type { Meta, StoryObj } from '@storybook/react';
import { QuizCard } from './QuizCard.js';

const meta: Meta<typeof QuizCard> = {
  title: 'Cards/QuizCard',
  component: QuizCard,
  parameters: {
    layout: 'centered',
    actions: { argTypesRegex: '^on[A-Z].*' },
    docs: {
      description: {
        component:
          'Interactive multi-question quiz card supporting single/multiple choice, judge, and short-answer prompts.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[500px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof QuizCard>;

export const Default: Story = {
  args: {
    onSubmit: () => {},
    payload: {
      quizId: 'arch-check-1',
      title: 'Steerable Architecture Check',
      description: 'Verify tier dependency and protocol invariants.',
      submitActionLabel: 'Submit answers',
      questions: [
        {
          id: 'q1',
          type: 'choice',
          stem: 'Which tier owns JSON-RPC transport and OS sandboxing for desktop hosts?',
          options: ['Tier 1 Protocol', 'Tier 3 Sidecar', 'Tier 4 UI'],
          allowMultiple: false,
          placeholder: null,
          points: 10,
          knowledgePointId: null,
          difficulty: 1,
        },
      ],
    },
  },
};
