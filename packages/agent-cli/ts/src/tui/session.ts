import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getKeybindings, type Component } from '@earendil-works/pi-tui';
import { listBusyChatIds, type AgentClient } from '@steerable/agent-client';
import type { ApprovalDecisionKind } from '@steerable/agent-client';
import type { SSEEvent } from '@steerable/agent-protocol';
import { saveAttachmentFiles } from '@steerable/agent-shell/attachments';

import { applyChildEvent, childLines, type ChildRow } from './children.js';
import { readSystemClipboard, saveClipboardImage, writeSystemClipboard, type ClipboardRead } from './clipboard.js';
import { completeSlash, slashAt } from './commands.js';
import { clearDraft, createDraft, editDraft, insertText, type DraftBuffer } from './editor.js';
import {
  attachmentMessage,
  completeFiles,
  isImagePath,
  mentionAt,
  type FilePick,
  type SavedFile,
} from './files.js';
import { markdownChat } from './export-chat.js';
import { ensureAgentKeybindings } from './keys.js';
import {
  createPromptHistory,
  leavePromptHistory,
  onFirstLine,
  onLastLine,
  recallPrompt,
  rememberPrompt,
  type PromptHistory,
} from './prompt-history.js';
import { renderScreen, type ChatRow, type TranscriptLine, type TuiScreen } from './screen.js';
import { searchHits, searchLabel } from './search.js';
import { transcriptEdge } from './scroll.js';
import { todosFromAction, type SessionTodo } from './todos.js';
import { historyRows, toolOutput, toolStatus, type ToolAction } from './transcript.js';
import { formatUsage } from './usage.js';

export interface AgentTuiOptions {
  product: string;
  dataDir?: string;
  busyChatIds?: string[];
  cwd?: string;
  saveAttachments?: (chatId: string, files: Array<{ name: string; path: string }>) => Promise<SavedFile[]>;
  readClipboard?: () => Promise<ClipboardRead>;
  writeClipboard?: (text: string) => Promise<void>;
  editInEditor?: (text: string) => Promise<string>;
  exportDir?: string;
  liveIntervalMs?: number;
  onExit: () => void;
  onChange?: () => void;
}

interface SessionGoal {
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  turns: number;
  blockedReason?: string;
}

