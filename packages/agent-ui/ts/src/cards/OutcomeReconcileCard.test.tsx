import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutcomeReconcileCard } from './OutcomeReconcileCard.js';

afterEach(() => {
  cleanup();
});

describe('OutcomeReconcileCard (T-OUT-07)', () => {
  it('renders amber reconciliation prompt and emits confirmed_not_executed / confirmed_succeeded without auto-retrying', () => {
    const onReconcile = vi.fn();
    render(
      <OutcomeReconcileCard
        payload={{
          reconciliationId: 'rec_998877665544',
          toolName: 'external_dispatch_order',
          argsPreview: '{"orderId":"ORD-42"}',
          errorDetail: 'timeout after 15.0s',
          status: 'pending',
        }}
        onReconcile={onReconcile}
      />,
    );

    expect(screen.getByTestId('outcome-reconcile-card')).toBeTruthy();
    expect(screen.getByText('rec_998877665544')).toBeTruthy();
    expect(screen.getByText('external_dispatch_order')).toBeTruthy();

    fireEvent.change(
      screen.getByLabelText('Optional operator verification note'),
      { target: { value: 'Checked ERP queue: not created' } },
    );
    fireEvent.click(screen.getByTestId('reconcile-not-executed'));

    expect(onReconcile).toHaveBeenCalledTimes(1);
    expect(onReconcile).toHaveBeenCalledWith({
      reconciliationId: 'rec_998877665544',
      resolution: 'confirmed_not_executed',
      note: 'Checked ERP queue: not created',
    });
  });

  it('switches to read-only summary once resolved', () => {
    render(
      <OutcomeReconcileCard
        payload={{
          reconciliationId: 'rec_resolved_1',
          toolName: 'external_dispatch_order',
          status: 'confirmed_executed',
          resolutionNote: 'Confirmed in console #88',
        }}
      />,
    );

    expect(screen.queryByTestId('reconcile-not-executed')).toBeNull();
    expect(screen.getByTestId('reconcile-resolved-summary').textContent).toContain(
      'Confirmed in console #88',
    );
  });
});
