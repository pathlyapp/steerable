import type { Meta, StoryObj } from '@storybook/react';
import { SearchSourcesCard } from './SearchSourcesCard.js';

const meta: Meta<typeof SearchSourcesCard> = {
  title: 'Cards/SearchSourcesCard',
  component: SearchSourcesCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Stacked citation pill and expandable web search source list.',
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
type Story = StoryObj<typeof SearchSourcesCard>;

export const Default: Story = {
  args: {
    payload: {
      sources: [
        {
          url: 'https://steerableframework.com/spec/overview/',
          title: 'Steerable Wire Protocol Spec',
          snippet: 'Single JSON Schema generating TypeScript and Pydantic wire models.',
          favicon: null,
          publishedAt: '2026-11-01',
        },
        {
          url: 'https://steerableframework.com/evals/',
          title: 'Terminal-Bench 2.1 Evaluation Methodology',
          snippet: '89 real terminal tasks across Flash-priced models.',
          favicon: null,
          publishedAt: '2026-11-10',
        },
      ],
    },
  },
};
