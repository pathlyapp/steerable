export interface SessionTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** The latest `todo_write` list. Each call replaces the whole list. */
export function todosFromAction(tool: string | undefined, args: unknown, result: unknown): SessionTodo[] | null {
  if (tool !== 'todo_write') return null;
  return readTodos(result) ?? readTodos(args);
}

function readTodos(value: unknown): SessionTodo[] | null {
  const direct = todoItems(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  const nested = asRecord(record.data);
  const envelope = asRecord(nested?.value);
  return todoItems(record.todos) ?? todoItems(nested?.todos) ?? todoItems(envelope?.todos);
}

function todoItems(value: unknown): SessionTodo[] | null {
  if (!Array.isArray(value)) return null;
  const todos: SessionTodo[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row || typeof row.content !== 'string' || row.content.length === 0) continue;
    const status = row.status === 'in_progress' || row.status === 'completed' ? row.status : 'pending';
    todos.push({ content: row.content, status });
  }
  return todos.length > 0 ? todos : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return asRecord(JSON.parse(trimmed) as unknown);
    } catch (error) {
      void error;
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
