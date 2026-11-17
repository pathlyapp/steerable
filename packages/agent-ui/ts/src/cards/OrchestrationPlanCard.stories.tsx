import type { Meta, StoryObj } from '@storybook/react';
import { OrchestrationPlanCard } from './OrchestrationPlanCard.js';

const meta: Meta<typeof OrchestrationPlanCard> = {
  title: 'Cards/OrchestrationPlanCard',
  component: OrchestrationPlanCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Schema-backed multi-agent orchestration plan card (`@steerable/agent-ui/cards`) tracking delegated tasks and live statuses.',
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
type Story = StoryObj<typeof OrchestrationPlanCard>;

export const Default: Story = {
  args: {
    payload: {
      rationale: 'Verify protocol drift and run sandbox conformance checks in parallel.',
      mode: 'parallel',
      tasks: [
        { id: 't1', agentId: 'spec-auditor', prompt: 'Validate runtime-contract.json against TS & Py types' },
        { id: 't2', agentId: 'sandbox-tester', prompt: 'Verify Seatbelt & CONNECT egress allow-list rules' },
        { id: 't3', agentId: 'reporter', prompt: 'Compile summary deliverable' },
      ],
    },
    taskStatuses: {
      t1: 'ok',
      t2: 'running',
      t3: 'pending',
    },
  },
};
