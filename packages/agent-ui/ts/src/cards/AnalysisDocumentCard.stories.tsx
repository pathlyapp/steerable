import type { Meta, StoryObj } from '@storybook/react';
import { AnalysisDocumentCard } from './AnalysisDocumentCard.js';

const meta: Meta<typeof AnalysisDocumentCard> = {
  title: 'Cards/AnalysisDocumentCard',
  component: AnalysisDocumentCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Structured long-form analysis report container with pluggable `renderMarkdown` and footer slots.',
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
type Story = StoryObj<typeof AnalysisDocumentCard>;

export const Default: Story = {
  args: {
    payload: {
      title: 'Sandbox & Egress Confinement Audit',
      createdAt: '2026-11-17T09:00:00Z',
      modelId: 'glm-5.3-flash',
      body: 'All 38 JSON-RPC sidecar methods operate under Seatbelt/bwrap confinement with per-host CONNECT allow-listing.',
    },
    renderMarkdown: (body) => <p className="text-sm leading-relaxed">{body}</p>,
  },
};
