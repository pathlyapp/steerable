/**
 * Minimal OpenAI-compatible gateway for tests and quickstart checks.
 *
 * Serves `/v1/models` and a streaming `/v1/chat/completions`, records how many
 * requests it received, and can be told to fail in the ways a provider fails.
 * No key is checked: the point is to exercise the client path, not auth.
 */
import { createServer } from 'node:http';


/**
 * Starts the gateway on an ephemeral loopback port.
 *
 * @param options Failure mode and canned reply.
 * @returns Handle with the base URL and request counters.
 */
export async function startFakeGateway(options = {}) {
  const reply = options.reply ?? 'hello from the fake gateway';
  const models = options.models ?? ['fake-model'];
  const state = { requests: 0, completions: 0 };

  const server = createServer((request, response) => {
    state.requests += 1;
    const url = request.url ?? '/';
    if (url.startsWith('/v1/models')) return writeJson(response, 200, modelList(models));
    if (url.startsWith('/v1/chat/completions')) {
      state.completions += 1;
      return handleCompletion(request, response, options.failure, reply);
    }
    writeJson(response, 404, { error: { message: `unknown path ${url}` } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake gateway did not bind a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return state.requests;
    },
    get completions() {
      return state.completions;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function modelList(models) {
  return {
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })),
  };
}

function handleCompletion(request, response, failure, reply) {
  // Drain the body so keep-alive connections stay usable.
  request.resume();
  request.on('end', () => {
    switch (failure) {
      case 'auth':
        writeJson(response, 401, { error: { message: 'Authentication Fails (fake)', type: 'auth' } });
        return;
      case 'rate_limit':
        writeJson(response, 429, { error: { message: 'Rate limit reached (fake)', type: 'rate_limit' } });
        return;
      case 'server':
        writeJson(response, 500, { error: { message: 'Internal error (fake)', type: 'server' } });
        return;
      case 'disconnect':
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': partial\n\n');
        response.socket?.destroy();
        return;
      default:
        break;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    );
    response.write('data: [DONE]\n\n');
    response.end();
  });
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
