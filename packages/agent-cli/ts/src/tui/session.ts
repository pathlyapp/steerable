import { getKeybindings, type Component } from '@earendil-works/pi-tui';
import { listBusyChatIds, type AgentClient } from '@steerable/agent-client';
import type { ApprovalDecisionKind } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';

import { ensureAgentKeybindings } from './keys.js';
import { renderScreen, type ChatRow, type TranscriptLine, type TuiScreen } from './screen.js';

export interface AgentTuiOptions {
  product: string;
  dataDir?: string;
  busyChatIds?: string[];
  onExit: () => void;
  onChange?: () => void;
}

export class AgentTui implements Component {
  private readonly client: AgentClient;
  private readonly options: AgentTuiOptions;
  private title = '新会话';
  private modelName = '';
  private chatId: string | null = null;
  private lines: TranscriptLine[] = [];
  private rows: ChatRow[] = [];
  private chats: ChatRow[] | null = null;
  private selected = 0;
  private approval: { requestId: string; toolName: string; summary: string } | null = null;
  private ask: { requestId: string; prompt: string } | null = null;
  private readOnly = false;
  private help = false;
  private draft = '';
  private status = '';
  private stopped = false;
  private turnAbort: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(client: AgentClient, options: AgentTuiOptions) {
    this.client = client;
    this.options = options;
    ensureAgentKeybindings();
  }

  async open(): Promise<void> {
    const settings = await this.client.request('GET', '/api/v2/local-settings/llm', undefined);
    if (settings.status === 200) {
      const model = (settings.data as { model?: string }).model;
      if (model) this.modelName = model;
    }
    this.rows = await this.loadChats();
    const current = this.rows[0];
    if (current) await this.openChat(current.id);
    void this.watch();
    this.touch();
  }

  async settled(): Promise<void> {
    await this.pending;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return renderScreen(this.screen(), width);
  }

  handleInput(data: string): void {
    if (data.length > 1 && !data.includes('\x1b')) {
      for (const char of data) this.handleInput(char);
      return;
    }
    const keys = getKeybindings();
    if (keys.matches(data, 'agent.interrupt')) {
      if (this.turnAbort && !this.turnAbort.signal.aborted) {
        this.turnAbort.abort();
        this.status = '已中断';
        return;
      }
      if (this.approval) {
        void this.decide('abort');
        return;
      }
      this.exit();
      return;
    }
    if (this.approval) {
      const kind = approvalKind(data);
      if (kind) void this.decide(kind);
      return;
    }
    if (this.help) {
      if (keys.matches(data, 'tui.select.cancel')) this.help = false;
      return;
    }
    if (this.chats) {
      if (keys.matches(data, 'tui.select.up')) this.selected = Math.max(0, this.selected - 1);
      if (keys.matches(data, 'tui.select.down')) this.selected = Math.min(this.chats.length - 1, this.selected + 1);
      if (keys.matches(data, 'tui.select.cancel')) {
        this.chats = null;
        return;
      }
      if (keys.matches(data, 'tui.select.confirm')) {
        const chat = this.chats[this.selected];
        this.chats = null;
        if (chat) {
          this.readOnly = chat.busy;
          this.title = chat.title;
          this.chatId = chat.id;
          void this.openChat(chat.id);
        }
        return;
      }
      this.markSelection();
      return;
    }
    if (keys.matches(data, 'agent.chats')) {
      this.showChats();
      return;
    }
    if (this.ask && keys.matches(data, 'tui.input.submit')) {
      const requestId = this.ask.requestId;
      const answer = this.draft;
      this.draft = '';
      this.ask = null;
      void this.client.answerAsk(requestId, { text: answer });
      return;
    }
    if (keys.matches(data, 'tui.input.newLine')) {
      this.draft += '\n';
      return;
    }
    if (keys.matches(data, 'tui.input.submit')) {
      void this.submit();
      return;
    }
    if (keys.matches(data, 'tui.editor.deleteCharBackward')) {
      this.draft = [...this.draft].slice(0, -1).join('');
      return;
    }
    if (data.length > 0 && [...data].every((char) => char >= ' ' && char !== '\x7f')) this.draft += data;
  }

