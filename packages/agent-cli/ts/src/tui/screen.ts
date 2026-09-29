import { Box, CURSOR_MARKER, Text, type Component } from '@earendil-works/pi-tui';

import { childLines, type ChildRow } from './children.js';
import { splitAtCursor } from './editor.js';
import { keyLabel } from './keys.js';

export interface TranscriptLine {
  kind: 'user' | 'assistant' | 'tool' | 'tree';
  text?: string;
  name?: string;
  args?: string;
  status?: string;
}

export interface ChatRow {
  id: string;
  title: string;
  busy: boolean;
  selected: boolean;
}

export interface PickRow {
  label: string;
  selected: boolean;
}

export interface TuiScreen {
  product: string;
  title: string;
  modelName: string;
  lines: TranscriptLine[];
  approval: { toolName: string; summary: string } | null;
  ask: { prompt: string } | null;
  chats: ChatRow[] | null;
  readOnly: boolean;
  help: boolean;
  draft: string;
  cursor: number;
  status: string;
  picks?: PickRow[] | null;
  attachments?: string[];
  children?: ChildRow[];
}

export const draftHint = '输入消息，Enter 发送，Shift+Enter 换行';

const caret = '▍';

export function renderScreen(screen: TuiScreen, width: number): string[] {
  const box = new Box(0, 0);
  for (const line of screenLines(screen)) box.addChild(new PlainLine(line));
  return box.render(width);
}

export function toolText(line: TranscriptLine): string {
  return `▸ ${line.name}  ${line.args}  ${line.status ?? ''}`.trimEnd();
}

export function chatText(chat: ChatRow): string {
  const mark = chat.selected ? '*' : ' ';
  const busy = chat.busy ? '  只读' : '';
  return `${mark} ${chat.id}  ${chat.title}${busy}`;
}

export function helpLines(): string[] {
  return ['/new 新会话', '/model 查看或切换模型', '/attach 附加文件', '@ 补全文件', '/clear 清屏', '/help 帮助'];
}

export function pickText(pick: PickRow): string {
  return `${pick.selected ? '*' : ' '} ${pick.label}`;
}

export function attachmentText(names: readonly string[]): string {
  return names.length > 0 ? `附件 ${names.join('  ')}` : '';
}

export function approvalLines(approval: { toolName: string; summary: string }): string[] {
  return [
    `审批 ${approval.toolName} ${approval.summary}`.trimEnd(),
    `${keyLabel('agent.approval.allowOnce')} 本次允许  ${keyLabel('agent.approval.allowSession')} 本会话  ${keyLabel('agent.approval.allowAlways')} 总是`,
    `${keyLabel('agent.approval.denyOnce')} 拒绝  ${keyLabel('agent.approval.denySession')} 本会话拒绝  ${keyLabel('agent.approval.denyAlways')} 总是拒绝  ${keyLabel('agent.approval.abort')} 中止`,
  ];
}

export function footerText(): string {
  return `${keyLabel('agent.interrupt')} 中断 · ${keyLabel('agent.chats')} 会话 · ${keyLabel('tui.input.submit')} 发送 · /help`;
}

export function draftLine(draft: string, cursor: number): string {
  const { before, head, after } = splitAtCursor(draft, cursor);
  if (draft.length === 0) return `> ${CURSOR_MARKER}${caret} ${draftHint}`;
  return `> ${before}${CURSOR_MARKER}${caret}${head}${after}`;
}

export function composerRows(draft: string, columns: number): number {
  const width = Math.max(1, columns);
  const shown = draft.length > 0 ? draft : `▍ ${draftHint}`;
  let rows = 0;
  for (const line of shown.split('\n')) {
    rows += Math.max(1, Math.ceil(displayWidth(`> ${line}`) / width));
  }
  return Math.min(8, rows);
}

export const readOnlyText = '只读 · 另一个进程正在运行';

export function visibleText(lines: string[]): string {
  return lines.map((line) => line.trimEnd()).join('\n');
}

function screenLines(screen: TuiScreen): string[] {
  const lines = [`${screen.product} · ${screen.title} · ${screen.modelName}`];
  if (screen.help) {
    lines.push(...helpLines());
  } else if (screen.chats) {
    lines.push('会话');
    for (const chat of screen.chats) lines.push(chatText(chat));
  } else {
    for (const line of screen.lines) {
      if (line.kind === 'tool') lines.push(toolText(line));
      else if (line.kind === 'user') lines.push(`user ${line.text ?? ''}`);
      else lines.push(line.text ?? '');
    }
  }
  if (!screen.help && !screen.chats) lines.push(...childLines(screen.children ?? []));
  if (screen.readOnly) lines.push(readOnlyText);
  if (screen.approval) lines.push(...approvalLines(screen.approval));
  if (screen.ask) lines.push(`追问 ${screen.ask.prompt}`);
  for (const pick of screen.picks ?? []) lines.push(pickText(pick));
  const attached = attachmentText(screen.attachments ?? []);
  if (attached) lines.push(attached);
  lines.push(draftLine(screen.draft, screen.cursor));
  if (screen.status) lines.push(screen.status);
  lines.push(footerText());
  return lines;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code > 0xff ? 2 : 1;
  }
  return width;
}

class PlainLine implements Component {
  constructor(private readonly text: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    return new Text(this.text.length > 0 ? this.text : ' ', 0, 0).render(width);
  }
}
