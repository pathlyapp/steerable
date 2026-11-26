import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiSurfacePayload } from '@steerable/agent-protocol';
import { resetAllUiSurfaceDraftsForTests } from './ui-surface-draft.js';
import { UiSurfaceCard } from './UiSurfaceCard.js';
import { UiSurfaceWorkbench } from './UiSurfaceWorkbench.js';
import { FactChainDrawer } from './FactChainDrawer.js';

afterEach(() => {
  cleanup();
  resetAllUiSurfaceDraftsForTests();
});

const SAMPLE_SURFACE: UiSurfacePayload = {
  surfaceId: 'po-review',
  revision: 1,
  title: 'Purchase Order Workbench',
  subtitle: 'Batch review & sign-off',
  placement: 'workbench',
  resolvedData: {
    orders: [
      { id: 'PO-1', supplier: 'Alpha Steel', total: '50,000' },
      { id: 'PO-2', supplier: 'Nova Optics', total: '18,000' },
    ],
  },
  sourceHashes: { orders: 'hash_v1' },
  components: [
    {
      kind: 'steps',
      id: 'st-1',
      steps: [
        { id: 's1', label: 'Ingest', status: 'completed' },
        { id: 's2', label: 'Sign-off', status: 'active' },
      ],
    },
    {
      kind: 'table',
      id: 'tb-1',
      dataKey: 'orders',
      rowIdField: 'id',
      selectable: true,
      columns: [
        { key: 'id', label: 'Order ID' },
        { key: 'supplier', label: 'Supplier' },
        { key: 'total', label: 'Total' },
      ],
    },
    {
      kind: 'detail-card',
      id: 'dc-1',
      title: 'Policy Summary',
      fields: [{ key: 'dept', label: 'Department', value: 'Manufacturing' }],
    },
    {
      kind: 'form',
      id: 'fm-1',
      fields: [{ key: 'comment', label: 'Reviewer Comment', type: 'text', value: '' }],
    },
    {
      kind: 'kv-diff',
      id: 'kv-1',
      diffs: [{ key: 'budget_code', label: 'Budget Code', before: 'B-2025', after: 'B-2026' }],
    },
    {
      kind: 'artifact-card',
      id: 'art-1',
      artifact: {
        name: 'po_summary.xlsx',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        downloadUrl: '/api/v2/chats/chat-1/deliverables/d1/snapshot',
      },
    },
  ],
  actions: [
    {
      id: 'approve_batch',
      label: 'Approve Selected',
      toolName: 'approve_orders',
      variant: 'primary',
      requiresSelection: true,
      checkpoint: 'outward',
    },
  ],
};

