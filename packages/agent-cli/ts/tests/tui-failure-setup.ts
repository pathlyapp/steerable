import { beforeEach } from 'vitest';

import {
  resetTuiArtifactCaptures,
  writeTuiFailureArtifacts,
} from './tui-artifacts.js';

beforeEach((context) => {
  resetTuiArtifactCaptures();
  context.onTestFailed(async (failed) => {
    await writeTuiFailureArtifacts(JSON.stringify(failed.task.result?.errors ?? []));
  });
});