interface SessionLoop {
  id: string;
  prompt: string;
  intervalSeconds: number;
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
  private approvalSubmitting = false;
  private ask: { requestId: string; prompt: string } | null = null;
  private readOnly = false;
  private help = false;
  private buffer: DraftBuffer = createDraft();
  private prompts: PromptHistory = createPromptHistory();
  private paste: string | null = null;
  private picks: FilePick[] | null = null;
  private pickIndex = 0;
  private pickGeneration = 0;
  private attachments: Array<{ name: string; path: string }> = [];
  private queue: Array<{ text: string; files: Array<{ name: string; path: string }> }> = [];
  private sending = false;
  private search: { query: string; index: number } | null = null;
  private scroll: 'top' | 'bottom' | null = null;
  private panel: string[] | null = null;
  private mode: 'agent' | 'plan' = 'agent';
  private permission: 'ask' | 'auto' | 'read' = 'ask';
  private todos: SessionTodo[] = [];
  private goal: SessionGoal | null = null;
  private loops: SessionLoop[] = [];
  private backendTurnActive = false;
  private loopExitArmed = false;
  private liveGeneration = 0;
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
    this.scroll = null;
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
        this.queue = [];
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
      if (this.approvalSubmitting) return;
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
      this.toggleFold();
      return;
    }
    const edge = this.composing() ? transcriptEdge(data) : null;
    if (edge) {
      this.scroll = edge;
      return;
    }
    if (this.search && this.composing() && this.editSearch(data)) return;
    if (this.composing() && keys.matches(data, 'tui.altScreen.search')) {
      this.search = { query: '', index: 0 };
      this.panel = null;
      this.picks = null;
      return;
    }
    if (this.panel && keys.matches(data, 'tui.select.cancel')) {
      this.panel = null;
      return;
    }
    if (this.composing() && keys.matches(data, 'agent.queue.pull')) {
      this.pullQueue();
      return;
    }
    if (this.composing() && keys.matches(data, 'agent.copy.reply')) {
      void this.copyReply();
      return;
    }
    if (this.composing() && keys.matches(data, 'agent.editor')) {
      void this.editDraftExternal();
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
    if (this.picks && keys.matches(data, 'tui.input.tab')) {
      this.acceptPick();
      return;
    }
    if (this.picks && keys.matches(data, 'tui.select.confirm')) {
      const pick = this.picks[this.pickIndex];
      if (!pick || this.buffer.text.trim() !== pick.insert.trim()) {
        this.acceptPick();
        return;
      }
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
    if (this.composing() && keys.matches(data, 'agent.clipboard.paste')) {
      void this.pasteClipboard();
      return;
    }
    if (this.browseHistory(data)) return;
    const edited = editDraft(this.buffer, data);
    if (edited === 'submit') {
      void this.submit();
      return;
    }
    if (edited === 'edited') leavePromptHistory(this.prompts);
    this.refreshPicks();
  }

  private async pasteClipboard(): Promise<void> {
    const read = this.options.readClipboard ?? readSystemClipboard;
    let payload: ClipboardRead;
    try {
      payload = await read();
    } catch (error) {
      void error;
      this.status = '剪贴板不可用';
      this.touch();
      return;
    }
    const bytes = payload.image;
    if (bytes && bytes.length > 0) {
      const saved = await saveClipboardImage(bytes);
      if (!saved) {
        this.status = '剪贴板里的图片格式不支持';
        this.touch();
        return;
      }
      this.attachments.push(saved);
      this.status = `已附加 ${saved.name}`;
      this.touch();
      return;
    }
    if (payload.text) {
      insertText(this.buffer, payload.text);
      this.refreshPicks();
      this.touch();
    }
  }

  private browseHistory(data: string): boolean {
    if (!this.composing()) return false;
    const keys = getKeybindings();
    const previous = keys.matches(data, 'tui.editor.historyPrevious');
    const next = keys.matches(data, 'tui.editor.historyNext');
    const up = keys.matches(data, 'tui.editor.cursorUp') && onFirstLine(this.buffer.text, this.buffer.cursor);
    const down = keys.matches(data, 'tui.editor.cursorDown')
      && this.prompts.index >= 0
      && onLastLine(this.buffer.text, this.buffer.cursor);
    if (!previous && !next && !up && !down) return false;
    const direction: -1 | 1 = previous || up ? -1 : 1;
    const moved = recallPrompt(this.prompts, this.buffer, direction);
    if (!moved && !previous && !next) return false;
    this.picks = null;
    return true;
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
      queued: this.queue.map((item) => item.text || item.files.map((file) => file.name).join(' ')),
      search: this.searchBar().label,
      searchFocus: this.searchBar().focus,
      scroll: this.scroll,
      panel: this.panel,
      mode: this.mode,
      permission: this.permission,
      todos: this.todos,
      goal: this.goal,
      loops: this.loops,
    };
  }

  private searchBar(): { label: string | null; focus: number | null } {
    if (!this.search) return { label: null, focus: null };
    const hits = searchHits(this.lines, this.search.query);
    const index = hits.length === 0 ? 0 : this.search.index % hits.length;
    return {
      label: searchLabel(this.search.query, hits, index),
      focus: hits[index]?.line ?? null,
    };
  }

  private editSearch(data: string): boolean {
    if (!this.search) return false;
    const keys = getKeybindings();
    if (keys.matches(data, 'tui.altScreen.search') || keys.matches(data, 'tui.altScreen.searchClose')) {
      this.search = null;
      return true;
    }
    const hits = searchHits(this.lines, this.search.query);
    if (keys.matches(data, 'tui.altScreen.searchNext')) {
      if (hits.length > 0) this.search.index = (this.search.index + 1) % hits.length;
      return true;
    }
    if (keys.matches(data, 'tui.altScreen.searchPrevious')) {
      if (hits.length > 0) this.search.index = (this.search.index - 1 + hits.length) % hits.length;
      return true;
    }
    if (keys.matches(data, 'tui.editor.deleteCharBackward')) {
      this.search.query = [...this.search.query].slice(0, -1).join('');
      this.search.index = 0;
      return true;
    }
    if ([...data].length === 1 && data >= ' ' && !data.includes('\x1b')) {
      this.search.query += data;
      this.search.index = 0;
      return true;
    }
    return false;
  }

  private pullQueue(): void {
    const item = this.queue.pop();
    if (!item) return;
    if (this.buffer.text.length > 0) {
      this.queue.push(item);
      this.status = '输入框里还有字';
      return;
    }
    this.buffer.text = item.text;
    this.buffer.cursor = [...item.text].length;
    this.attachments.push(...item.files);
    this.status = '已取回';
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
    if (!this.composing()) {
      this.picks = null;
      return;
    }
    const slash = slashAt(this.buffer.text, this.buffer.cursor);
    if (slash) {
      this.pickGeneration += 1;
      const commands = completeSlash(slash.query);
      this.picks = commands.length > 0 ? commands : null;
      this.markPicks();
      return;
    }
    const token = mentionAt(this.buffer.text, this.buffer.cursor);
    if (!token) {
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
    const token = slashAt(this.buffer.text, this.buffer.cursor) ?? mentionAt(this.buffer.text, this.buffer.cursor);
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
    this.todos = [];
    this.lines = historyRows(records).map((row) => {
      if (row.kind !== 'tool') return { kind: row.kind, text: row.text };
      const next = todosFromAction(row.action.tool, row.action.arguments, row.action.result);
      if (next) this.todos = next;
      return toolLine(row.action);
    });
    this.help = false;
    this.search = null;
    this.panel = null;
    this.children = [];
    this.picks = null;
    this.attachments = [];
    await this.refreshGoal(id);
    await this.refreshLoops(id);
    this.touch();
    this.armLive(id);
  }

  private async submit(): Promise<void> {
    const text = this.buffer.text.trim();
    clearDraft(this.buffer);
    this.picks = null;
    if (text) rememberPrompt(this.prompts, text);
    if (!text && this.attachments.length === 0) return;
    if (text.startsWith('/') && !isSkillFacadeCommand(text)) {
      try {
        await this.slash(text);
      } catch (error) {
        this.status = `命令失败：${error instanceof Error ? error.message : String(error)}`;
        this.touch();
      }
      return;
    }
    if (this.readOnly) {
      this.status = '只读 · 另一个进程正在运行';
      return;
    }
    if (this.permission === 'read') {
      this.status = '权限 只读';
      this.touch();
      return;
    }
    const files = this.attachments.splice(0);
    this.queue.push({ text, files });
    if (this.sending || this.backendTurnActive) {
      this.touch();
      return;
    }
    await this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.sending || this.backendTurnActive) return;
    this.sending = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;
        await this.sendPrepared(next.text, next.files);
      }
    } finally {
      this.sending = false;
      this.touch();
    }
  }

  private async sendPrepared(text: string, files: Array<{ name: string; path: string }>): Promise<void> {
    this.status = '';
    const prepared = await this.prepareOwned(text, files);
    this.lines.push({ kind: 'user', text: prepared.message });
    this.touch();
    this.pending = this.runTurn(prepared.message, prepared.images);
    await this.pending;
  }

  private async prepareOwned(
    text: string,
    files: Array<{ name: string; path: string }>,
  ): Promise<{ message: string; images: Array<{ path: string; name: string }> }> {
    const added = this.attachments.splice(0);
    this.attachments = files;
    try {
      return await this.prepareMessage(text);
    } finally {
      const failed = this.attachments;
      this.attachments = [...added, ...failed];
    }
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
    if (command === 'status') {
      const summary = await this.client.request('GET', '/api/v2/usage/summary', undefined);
      this.status = summary.status === 200 ? formatUsage(summary.data as { totals?: { turns?: number; totalTokens?: number; costUsd?: number } }) : '用量不可用';
      this.touch();
      return;
    }
    if (command === 'skills') {
      await this.showList('GET', '/api/v2/chat-agents/skills', 'skills', (row) => `技能 ${textField(row, 'name')}${textField(row, 'description') ? `  ${textField(row, 'description')}` : ''}`, '没有技能', '技能不可用');
      return;
    }
    if (command === 'mcp') {
      await this.showList('GET', '/api/v2/mcp/servers', 'servers', (row) => `MCP ${textField(row, 'name') || textField(row, 'id')}  ${numberField(row, 'toolCount')} 个工具`, '没有 MCP', 'MCP 不可用');
      return;
    }
    if (command === 'export') {
      await this.exportChat();
      return;
    }
    if (command === 'compact') {
      await this.compactChat();
      return;
    }
    if (command === 'plan') {
      this.mode = this.mode === 'plan' ? 'agent' : 'plan';
      this.status = this.mode === 'plan' ? '计划模式' : '对话模式';
      this.touch();
      return;
    }
    if (command === 'goal') {
      await this.manageGoal(rest);
      return;
    }
    if (command === 'loop') {
      await this.manageLoop(rest);
      return;
    }
    if (command === 'tasks') {
      await this.showTasks();
      return;
    }
    if (command === 'fork') {
      await this.forkChat();
      return;
    }
    if (command === 'rewind') {
      await this.rewindChat();
      return;
    }
    if (command === 'permissions') {
      this.permission = this.permission === 'ask' ? 'auto' : this.permission === 'auto' ? 'read' : 'ask';
      this.status = this.permission === 'ask' ? '权限 询问' : this.permission === 'auto' ? '权限 本会话自动' : '权限 只读';
      this.touch();
      return;
    }
    if (command === 'copy') {
      await this.copyReply();
      return;
    }
    if (command === 'editor') {
      await this.editDraftExternal();
      return;
    }
    this.status = `unknown command /${command}`;
    this.touch();
  }

  private async manageGoal(parts: string[]): Promise<void> {
    if (!this.chatId) {
      this.status = '还没有会话';
      return;
    }
    if (parts.length === 0) {
      await this.refreshGoal(this.chatId);
      this.status = this.goal ? '' : '没有持续目标';
      return;
    }
    const action = parts[0];
    if (!['edit', 'pause', 'resume', 'complete', 'clear'].includes(action)) {
      this.status = '用法 /goal [edit <目标>|pause|resume|complete|clear]';
      return;
    }
    const objective = parts.slice(1).join(' ').trim();
    if (action === 'edit' && !objective) {
      this.status = '用法 /goal edit <目标>';
      return;
    }
    const response = await this.client.request(
      'POST',
      `/api/v2/chats/${encodeURIComponent(this.chatId)}/goal`,
      { action, ...(objective ? { objective } : {}) },
    );
    if (response.status !== 200) {
      this.status = `目标操作失败 (${response.status})`;
      return;
    }
    this.goal = (response.data as { goal?: SessionGoal | null }).goal ?? null;
    this.status = '';
  }

  private async manageLoop(parts: string[]): Promise<void> {
    if (!this.chatId) {
      this.status = '还没有会话';
      return;
    }
    if (parts[0] === 'list') {
      await this.refreshLoops(this.chatId);
      this.panel = this.loops.length > 0
        ? this.loops.map((loop) => `Loop ${loop.id}  每 ${loop.intervalSeconds} 秒  ${loop.prompt}`)
        : ['没有运行中的 Loop'];
      return;
    }
    if (parts[0] === 'stop' && parts[1]) {
      const response = await this.client.request(
        'DELETE',
        `/api/v2/chats/${encodeURIComponent(this.chatId)}/loops/${encodeURIComponent(parts[1])}`,
        undefined,
      );
      this.status = response.status === 200 ? 'Loop 已停止' : `停止 Loop 失败 (${response.status})`;
      await this.refreshLoops(this.chatId);
      return;
    }
    this.status = '用法 /loop list | /loop stop <id>';
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
    try {
      const payload: { message: string; images?: Array<{ path: string; name: string }>; mode?: 'plan' } = { message: text };
      if (images.length > 0) payload.images = images;
      if (this.mode === 'plan') payload.mode = 'plan';
      for await (const event of this.client.stream(
        `/api/v2/chats/${encodeURIComponent(this.chatId)}/send`,
        payload,
        controller.signal,
      )) {
        this.observe(event, controller.signal);
        this.touch();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.status = error instanceof Error ? error.message : String(error);
        this.touch();
      }
    } finally {
      for (const line of this.lines) line.streaming = false;
      if (this.children.length > 0) {
        for (const line of childLines(this.children)) this.lines.push({ kind: 'tree', text: line });
        this.children = [];
        this.touch();
      }
      if (controller.signal.aborted) this.queue = [];
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
    if (String(event.type) === 'reasoning' && typeof event.content === 'string') {
      const last = this.lines[this.lines.length - 1];
      if (last?.kind === 'reasoning') {
        last.text = `${last.text ?? ''}${event.content}`;
        last.streaming = true;
      } else {
        this.lines.push({ kind: 'reasoning', text: event.content, streaming: true });
      }
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
        if (this.permission === 'auto') {
          void this.client.decideApproval(payload.requestId, 'allow_for_session');
          this.touch();
          continue;
        }
        this.approval = {
          requestId: payload.requestId,
          toolName: payload.toolName || 'tool',
          summary: toolArgs(payload.arguments),
        };
      } else if (event.channel === 'ask-user:request') {
        const payload = event.payload as { requestId?: string; prompt?: string };
        if (payload.requestId) this.ask = { requestId: payload.requestId, prompt: payload.prompt ?? '' };
      } else if (event.channel === 'goal-changed') {
        const payload = event.payload as { chatId?: string; goal?: SessionGoal | null };
        if (payload.chatId === this.chatId) this.goal = payload.goal ?? null;
      } else if (event.channel === 'loop-changed') {
        const payload = event.payload as { chatId?: string; loops?: SessionLoop[] };
        if (payload.chatId === this.chatId) this.loops = payload.loops ?? [];
      } else if (event.channel === 'chat-turn-started') {
        const payload = event.payload as { chatId?: string };
        if (payload.chatId === this.chatId) {
          this.backendTurnActive = true;
          this.armLive(payload.chatId, true);
        }
      } else if (event.channel === 'chat-turn-finished') {
        const payload = event.payload as { chatId?: string };
        if (payload.chatId === this.chatId) {
          this.backendTurnActive = false;
          await this.reloadMessages(payload.chatId);
          await this.refreshGoal(payload.chatId);
          void this.drainQueue();
        }
      }
      this.touch();
    }
  }

  private applyActions(actions: ToolAction[]): void {
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      const nextTodos = todosFromAction(action.tool, action.arguments, action.result);
      if (nextTodos) this.todos = nextTodos;
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

  private toggleFold(): void {
    const open = this.lines.find((line) => (line.kind === 'tool' || line.kind === 'reasoning') && line.open);
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
      if (line?.kind === 'reasoning' && (line.text ?? '').length > 0) {
        line.open = true;
        return;
      }
    }
  }

  private armLive(chatId: string, waitForStart = false): void {
    const generation = ++this.liveGeneration;
    void this.pollLive(chatId, generation, waitForStart ? 10 : 0);
  }

  private async pollLive(chatId: string, generation: number, startRetries: number): Promise<void> {
    if (this.stopped || this.chatId !== chatId || generation !== this.liveGeneration) return;
    const live = await this.client.request('GET', `/api/v2/chats/${encodeURIComponent(chatId)}/live-stream`, undefined);
    if (this.stopped || this.chatId !== chatId || generation !== this.liveGeneration) return;
    if (live.status !== 200 || !live.data || typeof live.data !== 'object') return;
    const data = live.data as { active?: boolean; content?: string; executedActions?: ToolAction[] };
    if (data.active !== true) {
      if (startRetries > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.options.liveIntervalMs ?? 1000);
        });
        await this.pollLive(chatId, generation, startRetries - 1);
        return;
      }
      if (this.status === '运行中') this.status = '';
      this.touch();
      return;
    }
    this.status = '运行中';
    if (typeof data.content === 'string' && data.content.length > 0) {
      const streaming = [...this.lines].reverse().find((line) => line.kind === 'assistant' && line.streaming);
      if (streaming) streaming.text = data.content;
      else if (!this.lines.some((line) => line.kind === 'assistant' && line.text === data.content)) {
        this.lines.push({ kind: 'assistant', text: data.content, streaming: true });
      }
    }
    if (Array.isArray(data.executedActions)) this.applyActions(data.executedActions);
    this.touch();
    const wait = this.options.liveIntervalMs ?? 1000;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait);
    });
    await this.pollLive(chatId, generation, 0);
  }

  private async refreshGoal(chatId: string): Promise<void> {
    const response = await this.client.request(
      'GET',
      `/api/v2/chats/${encodeURIComponent(chatId)}/goal`,
      undefined,
    );
    this.goal = response.status === 200 && response.data && typeof response.data === 'object'
      ? ((response.data as { goal?: SessionGoal | null }).goal ?? null)
      : null;
  }

  private async refreshLoops(chatId: string): Promise<void> {
    const response = await this.client.request(
      'GET',
      `/api/v2/chats/${encodeURIComponent(chatId)}/loops`,
      undefined,
    );
    this.loops = response.status === 200 && response.data && typeof response.data === 'object'
      ? ((response.data as { loops?: SessionLoop[] }).loops ?? [])
      : [];
  }

  private async reloadMessages(chatId: string): Promise<void> {
    const response = await this.client.request(
      'GET',
      `/api/v2/chats/${encodeURIComponent(chatId)}/messages`,
      undefined,
    );
    if (response.status !== 200) return;
    const records = (response.data as {
      messages?: Parameters<typeof historyRows>[0];
    }).messages ?? [];
    this.todos = [];
    this.lines = historyRows(records).map((row) => {
      if (row.kind !== 'tool') return { kind: row.kind, text: row.text };
      const next = todosFromAction(row.action.tool, row.action.arguments, row.action.result);
      if (next) this.todos = next;
      return toolLine(row.action);
    });
    this.touch();
  }

  private async showList(
    method: 'GET',
    requestPath: string,
    key: string,
    format: (row: Record<string, unknown>) => string,
    empty: string,
    unavailable: string,
  ): Promise<void> {
    const listed = await this.client.request(method, requestPath, undefined);
    if (listed.status !== 200) {
      this.panel = [`${unavailable} (${listed.status})`];
      this.touch();
      return;
    }
    const rows = listed.status === 200 && listed.data && typeof listed.data === 'object'
      ? (listed.data as Record<string, unknown>)[key]
      : [];
    const lines = Array.isArray(rows)
      ? rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map(format)
      : [];
    this.panel = lines.length > 0 ? lines : [empty];
    this.touch();
  }

  private async showTasks(): Promise<void> {
    if (!this.chatId) {
      this.status = '还没有会话';
      this.touch();
      return;
    }
    const listed = await this.client.request('GET', `/api/v2/chats/${encodeURIComponent(this.chatId)}/tasks`, undefined);
    if (listed.status !== 200) {
      this.panel = [`后台任务不可用 (${listed.status})`];
      this.touch();
      return;
    }
    const rows = listed.status === 200 && listed.data && typeof listed.data === 'object'
      ? (listed.data as { tasks?: Array<{ task?: string; status?: string }> }).tasks ?? []
      : [];
    this.panel = rows.length > 0
      ? rows.map((task) => `后台 ${task.task ?? ''}  ${taskStatus(task.status)}`)
      : ['没有后台任务'];
    this.touch();
  }

  private async exportChat(): Promise<void> {
    const messages = this.lines
      .filter((line) => line.kind === 'user' || line.kind === 'assistant')
      .map((line) => ({ role: line.kind, content: line.text ?? '' }));
    const file = path.join(this.options.exportDir ?? os.tmpdir(), `${this.chatId ?? 'chat'}.md`);
    await fs.writeFile(file, markdownChat(this.title, messages));
    this.status = `已导出 ${file}`;
    this.touch();
  }

  private async compactChat(): Promise<void> {
    if (!this.chatId) return;
    const result = await this.client.request('POST', `/api/v2/chats/${encodeURIComponent(this.chatId)}/compact`, {});
    const compacted = result.status === 200 ? numberField(result.data, 'compacted') : 0;
    if (result.status !== 200) {
      this.status = '压缩失败';
      this.touch();
      return;
    }
    if (compacted === 0) {
      this.status = '没有可压缩的记录';
      this.touch();
      return;
    }
    await this.openChat(this.chatId);
    this.status = `已压缩 ${compacted} 条`;
    this.touch();
  }

  private async forkChat(): Promise<void> {
    if (!this.chatId) return;
    const created = await this.client.request('POST', `/api/v2/chats/${encodeURIComponent(this.chatId)}/fork`, {});
    const chatId = created.status === 200 ? textField(created.data, 'chatId') : '';
    if (!chatId) {
      this.status = '分叉失败';
      this.touch();
      return;
    }
    await this.openChat(chatId);
    this.status = '已分叉';
    this.touch();
  }

  private async rewindChat(): Promise<void> {
    if (!this.chatId) return;
    const result = await this.client.request('POST', `/api/v2/chats/${encodeURIComponent(this.chatId)}/rewind`, {});
    const removed = result.status === 200 ? numberField(result.data, 'removed') : 0;
    if (result.status !== 200 || removed === 0) {
      this.status = '没有可回退的回合';
      this.touch();
      return;
    }
    await this.openChat(this.chatId);
    this.status = '已回退';
    this.touch();
  }

  private async copyReply(): Promise<void> {
    const text = [...this.lines].reverse().find((line) => line.kind === 'assistant' && (line.text ?? '').length > 0)?.text ?? '';
    if (!text) {
      this.status = '没有可复制的回答';
      this.touch();
      return;
    }
    const write = this.options.writeClipboard ?? writeSystemClipboard;
    try {
      await write(text);
      this.status = '已复制';
    } catch (error) {
      void error;
      this.status = '剪贴板不可用';
    }
    this.touch();
  }

  private async editDraftExternal(): Promise<void> {
    const edit = this.options.editInEditor ?? editWithEditor;
    try {
      const next = await edit(this.buffer.text);
      this.buffer.text = next.replace(/\r\n/g, '\n');
      this.buffer.cursor = [...this.buffer.text].length;
      leavePromptHistory(this.prompts);
      this.refreshPicks();
    } catch (error) {
      void error;
      this.status = '编辑器不可用';
    }
    this.touch();
  }

  private async decide(kind: ApprovalDecisionKind): Promise<void> {
    const request = this.approval;
    if (!request || this.approvalSubmitting) return;
    this.approvalSubmitting = true;
    this.touch();
    try {
      const accepted = await this.client.decideApproval(request.requestId, kind);
      if (!accepted) throw new Error('approval unavailable');
      if (this.approval?.requestId === request.requestId) this.approval = null;
    } catch (error) {
      this.status = `审批失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.approvalSubmitting = false;
      this.touch();
    }
  }

  private touch(): void {
    if (this.stopped) return;
    this.options.onChange?.();
  }

  private exit(): void {
    if (this.loops.length > 0 && !this.loopExitArmed) {
      this.loopExitArmed = true;
      this.status = '活动 Loop 会随本进程停止；再按一次退出';
      this.touch();
      return;
    }
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
    ...(diffOf(action) ? { diff: diffOf(action) } : {}),
  };
}

function diffOf(action: ToolAction): string | undefined {
  const result = action.result;
  if (!result || typeof result !== 'object') return undefined;
  const diff = (result as { diff?: unknown }).diff;
  return typeof diff === 'string' && diff.length > 0 ? diff : undefined;
}

function textField(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : '';
}

function numberField(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : 0;
}

function taskStatus(status: string | undefined): string {
  if (status === 'running') return '进行中';
  if (status === 'completed') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'blocked') return '等待';
  return status ?? '';
}

function isSkillFacadeCommand(text: string): boolean {
  if (/^\/goal(?:\s|$)/.test(text)) {
    return !/^\/goal(?:\s+(?:edit|pause|resume|complete|clear)(?:\s|$)|\s*$)/.test(text);
  }
  if (/^\/loop(?:\s|$)/.test(text)) {
    return !/^\/loop\s+(?:list|stop)(?:\s|$)/.test(text);
  }
  return false;
}

async function editWithEditor(text: string): Promise<string> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new Error('editor unavailable');
  const file = path.join(os.tmpdir(), `steerable-draft-${randomUUID().slice(0, 8)}.md`);
  await fs.writeFile(file, text);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (status) => resolve(status ?? 1));
  });
  const next = await fs.readFile(file, 'utf8');
  await fs.unlink(file).catch((error: unknown) => {
    void error;
  });
  if (code !== 0) throw new Error(`editor exited ${code}`);
  return next;
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
