import fs from 'node:fs/promises';
import path from 'node:path';

import { getKeybindings, type Component } from '@earendil-works/pi-tui';
import { listBusyChatIds, type AgentClient } from '@steerable/agent-client';
import type { ApprovalDecisionKind } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';
import { saveAttachmentFiles } from '@steerable/agent-shell/attachments';

import { applyChildEvent, childLines, type ChildRow } from './children.js';
import { clearDraft, createDraft, editDraft, insertText, type DraftBuffer } from './editor.js';
import {
  attachmentMessage,
  completeFiles,
  isImagePath,
  mentionAt,
  type FilePick,
  type SavedFile,
} from './files.js';
import { ensureAgentKeybindings } from './keys.js';
import { renderScreen, type ChatRow, type TranscriptLine, type TuiScreen } from './screen.js';
import { historyRows, toolOutput, toolStatus, type ToolAction } from './transcript.js';

export interface AgentTuiOptions {
  product: string;
  dataDir?: string;
  busyChatIds?: string[];
  cwd?: string;
  saveAttachments?: (chatId: string, files: Array<{ name: string; path: string }>) => Promise<SavedFile[]>;
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
  private buffer: DraftBuffer = createDraft();
  private paste: string | null = null;
  private picks: FilePick[] | null = null;
  private pickIndex = 0;
  private pickGeneration = 0;
  private attachments: Array<{ name: string; path: string }> = [];
  private children: ChildRow[] = [];
  private readonly cwd: string;
  private status = '';
  private stopped = false;
  private turnAbort: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(client: AgentClient, options: AgentTuiOptions) {
    this.client = client;
    this.options = options;
    this.cwd = options.cwd ?? process.cwd();
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
    return renderScreen(this.snapshot(), width);
  }

  snapshot(): TuiScreen {
    return this.screen();
  }

  handleInput(data: string): void {
    this.applyInput(data);
    this.touch();
  }

