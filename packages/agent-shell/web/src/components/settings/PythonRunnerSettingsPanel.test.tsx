import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PythonRunnerSnapshot } from '@/lib/host-bridge';

const base: PythonRunnerSnapshot = {
  supported: true,
  source: 'default',
  phase: 'idle',
  defaultUrl: 'https://example.com/default.tar.gz',
  restartRequired: false,
};

const pythonRunner = vi.hoisted(() => ({
  snapshot: vi.fn<() => Promise<PythonRunnerSnapshot>>(),
  download: vi.fn<(url?: string) => Promise<PythonRunnerSnapshot>>(),
  cancel: vi.fn<() => Promise<PythonRunnerSnapshot>>(),
  pickLocal: vi.fn<() => Promise<string | null>>(),
  useLocal: vi.fn<(path: string) => Promise<PythonRunnerSnapshot>>(),
  useDefault: vi.fn<() => Promise<PythonRunnerSnapshot>>(),
  restart: vi.fn<() => Promise<void>>(),
  onState: vi.fn(() => () => {}),
}));

vi.mock('@/lib/host-bridge', () => ({
  getHostBridge: () => ({ pythonRunner }),
}));

const { PythonRunnerSettingsPanel } = await import('./PythonRunnerSettingsPanel');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pythonRunner.onState.mockReturnValue(() => {});
});

describe('PythonRunnerSettingsPanel', () => {
  it('starts a verified default download', async () => {
    pythonRunner.snapshot.mockResolvedValue(base);
    pythonRunner.download.mockResolvedValue({
      ...base,
      phase: 'downloading',
      percent: 0,
    });
    render(<PythonRunnerSettingsPanel />);

    expect(await screen.findByText('Python code runner')).toBeTruthy();
    fireEvent.click(screen.getByTestId('python-runner-action'));
    await waitFor(() => expect(pythonRunner.download).toHaveBeenCalledWith(undefined));
  });

  it('shows download progress and can cancel it', async () => {
    pythonRunner.snapshot.mockResolvedValue({
      ...base,
      phase: 'downloading',
      percent: 35,
      downloadedBytes: 35 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
    });
    pythonRunner.cancel.mockResolvedValue(base);
    render(<PythonRunnerSettingsPanel />);

    expect(await screen.findByText(/Downloading 35%/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(pythonRunner.cancel).toHaveBeenCalledOnce());
  });

  it('accepts a local Python path', async () => {
    pythonRunner.snapshot.mockResolvedValue(base);
    pythonRunner.pickLocal.mockResolvedValue('/usr/bin/python3');
    pythonRunner.useLocal.mockResolvedValue({
      ...base,
      source: 'local',
      phase: 'ready',
      configuredRunner: '/usr/bin/python3',
      restartRequired: true,
    });
    render(<PythonRunnerSettingsPanel />);

    await screen.findByText('Python code runner');
    fireEvent.click(screen.getByLabelText('Local Python'));
    fireEvent.click(screen.getByText('Choose…'));
    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText('Absolute path to the Python executable') as HTMLInputElement)
          .value,
      ).toBe('/usr/bin/python3');
    });
    fireEvent.click(screen.getByTestId('python-runner-action'));
    await waitFor(() =>
      expect(pythonRunner.useLocal).toHaveBeenCalledWith('/usr/bin/python3'),
    );
    fireEvent.click(screen.getByTestId('python-runner-restart'));
    expect(pythonRunner.restart).toHaveBeenCalledOnce();
  });
});
