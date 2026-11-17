import type { Meta, StoryObj } from '@storybook/react';
import { AskUserQuestionsCard } from './AskUserQuestionsCard.js';

const meta: Meta<typeof AskUserQuestionsCard> = {
  title: 'Cards/AskUserQuestionsCard',
  component: AskUserQuestionsCard,
  parameters: {
    layout: 'centered',
    actions: { argTypesRegex: '^on[A-Z].*' },
    docs: {
      description: {
        component:
          'Structured multi-question prompt emitted by `ask_user`, supporting single-select, multi-select, custom free-text, and read-only answered states.',
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
type Story = StoryObj<typeof AskUserQuestionsCard>;

export const Interactive: Story = {
  args: {
    allowCustomText: true,
    onSubmit: () => {},
    onAutoContinue: () => {},
    payload: {
      intro: 'Choose how to configure the sandbox before running tests:',
      questions: [
        {
          id: 'q1',
          text: 'Which egress policy should this session enforce?',
          type: 'select',
          options: ['Allow-list only (recommended)', 'Offline (no network)', 'Audit mode'],
          multiSelect: false,
        },
      ],
    },
  },
};

export const Answered: Story = {
  args: {
    onSubmit: () => {},
    payload: {
      intro: 'Choose how to configure the sandbox before running tests:',
      questions: [
        {
          id: 'q1',
          text: 'Which egress policy should this session enforce?',
          type: 'select',
          options: ['Allow-list only (recommended)', 'Offline (no network)'],
          multiSelect: false,
        },
      ],
      answers: { q1: 'Allow-list only (recommended)' },
    },
  },
};
