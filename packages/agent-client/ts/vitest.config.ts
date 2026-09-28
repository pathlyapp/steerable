import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shellSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent-shell/ts/src');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@steerable/agent-shell': shellSrc,
    },
  },
});
