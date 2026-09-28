/**
 * Friendly handling of a held write lease.
 *
 * `acquireWriteLeaseOrExit` takes injectable acquisition and exit so this
 * path is testable without opening a real SQLite store. The behavior under
 * test is the error mapping — a `StoreAlreadyOwnedError` becomes a readable
 * log line + exit, any other error propagates unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import { acquireWriteLeaseOrExit } from '../../src/storage/write-lease-error.js';
import { StoreAlreadyOwnedError } from '../../src/storage/write-lease.js';

describe('acquireWriteLeaseOrExit', () => {
  it('returns the constructed store on success', () => {
    const sentinel = { marker: true };
    const store = acquireWriteLeaseOrExit(() => sentinel);
    expect(store).toBe(sentinel);
  });

  it('rethrows a non-lease error unchanged', () => {
    const boom = new Error('corrupt schema');
    expect(() =>
      acquireWriteLeaseOrExit(() => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  it('logs and exits on StoreAlreadyOwnedError', async () => {
    const exitProcess = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        acquireWriteLeaseOrExit(() => {
          throw new StoreAlreadyOwnedError('/tmp/x.lock');
        }, exitProcess),
      ).toThrow(StoreAlreadyOwnedError);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('/tmp/x.lock'));
      await vi.waitFor(() => {
        expect(exitProcess).toHaveBeenCalledWith(1);
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
