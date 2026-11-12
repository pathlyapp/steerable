import type { SSEEvent } from '@steerable/agent-protocol';

/** Turns router SSE chunks into protocol events as each frame arrives. */
export function createSseParser(onEvent: (event: SSEEvent) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    while (true) {
      const split = buffer.indexOf('\n\n');
      if (split < 0) break;
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = parseSseBlock(block);
      if (event) onEvent(event);
    }
  };
}

function parseSseBlock(block: string): SSEEvent | null {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  if (raw === '[DONE]') return { type: 'done' };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const type = eventType(parsed, eventName);
    return { ...parsed, type, ...(eventName ? { event: eventName } : {}) };
  } catch {
    return { type: 'error', message: raw, ...(eventName ? { event: eventName } : {}) };
  }
}

function eventType(parsed: Record<string, unknown>, eventName: string): SSEEvent['type'] {
  if (typeof parsed.type === 'string') return parsed.type as SSEEvent['type'];
  if (eventName === 'error') return 'error';
  if (typeof parsed.content === 'string') return 'content';
  return 'agent';
}