  private screen(): TuiScreen {
    return {
      product: this.options.product,
      title: this.title,
      modelName: this.modelName,
      lines: this.lines,
      approval: this.approval,
      ask: this.ask ? { prompt: this.ask.prompt } : null,
      chats: this.chats,
      readOnly: this.readOnly,
      help: this.help,
      draft: this.draft,
      status: this.status,
    };
  }

  private showChats(): void {
    const index = this.rows.findIndex((chat) => chat.id === this.chatId);
    this.selected = index >= 0 ? index : 0;
    this.chats = this.rows.map((chat, row) => ({ ...chat, selected: row === this.selected }));
    void this.loadChats().then((rows) => {
      this.rows = rows;
      if (this.chats) this.markSelection();
    });
  }

  private async loadChats(): Promise<ChatRow[]> {
    const listed = await this.client.request('GET', '/api/v2/chats', undefined);
    const rows = listed.status === 200
      ? ((listed.data as { chats?: Array<{ id: string; title?: string }> }).chats ?? [])
      : [];
    const busy = new Set(this.options.busyChatIds ?? (this.options.dataDir ? listBusyChatIds(this.options.dataDir) : []));
    return rows.map((chat) => ({
      id: chat.id,
      title: chat.title || chat.id,
      busy: busy.has(chat.id),
      selected: false,
    }));
  }

  private markSelection(): void {
    this.chats = (this.chats ?? []).map((chat, index) => ({ ...chat, selected: index === this.selected }));
  }

  private async openChat(id: string): Promise<void> {
    const encoded = encodeURIComponent(id);
    const chat = await this.client.request('GET', `/api/v2/chats/${encoded}`, undefined);
    const messages = await this.client.request('GET', `/api/v2/chats/${encoded}/messages`, undefined);
    this.chatId = id;
    const title = chat.status === 200 ? (chat.data as { title?: string }).title : '';
    this.title = title || id;
    this.readOnly = (this.options.busyChatIds ?? []).includes(id)
      || (this.options.dataDir ? listBusyChatIds(this.options.dataDir).includes(id) : false);
    const records = messages.status === 200
      ? ((messages.data as { messages?: Array<{ role?: string; content?: string }> }).messages ?? [])
      : [];
    this.lines = records.map((message) => ({
      kind: message.role === 'user' ? 'user' : 'assistant',
      text: message.content ?? '',
    }));
    this.help = false;
    this.touch();
  }

  private async submit(): Promise<void> {
    const text = this.draft.trim();
    this.draft = '';
    if (!text) return;
    if (text.startsWith('/')) {
      await this.slash(text);
      return;
    }
    if (this.readOnly) {
      this.status = '只读 · 另一个进程正在运行';
      return;
    }
    this.lines.push({ kind: 'user', text });
    this.pending = this.runTurn(text);
    await this.pending;
  }

  private async slash(text: string): Promise<void> {
    const [command, ...rest] = text.slice(1).split(/\s+/);
    if (command === 'help') {
      this.help = true;
      this.touch();
      return;
    }
    if (command === 'clear') {
      this.lines = [];
      this.status = '';
      this.touch();
      return;
    }
    if (command === 'new') {
      const created = await this.client.request('POST', '/api/v2/chats/new', {});
      const chatId = (created.data as { chatId?: string }).chatId;
      if (!chatId) {
        this.status = 'failed to create chat';
        return;
      }
      this.lines = [];
      this.readOnly = false;
      await this.openChat(chatId);
      return;
    }
    if (command === 'model') {
      const next = rest.join(' ');
      if (!next) {
        this.status = this.modelName;
        return;
      }
      const current = await this.client.request('GET', '/api/v2/local-settings/llm', undefined);
      const body = { ...(current.data as Record<string, unknown>), model: next };
      const saved = await this.client.request('POST', '/api/v2/local-settings/llm', body);
      if (saved.status === 200) this.modelName = next;
      else this.status = `config set failed (${saved.status})`;
      this.touch();
      return;
    }
    this.status = `unknown command /${command}`;
    this.touch();
  }

