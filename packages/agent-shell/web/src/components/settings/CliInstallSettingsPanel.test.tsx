import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CliInstallSettingsPanel } from './CliInstallSettingsPanel';

afterEach(() => {
  cleanup();
});

describe('CliInstallSettingsPanel', () => {
  it('installs the command and shows the path', async () => {
    render(
      <CliInstallSettingsPanel
        binName="aroli"
        install={async () => ({ path: '/home/me/.local/bin/aroli', onPath: true })}
      />,
    );
    fireEvent.click(screen.getByTestId('cli-install-button'));
    expect((await screen.findByTestId('cli-install-message')).textContent).toContain(
      '/home/me/.local/bin/aroli',
    );
  });

  it('says when the directory is not on PATH', async () => {
    render(
      <CliInstallSettingsPanel
        binName="aroli"
        install={async () => ({ path: '/home/me/.local/bin/aroli', onPath: false })}
      />,
    );
    fireEvent.click(screen.getByTestId('cli-install-button'));
    expect((await screen.findByTestId('cli-install-message')).textContent).toContain('PATH');
  });
});
