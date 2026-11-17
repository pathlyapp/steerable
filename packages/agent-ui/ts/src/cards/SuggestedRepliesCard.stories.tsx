import type { Meta, StoryObj } from '@storybook/react';
import { SuggestedRepliesCard } from './SuggestedRepliesCard.js';

const meta: Meta<typeof SuggestedRepliesCard> = {
  title: 'Cards/SuggestedRepliesCard',
  component: SuggestedRepliesCard,
  parameters: {
    layout: 'centered',
    actions: { argTypesRegex: '^on[A-Z].*' },
    docs: {
      description: {
        component:
          'Follow-up suggestion chips rendered after an assistant turn completes.',
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
type Story = StoryObj<typeof SuggestedRepliesCard>;

export const Default: Story = {
  args: {
    onSelect: () => {},
    payload: {
      suggestions: [
        'Run the parser unit tests',
        'Inspect Seatbelt sandbox rules',
        'Export audit-report.md',
      ],
    },
  },
};