  private async runTurn(text: string): Promise<void> {
    if (!this.chatId) {
      const created = await this.client.request('POST', '/api/v2/chats/new', {});
      this.chatId = (created.data as { chatId?: string }).chatId ?? 'draft';
      this.title = this.chatId;
      this.touch();
    }
    const controller = new AbortController();
    this.turnAbort = controller;
    this.status = '';
    try {
      for await (const event of this.client.stream(
        `/api/v2/chats/${encodeURIComponent(this.chatId)}/send`,
        { message: text },
        controller.signal,
      )) {
        this.observe(event, controller.signal);
        this.touch();
      }
    } finally {
      if (this.turnAbort === controller) this.turnAbort = null;
    }
  }

  private observe(event: SSEEvent, signal: AbortSignal): void {
    if (event.type === 'tool_call') {
      const payload = event.payload ?? {};
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      const args = toolArgs(payload.arguments ?? payload.input);
      this.lines.push({ kind: 'tool', name, args, status: '…' });
      return;
    }
    if (event.type === 'tool_result') {
      const tool = [...this.lines].reverse().find((line) => line.kind === 'tool' && line.status === '…');
      if (tool) tool.status = '✓';
      return;
    }
    if (event.type === 'content' && typeof event.content === 'string') {
      const last = this.lines[this.lines.length - 1];
      if (last?.kind === 'assistant') last.text = `${last.text ?? ''}${event.content}`;
      else this.lines.push({ kind: 'assistant', text: event.content });
      return;
    }
    if (event.type === 'error' && !signal.aborted) {
      this.status = typeof event.message === 'string' ? event.message : 'error';
    }
  }

  private async watch(): Promise<void> {
    for await (const event of this.client.events()) {
      if (this.stopped) return;
      if (event.channel === 'approval:request') {
        const payload = event.payload as { requestId?: string; toolName?: string; arguments?: unknown };
        if (!payload.requestId) continue;
        this.approval = {
          requestId: payload.requestId,
          toolName: payload.toolName || 'tool',
          summary: toolArgs(payload.arguments),
        };
      } else if (event.channel === 'ask-user:request') {
        const payload = event.payload as { requestId?: string; prompt?: string };
        if (payload.requestId) this.ask = { requestId: payload.requestId, prompt: payload.prompt ?? '' };
      }
      this.touch();
    }
  }

  private async decide(kind: ApprovalDecisionKind): Promise<void> {
    const request = this.approval;
    if (!request) return;
    this.approval = null;
    this.touch();
    await this.client.decideApproval(request.requestId, kind);
  }

  private touch(): void {
    this.options.onChange?.();
  }

  private exit(): void {
    this.stopped = true;
    this.turnAbort?.abort();
    this.options.onExit();
  }
}

function approvalKind(data: string): ApprovalDecisionKind | null {
  const keys = getKeybindings();
  if (keys.matches(data, 'agent.approval.allowOnce')) return 'allow_once';
  if (keys.matches(data, 'agent.approval.allowSession')) return 'allow_for_session';
  if (keys.matches(data, 'agent.approval.allowAlways')) return 'allow_always';
  if (keys.matches(data, 'agent.approval.denyOnce')) return 'deny_once';
  if (keys.matches(data, 'agent.approval.denySession')) return 'deny_for_session';
  if (keys.matches(data, 'agent.approval.denyAlways')) return 'deny_always';
  if (keys.matches(data, 'agent.approval.abort')) return 'abort';
  return null;
}

function toolArgs(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'command' in value) {
    const command = (value as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  if (value === undefined) return '';
  return JSON.stringify(value);
}
