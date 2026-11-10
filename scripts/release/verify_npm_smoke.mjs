/**
 * Import check for a packed release batch.
 *
 * Lives in this directory rather than inline in the verification script so the
 * package names are typed out once and a reviewer can read what is asserted.
 * Every import is by published name: that is the boundary the monorepo's
 * `tsc` run cannot see through.
 */
import { decideToolMode, consumeBudget, isTerminalResult } from '@steerable/agent-harness';
import { RUNTIME_TARGETS } from '@steerable/agent-protocol';
import { AgentRuntime, resolvePlatformRuntime } from '@steerable/agent-runtime';

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const mode = decideToolMode('read_file');
const { state } = consumeBudget(
  { tokensUsed: 0, stepsUsed: 0, toolCallsUsed: 0 },
  { maxTokens: 100, maxSteps: 5, maxToolCalls: 3 },
  { toolCall: true, tokens: 10, step: true },
);
const done = isTerminalResult({ success: true, terminal: true });
check(mode === 'read', `decideToolMode returned ${mode}`);
check(done, 'isTerminalResult did not recognize a terminal result');

// The symbol whose absence broke a release: it must be in the packed protocol
// tarball, not only in the workspace source.
check(Array.isArray(RUNTIME_TARGETS) && RUNTIME_TARGETS.length === 5, 'protocol tarball lacks RUNTIME_TARGETS');
check(typeof AgentRuntime === 'function', 'runtime tarball does not export AgentRuntime');

// No platform bundle is downloaded here (it is 300 MB), so resolution must
// report a reason instead of throwing.
const platform = resolvePlatformRuntime();
check(
  platform.kind === 'ok' ||
    (platform.kind === 'error' && ['not_installed', 'unsupported_platform'].includes(platform.reason)),
  `unexpected platform resolution: ${JSON.stringify(platform)}`,
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAILED: ${failure}`);
  process.exit(1);
}
console.log('TS OK:', JSON.stringify({ mode, state, done, platform: platform.kind }));
