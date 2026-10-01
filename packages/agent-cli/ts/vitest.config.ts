import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/tui-failure-setup.ts'],
  },
  resolve: {
    alias: [
      { find: '@steerable/agent-client', replacement: path.resolve(root, '../../agent-client/ts/src/index.ts') },
      { find: '@steerable/agent-shell', replacement: path.resolve(root, '../../agent-shell/ts/src') },
    ],
  },
});