  private applyInput(data: string): void {
    if (this.paste !== null || data.includes('\x1b[200~')) {
      if (!this.composing()) this.paste = null;
      else this.consumePaste(data);
      return;
    }
    const chars = [...data];
    if (chars.length > 1 && !data.includes('\x1b')) {
      for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index] ?? '';
        if (char === '\r' && chars[index + 1] === '\n') {
          this.applyInput('\r');
          index += 1;
          continue;
        }
        this.applyInput(char);
      }
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
    if (keys.matches(data, 'agent.tool.toggle')) {
      this.toggleTool();
      return;
    }
    if (this.ask && keys.matches(data, 'tui.input.submit')) {
      const requestId = this.ask.requestId;
      const answer = this.buffer.text;
      clearDraft(this.buffer);
      this.ask = null;
      void this.client.answerAsk(requestId, { text: answer });
      return;
    }
    if (this.picks && keys.matches(data, 'tui.select.cancel')) {
      this.picks = null;
      return;
    }
    if (this.picks && (keys.matches(data, 'tui.input.tab') || keys.matches(data, 'tui.select.confirm'))) {
      this.acceptPick();
      return;
    }
    if (this.picks && keys.matches(data, 'tui.select.up')) {
      this.pickIndex = Math.max(0, this.pickIndex - 1);
      this.markPicks();
      return;
    }
    if (this.picks && keys.matches(data, 'tui.select.down')) {
      this.pickIndex = Math.min(this.picks.length - 1, this.pickIndex + 1);
      this.markPicks();
      return;
    }
    if (
      keys.matches(data, 'tui.editor.deleteCharBackward')
      && this.buffer.text.length === 0
      && this.buffer.cursor === 0
      && this.attachments.length > 0
    ) {
      this.attachments.pop();
      return;
    }
    if (editDraft(this.buffer, data) === 'submit') {
      void this.submit();
      return;
    }
    this.refreshPicks();
  }

  private composing(): boolean {
    return !this.approval && !this.help && !this.chats;
  }

  private consumePaste(data: string): void {
    let chunk = data;
    if (this.paste === null) {
      this.paste = '';
      chunk = chunk.replaceAll('\x1b[200~', '');
    }
    this.paste += chunk;
    const end = this.paste.indexOf('\x1b[201~');
    if (end < 0) return;
    const text = this.paste.slice(0, end).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rest = this.paste.slice(end + '\x1b[201~'.length);
    this.paste = null;
    if (text.length > 0) insertText(this.buffer, text);
    if (rest.length > 0) this.applyInput(rest);
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
      draft: this.buffer.text,
      cursor: this.buffer.cursor,
      status: this.status,
      picks: this.pickRows(),
      attachments: this.attachments.map((file) => file.name),
      children: this.children,
    };
  }

  private pickRows(): TuiScreen['picks'] {
    if (!this.picks || this.picks.length === 0) return null;
    return this.picks.map((pick, index) => ({ label: pick.label, selected: index === this.pickIndex }));
  }

  private markPicks(): void {
    if (!this.picks) return;
    if (this.pickIndex >= this.picks.length) this.pickIndex = Math.max(0, this.picks.length - 1);
  }

  private refreshPicks(): void {
    const token = mentionAt(this.buffer.text, this.buffer.cursor);
    if (!token || !this.composing()) {
      this.picks = null;
      return;
    }
    const generation = ++this.pickGeneration;
    const query = token.query;
    void completeFiles(this.cwd, query).then((files) => {
      if (generation !== this.pickGeneration) return;
      if (!mentionAt(this.buffer.text, this.buffer.cursor)) return;
      this.picks = files.length > 0 ? files : [{ label: '无匹配', insert: '', directory: false }];
      this.markPicks();
      this.touch();
    });
  }

  private acceptPick(): void {
    const pick = this.picks?.[this.pickIndex];
    const token = mentionAt(this.buffer.text, this.buffer.cursor);
    if (!pick?.insert || !token) {
      this.picks = null;
      return;
    }
    const next = `${this.buffer.text.slice(0, token.start)}${pick.insert}${this.buffer.text.slice(this.buffer.cursor)}`;
    this.buffer.text = next;
    this.buffer.cursor = token.start + pick.insert.length;
    if (pick.directory) this.refreshPicks();
    else this.picks = null;
  }

  private showChats(): void {
    const index = this.rows.findIndex((chat) => chat.id === this.chatId);
    this.selected = index >= 0 ? index : 0;
    this.chats = this.rows.map((chat, row) => ({ ...chat, selected: row === this.selected }));
    void this.loadChats().then((rows) => {
      this.rows = rows;
      if (!this.chats) return;
      if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
      this.chats = rows.map((chat, row) => ({ ...chat, selected: row === this.selected }));
      this.touch();
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
      ? ((messages.data as { messages?: Parameters<typeof historyRows>[0] }).messages ?? [])
      : [];
    this.lines = historyRows(records).map((row) => (
      row.kind === 'tool' ? toolLine(row.action) : { kind: row.kind, text: row.text }
    ));
    this.help = false;
    this.children = [];
    this.picks = null;
    this.attachments = [];
    this.touch();
  }

  private async submit(): Promise<void> {
    const text = this.buffer.text.trim();
    clearDraft(this.buffer);
    this.picks = null;
    if (!text && this.attachments.length === 0) return;
    if (text.startsWith('/')) {
      await this.slash(text);
      return;
    }
    if (this.readOnly) {
      this.status = '只读 · 另一个进程正在运行';
      return;
    }
    const prepared = await this.prepareMessage(text);
    this.lines.push({ kind: 'user', text: prepared.message });
    this.pending = this.runTurn(prepared.message, prepared.images);
    await this.pending;
  }

  private async slash(text: string): Promise<void> {
    const [command, ...rest] = text.slice(1).split(/\s+/);
    if (command === 'help') {
      this.help = true;
      this.touch();
      return;
    }
    if (command === 'attach') {
      await this.attach(rest.join(' '));
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

  private async attach(target: string): Promise<void> {
    if (this.readOnly) {
      this.status = '只读 · 另一个进程正在运行';
      this.touch();
      return;
    }
    if (!target) {
      this.status = this.attachments.length > 0
        ? this.attachments.map((file) => file.name).join('  ')
        : '用法 /attach <路径>';
      this.touch();
      return;
    }
    const full = path.resolve(this.cwd, target);
    let fileStat;
    try {
      fileStat = await fs.stat(full);
    } catch {
      this.status = '找不到文件';
      this.touch();
      return;
    }
    if (!fileStat.isFile()) {
      this.status = '不是文件';
      this.touch();
      return;
    }
    const name = path.basename(full);
    this.attachments.push({ name, path: full });
    this.status = `已附加 ${name}`;
    this.touch();
  }

  private async prepareMessage(text: string): Promise<{ message: string; images: Array<{ path: string; name: string }> }> {
    if (this.attachments.length === 0) return { message: text, images: [] };
    await this.ensureChat();
    const chatId = this.chatId ?? '';
    const save = this.options.saveAttachments ?? defaultSaveAttachments;
    const saved = await save(chatId, this.attachments);
    const stored: SavedFile[] = [];
    const kept: Array<{ name: string; path: string }> = [];
    saved.forEach((file, index) => {
      if (file.path && !file.error) stored.push(file);
      else {
        const original = this.attachments[index];
        if (original) kept.push(original);
      }
    });
    this.attachments = kept;
    if (kept.length > 0) {
      this.status = saved.filter((file) => file.error).map((file) => file.error).join(' ');
    }
    return {
      message: attachmentMessage(text, stored),
      images: stored.filter((file) => isImagePath(file.path)).map((file) => ({ path: file.path, name: file.name })),
    };
  }

  private async ensureChat(): Promise<void> {
    if (this.chatId) return;
    const created = await this.client.request('POST', '/api/v2/chats/new', {});
    this.chatId = (created.data as { chatId?: string }).chatId ?? 'draft';
    this.title = this.chatId;
  }

  private async runTurn(text: string, images: Array<{ path: string; name: string }> = []): Promise<void> {
    await this.ensureChat();
    if (!this.chatId) return;
    const controller = new AbortController();
    this.turnAbort = controller;
    this.children = [];
    this.status = '';
    try {
      for await (const event of this.client.stream(
        `/api/v2/chats/${encodeURIComponent(this.chatId)}/send`,
        { message: text, ...(images.length > 0 ? { images } : {}) },
        controller.signal,
      )) {
        this.observe(event, controller.signal);
        this.touch();
      }
    } finally {
      for (const line of this.lines) line.streaming = false;
      if (this.children.length > 0) {
        for (const line of childLines(this.children)) this.lines.push({ kind: 'tree', text: line });
        this.children = [];
        this.touch();
      }
      if (this.turnAbort === controller) this.turnAbort = null;
    }
  }

  private observe(event: SSEEvent, signal: AbortSignal): void {
    if (String(event.type) === 'executed_actions' && Array.isArray(event.actions)) {
      this.applyActions(event.actions as ToolAction[]);
      return;
    }
    if (String(event.type) === 'orchestration_child') {
      this.children = applyChildEvent(this.children, {
        kind: event.kind,
        childId: event.childId,
        task: event.task,
        profile: event.profile,
        depth: event.depth,
      });
      return;
    }
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
      if (last?.kind === 'assistant') {
        last.text = `${last.text ?? ''}${event.content}`;
        last.streaming = true;
      } else {
        this.lines.push({ kind: 'assistant', text: event.content, streaming: true });
      }
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

  private applyActions(actions: ToolAction[]): void {
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      const next = toolLine(action);
      const index = next.id
        ? this.lines.findIndex((line) => line.kind === 'tool' && line.id === next.id)
        : -1;
      if (index >= 0) {
        next.open = this.lines[index]?.open;
        this.lines[index] = next;
      } else {
        this.lines.push(next);
      }
    }
  }

  private toggleTool(): void {
    const open = this.lines.find((line) => line.kind === 'tool' && line.open);
    if (open) {
      open.open = false;
      return;
    }
    for (let index = this.lines.length - 1; index >= 0; index -= 1) {
      const line = this.lines[index];
      if (line?.kind === 'tool' && line.status !== '…') {
        line.open = true;
        return;
      }
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
    if (this.stopped) return;
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

async function defaultSaveAttachments(
  chatId: string,
  files: Array<{ name: string; path: string }>,
): Promise<SavedFile[]> {
  const saved = await saveAttachmentFiles(chatId, files);
  return saved.files.map((file) => ({
    name: file.name,
    path: file.path,
    ...(file.error ? { error: file.error } : {}),
  }));
}

function toolLine(action: ToolAction): TranscriptLine {
  const name = typeof action.tool === 'string' && action.tool ? action.tool : 'tool';
  const title = typeof action.view?.title === 'string' ? action.view.title : '';
  return {
    kind: 'tool',
    id: typeof action.id === 'string' ? action.id : undefined,
    name,
    args: title && title !== name ? title : toolArgs(action.arguments),
    status: toolStatus(action),
    output: toolOutput(action),
  };
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
