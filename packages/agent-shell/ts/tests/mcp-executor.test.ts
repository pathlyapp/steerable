import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpExecutor,
  mcpConfigKey,
  resolveHttpHeaders,
  shouldEvictMcpConnection,
  withMcpTroubleshootHint,
  type StreamableHttpMcpServerConfig,
} from '../src/mcp-executor';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const executors: McpExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.shutdownAll()));
});

describe('shouldEvictMcpConnection', () => {
  it('does not evict a connection that has been idle for less than the timeout', () => {
    const now = 1_000_000;
    expect(
      shouldEvictMcpConnection({ lastUsed: now - 1000, inflight: 0 }, now, IDLE_TIMEOUT_MS),
    ).toBe(false);
  });

  it('evicts a connection idle for longer than the timeout with nothing in flight', () => {
    const now = 1_000_000;
    expect(
      shouldEvictMcpConnection(
        { lastUsed: now - IDLE_TIMEOUT_MS - 1, inflight: 0 },
        now,
        IDLE_TIMEOUT_MS,
      ),
    ).toBe(true);
  });

  it('never evicts a connection with an in-flight call, no matter how stale lastUsed looks', () => {
    // Regression: `lastUsed` used to be stamped when a call *started*, so a
    // single tool call running longer than IDLE_TIMEOUT_MS (e.g. a slow MCP
    // server) looked idle to the 60s sweep and got closed out from under the
    // in-flight request.
    const now = 1_000_000;
    expect(
      shouldEvictMcpConnection(
        { lastUsed: now - IDLE_TIMEOUT_MS * 10, inflight: 1 },
        now,
        IDLE_TIMEOUT_MS,
      ),
    ).toBe(false);
  });

  it('resumes normal idle eviction once inflight drops back to 0', () => {
    const now = 1_000_000;
    const staleEntry = { lastUsed: now - IDLE_TIMEOUT_MS - 1, inflight: 0 };
    expect(shouldEvictMcpConnection(staleEntry, now, IDLE_TIMEOUT_MS)).toBe(true);
  });
});

describe('withMcpTroubleshootHint', () => {
  it('appends a first-run hint to MCP timeout errors (-32001)', () => {
    // Regression: 2026-07-31 user report — first-ever `npx -y <pkg>` run needs
    // to download the package; the SDK's 60s handshake timeout fired and the
    // UI showed a bare "Request timed out" with no actionable guidance.
    const hinted = withMcpTroubleshootHint('MCP server startup failed: MCP error -32001: Request timed out');
    expect(hinted).toContain('-32001');
    expect(hinted).toContain('预热缓存');
    expect(hinted).toContain('registry.npmmirror.com');
  });

  it('appends the hint to Chinese timeout messages too', () => {
    const hinted = withMcpTroubleshootHint('连接超时');
    expect(hinted).toContain('预热缓存');
  });

  it('leaves non-timeout errors untouched', () => {
    const msg = 'MCP server startup failed: spawn npx ENOENT';
    expect(withMcpTroubleshootHint(msg)).toBe(msg);
  });
});

describe('Streamable HTTP config', () => {
  it('resolves bearer and env headers without putting values in the pool key', () => {
    const config: StreamableHttpMcpServerConfig = {
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Tenant': 'acme' },
      headersFromEnv: { 'X-Api-Key': 'MCP_API_KEY' },
      bearerTokenEnvVar: 'MCP_TOKEN',
    };
    const env = { MCP_API_KEY: 'api-secret', MCP_TOKEN: 'bearer-secret' };
    expect(resolveHttpHeaders(config, env)).toEqual({
      'X-Tenant': 'acme',
      'X-Api-Key': 'api-secret',
      Authorization: 'Bearer bearer-secret',
    });
    const key = mcpConfigKey(config, env);
    expect(key).not.toContain('api-secret');
    expect(key).not.toContain('bearer-secret');
    expect(() => resolveHttpHeaders(
      { ...config, bearerTokenEnvVar: 'MISSING' },
      { MCP_API_KEY: 'present' },
    )).toThrow(/MISSING/);
  });
});

