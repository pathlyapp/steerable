import type { Meta, StoryObj } from '@storybook/react';
import { CoverageReportCard } from './CoverageReportCard.js';

const meta: Meta<typeof CoverageReportCard> = {
  title: 'Cards/CoverageReportCard',
  component: CoverageReportCard,
  parameters: {
    layout: 'centered',
    actions: { argTypesRegex: '^on[A-Z].*' },
    docs: {
      description: {
        component:
          'Displays topic coverage, mastery metrics, weak points, and optional remediation selection.',
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
type Story = StoryObj<typeof CoverageReportCard>;

export const Default: Story = {
  args: {
    allowWeakPointSelection: true,
    onRemediate: () => {},
    payload: {
      reportId: 'cov-1',
      title: 'Harness Conformance Coverage',
      overallCoverage: 0.86,
      overallMastery: 0.79,
      summary: 'Strong coverage on wire types and retries; two edge cases flagged for follow-up.',
      sections: [
        {
          id: 'sec-proto',
          name: 'Protocol Schema',
          coverage: 0.95,
          mastery: 0.92,
          totalCount: 20,
          learnedCount: 19,
          testedCount: 19,
          masteredCount: 18,
          weakKpIds: [],
        },
        {
          id: 'sec-recovery',
          name: 'Tool Recovery',
          coverage: 0.78,
          mastery: 0.68,
          totalCount: 14,
          learnedCount: 11,
          testedCount: 11,
          masteredCount: 10,
          weakKpIds: ['wp-1'],
        },
      ],
      weakPoints: [
        {
          id: 'wp-1',
          name: 'Unclosed nested XML tool tag',
          sectionName: 'Tool Recovery',
          accuracy: 0.55,
          recommendation: 'Add edge-case regression test for truncated XML parameters.',
        },
      ],
      actions: {
        allowRemediateQuiz: true,
        remediateActionLabel: 'Practice weak points',
      },
    },
  },
};
