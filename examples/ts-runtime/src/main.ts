/**
 * One turn through `@steerable/agent-runtime`.
 *
 * The runtime owns the sidecar: it finds the interpreter (the platform npm
 * package on an installed CLI, a repo virtualenv in a checkout), spawns it,
 * waits for `lifecycle.ready`, and streams the turn back as typed events.
 *
 * Run it against a real provider:
 *
 *   STEERABLE_BASE_URL=https://api.deepseek.com \
 *   STEERABLE_API_KEY=sk-... \
 *   pnpm --filter steerable-example-ts-runtime start
 *
 * Without a base URL the example still boots the sidecar and prints the model
 * list, which is enough to prove the install works without spending tokens.
 */
import { AgentRuntime } from '@steerable/agent-runtime';
import type { SSEEvent } from '@steerable/agent-protocol';

const baseUrl = process.env.STEERABLE_BASE_URL ?? '';
const apiKey = process.env.STEERABLE_API_KEY ?? '';
const model = process.env.STEERABLE_MODEL ?? 'deepseek-chat';

const runtime = new AgentRuntime();
try {
  await runtime.start();
  console.log(`[ready] sidecar pid=${runtime.process.pid ?? 'n/a'}`);

  console.log(`[tools] ${(await runtime.listTools()).length} tools registered`);

  if (!baseUrl || !apiKey) {
    console.log('[skip] set STEERABLE_BASE_URL and STEERABLE_API_KEY to run a turn');
  } else {
    const turn = await runtime.chatStream({
      provider: 'openai_compat',
      model,
      baseUrl,
      apiKey,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    let text = '';
    for await (const event of turn.events) {
      const wire = event as SSEEvent;
      if (wire.type === 'content' && typeof wire.content === 'string') text += wire.content;
      if (wire.type === 'error') throw new Error(wire.message ?? 'turn failed');
      if (wire.type === 'done') break;
    }
    await turn.done;
    console.log(`[turn] ${text.trim() || '(no text)'}`);
  }
} finally {
  await runtime.close();
  console.log('[bye] sidecar stopped');
}
