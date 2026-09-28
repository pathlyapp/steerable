import { ProcessTerminal, TuiAltScreen, type Terminal } from '@earendil-works/pi-tui';
import type { AgentClient } from '@steerable/agent-client';

import { installAgentKeybindings } from './keys.js';
import { AgentTui } from './session.js';

export async function runTui(options: {
  client: AgentClient;
  product: string;
  dataDir?: string;
  terminal?: Terminal;
}): Promise<number> {
  installAgentKeybindings();
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  return new Promise((resolve) => {
    const session = new AgentTui(options.client, {
      product: options.product,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      onChange() {
        tui.requestRender();
      },
      onExit() {
        tui.stop();
        resolve(0);
      },
    });
    tui.addChild(session);
    tui.setFocus(session);
    void session.open().then(() => tui.requestRender());
    tui.start();
  });
}
