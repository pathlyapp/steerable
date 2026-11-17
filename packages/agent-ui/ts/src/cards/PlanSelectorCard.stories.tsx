import type { Meta, StoryObj } from '@storybook/react';
import { PlanSelectorCard } from './PlanSelectorCard.js';

const meta: Meta<typeof PlanSelectorCard> = {
  title: 'Cards/PlanSelectorCard',
  component: PlanSelectorCard,
  parameters: {
    layout: 'centered',
    actions: { argTypesRegex: '^on[A-Z].*' },
    docs: {
      description: {
        component:
          'Interactive plan comparison card allowing users to choose among competing execution strategies.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[540px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PlanSelectorCard>;

export const Default: Story = {
  args: {
    payload: {
      comparison: 'Fast path uses GLM-5.3-Flash with deterministic recovery; thorough path adds multi-run validation.',
      goalAttribution: { type: 'new', newGoalTitle: 'Stabilize tool-call recovery' },
      plans: [
        {
          id: 'flash-fast',
          name: 'Flash + Deterministic Guard',
          summary: 'Lowest cost per solved task using GLM-5.3-Flash with grounding vetoes.',
          approach: 'Single-loop execution with automatic XML/text call recovery.',
          bestFor: 'Fast daily coding & terminal automation',
          metrics: { duration: '~15s', effortLevel: 'low', riskLevel: 'low' },
          pros: ['Lowest token cost', 'Zero graph boilerplate'],
          cons: ['Single pass on ambiguous tasks'],
        },
        {
          id: 'deep-verify',
          name: 'Multi-pass Verification',
          summary: 'Runs parallel subagents for schema audit and test verification.',
          approach: 'Coordinator + specialist subagents with post-edit test gates.',
          bestFor: 'Release-critical protocol changes',
          metrics: { duration: '~45s', effortLevel: 'high', riskLevel: 'low' },
          pros: ['Cross-checks TS and Python parity'],
          cons: ['Higher token budget'],
        },
      ],
    },
    onSelect: () => {},
  },
};
