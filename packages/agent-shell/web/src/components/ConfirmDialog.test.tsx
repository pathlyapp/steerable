import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('associates a failed action with the open dialog', () => {
    render(
      <ConfirmDialog
        open
        title="Delete chat"
        description="This cannot be undone"
        error="delete unavailable"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('delete unavailable');
    expect(dialog.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('traps keyboard focus and restores it after Escape', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Delete chat"
        description="This cannot be undone"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(document.activeElement).toBe(cancel);

    confirm.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(
      <ConfirmDialog
        open={false}
        title="Delete chat"
        description="This cannot be undone"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