describe('UiSurfaceCard, UiSurfaceWorkbench & FactChainDrawer (T-UIS-01, T-UIS-03, T-UIS-05, T-VER-03, T-VER-05)', () => {
  it('T-UIS-01 & T-UIS-05: renders all 6 closed components, retains draft across unmount/remount, and handles 409 UI_STALE + refresh', () => {
    const onOpen = vi.fn();
    render(<UiSurfaceCard payload={SAMPLE_SURFACE} onOpenWorkbench={onOpen} />);
    fireEvent.click(screen.getByTestId('ui-surface-open-workbench'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    cleanup();

    const onDispatchAction = vi.fn();
    const onRefreshSurface = vi.fn();

    const { unmount } = render(
      <UiSurfaceWorkbench
        chatId="chat-1"
        payload={SAMPLE_SURFACE}
        onDispatchAction={onDispatchAction}
        onRefreshSurface={onRefreshSurface}
      />,
    );

    expect(screen.getByTestId('surface-steps-st-1')).toBeTruthy();
    expect(screen.getByTestId('surface-table-tb-1')).toBeTruthy();
    expect(screen.getByTestId('surface-detail-dc-1')).toBeTruthy();
    expect(screen.getByTestId('surface-form-fm-1')).toBeTruthy();
    expect(screen.getByTestId('surface-kvdiff-kv-1')).toBeTruthy();
    expect(screen.getByTestId('surface-artifact-art-1')).toBeTruthy();

    // Select PO-1 and fill Reviewer Comment
    fireEvent.click(screen.getByLabelText('Select row PO-1'));
    fireEvent.change(screen.getByTestId('surface-form-input-comment'), {
      target: { value: 'Approved for Q4' },
    });

    // T-UIS-05: Unmount (tab switch) and remount -> selection & input draft remain intact!
    unmount();
    const { rerender } = render(
      <UiSurfaceWorkbench
        chatId="chat-1"
        payload={SAMPLE_SURFACE}
        staleBannerKeys={['orders']}
        onDispatchAction={onDispatchAction}
        onRefreshSurface={onRefreshSurface}
      />,
    );
    expect((screen.getByLabelText('Select row PO-1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('surface-form-input-comment') as HTMLInputElement).value).toBe(
      'Approved for Q4',
    );
    expect(screen.getByTestId('ui-surface-stale-banner')).toBeTruthy();

    // Dispatch emits commandId + expectedRevision + sourceHashes + selectedRowIds (no forged row objects)
    fireEvent.click(screen.getByTestId('ui-surface-action-approve_batch'));
    expect(onDispatchAction).toHaveBeenCalledTimes(1);
    const dispatched = onDispatchAction.mock.calls[0][0];
    expect(dispatched.commandId).toMatch(/^cmd_po-review_approve_batch_/);
    expect(dispatched.expectedRevision).toBe(1);
    expect(dispatched.selectedRowIds).toEqual(['PO-1']);
    expect(dispatched.rows).toBeUndefined();

    // Click Refresh latest data -> triggers refresh callback; rerendering with revision 2 highlights changed cell!
    fireEvent.click(screen.getByTestId('ui-surface-refresh-btn'));
    expect(onRefreshSurface).toHaveBeenCalledWith('po-review');

    rerender(
      <UiSurfaceWorkbench
        chatId="chat-1"
        payload={{
          ...SAMPLE_SURFACE,
          revision: 2,
          resolvedData: {
            orders: [
              { id: 'PO-1', supplier: 'Alpha Steel', total: '62,000' },
              { id: 'PO-2', supplier: 'Nova Optics', total: '18,000' },
            ],
          },
          sourceHashes: { orders: 'hash_v2' },
        }}
        staleBannerKeys={[]}
        onDispatchAction={onDispatchAction}
        onRefreshSurface={onRefreshSurface}
      />,
    );
    expect(screen.queryByTestId('ui-surface-stale-banner')).toBeNull();
    expect(screen.getByText('62,000').getAttribute('data-highlighted')).toBe('true');
  });

  it('T-VER-03 & T-VER-05: FactChainDrawer displays honest gap / no_tool_evidence states and modified-after-delivery warning with snapshot link', () => {
    render(
      <FactChainDrawer
        open={true}
        graph={{
          chatId: 'c-1',
          targetKind: 'deliverable',
          targetId: 'deliv-1',
          requestNode: { status: 'gap', gapReason: 'imported_without_request_snapshot' },
          evidenceStatus: 'no_tool_evidence',
          toolNodes: [],
          deliverableNode: {
            id: 'deliv-1',
            fileName: 'masked_contract.docx',
            filePath: '/tmp/masked_contract.docx',
            verificationStatus: 'verified',
            verifierSummary: 'Redaction verified',
            snapshotSha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            workspaceState: 'modified',
            snapshotDownloadUrl: '/api/v2/chats/c-1/deliverables/deliv-1/snapshot',
          },
        }}
      />,
    );

    expect(screen.getByTestId('fact-chain-request-gap')).toBeTruthy();
    expect(screen.getByTestId('fact-chain-no-tool-evidence')).toBeTruthy();
    expect(screen.getByTestId('fact-chain-workspace-drift')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      '/api/v2/chats/c-1/deliverables/deliv-1/snapshot',
    );
  });
});