describe('McpExecutor / Streamable HTTP', () => {
  it('initializes, lists tools, calls a tool, sends headers, and deletes the session', async () => {
    const seen = {
      methods: [] as string[],
      headers: [] as Array<Record<string, string | string[] | undefined>>,
      deleted: false,
    };
    const server = createServer(async (request, response) => {
      seen.headers.push(request.headers);
      if (request.method === 'DELETE') {
        seen.deleted = true;
        response.writeHead(200).end();
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.methods.push(message.method);
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: 'fixture', version: '1.0.0' },
            }
          : message.method === 'tools/list'
            ? {
                tools: [{
                  name: 'echo',
                  description: 'Echo text',
                  inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                  },
                }],
              }
            : {
                content: [{ type: 'text', text: String(message.params?.arguments) }],
              };
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const executor = new McpExecutor();
    executors.push(executor);
    const config: StreamableHttpMcpServerConfig = {
      transport: 'streamable-http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { 'X-Tenant': 'acme' },
      headersFromEnv: {},
    };
    try {
      const listed = await executor.listTools(config);
      expect(listed).toMatchObject({
        success: true,
        tools: [{ name: 'echo', description: 'Echo text' }],
      });
      const called = await executor.executeTool(config, 'echo', { text: 42 });
      expect(called.success).toBe(true);
      expect(seen.methods).toContain('initialize');
      expect(seen.methods).toContain('tools/list');
      expect(seen.methods).toContain('tools/call');
      expect(seen.headers.some((headers) => headers['x-tenant'] === 'acme')).toBe(true);
      expect(seen.headers.some((headers) => headers['mcp-session-id'] === 'session-1')).toBe(true);
      await executor.shutdownAll();
      expect(seen.deleted).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it('does not retry an authentication failure', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(401, { 'www-authenticate': 'Bearer realm="mcp"' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const executor = new McpExecutor();
    executors.push(executor);
    try {
      const result = await executor.listTools({
        transport: 'streamable-http',
        url: `http://127.0.0.1:${address.port}/mcp`,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('MCP HTTP connection failed');
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it('retries transient startup failures with a bounded attempt budget', async () => {
    let initializeAttempts = 0;
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      if (request.method === 'DELETE') {
        response.writeHead(200).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number;
        method: string;
      };
      if (message.method === 'initialize') {
        initializeAttempts += 1;
        if (initializeAttempts < 3) {
          response.writeHead(503).end('temporarily unavailable');
          return;
        }
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1.0.0' },
          }
        : { tools: [] };
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'retry-session',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const executor = new McpExecutor();
    executors.push(executor);
    try {
      const result = await executor.listTools({
        transport: 'streamable-http',
        url: `http://127.0.0.1:${address.port}/mcp`,
      });
      expect(result.success).toBe(true);
      expect(initializeAttempts).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it('refuses a cross-origin redirect before credentials reach the target', async () => {
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.writeHead(200).end();
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target did not bind');
    const source = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${targetAddress.port}/mcp`,
      }).end();
    });
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === 'string') throw new Error('source did not bind');
    const executor = new McpExecutor();
    executors.push(executor);
    try {
      const result = await executor.listTools({
        transport: 'streamable-http',
        url: `http://127.0.0.1:${sourceAddress.port}/mcp`,
        headers: { 'X-Tenant': 'private-tenant' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/redirect crossed origin/);
      expect(targetRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          source.close((error) => error ? reject(error) : resolve()),
        ),
        new Promise<void>((resolve, reject) =>
          target.close((error) => error ? reject(error) : resolve()),
        ),
      ]);
    }
  });

  it('refreshes the catalog after tools/list_changed and publishes one atomic generation', async () => {
    let generation = 1;
    let stream: import('node:http').ServerResponse | null = null;
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          connection: 'keep-alive',
        });
        stream = response;
        return;
      }
      if (request.method === 'DELETE') {
        response.writeHead(200).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number;
        method: string;
      };
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'fixture', version: '1.0.0' },
          }
        : {
            tools: [{
              name: `tool_${generation}`,
              description: `generation ${generation}`,
              inputSchema: { type: 'object', properties: {} },
            }],
          };
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'session-list-change',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const executor = new McpExecutor();
    executors.push(executor);
    let publishChanged: (tools: Array<{ name: string }>) => void = () => {};
    const changed = new Promise<Array<{ name: string }>>((resolve) => {
      publishChanged = resolve;
    });
    try {
      const initial = await executor.listTools(
        {
          transport: 'streamable-http',
          url: `http://127.0.0.1:${address.port}/mcp`,
        },
        (tools) => publishChanged(tools),
      );
      expect(initial.success).toBe(true);
      for (let attempt = 0; attempt < 50 && !stream; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stream).not.toBeNull();
      generation = 2;
      stream!.write(
        'event: message\n' +
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
      );
      await expect(changed).resolves.toMatchObject([
        { name: 'tool_2', description: 'generation 2' },
      ]);
    } finally {
      stream?.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });
});
