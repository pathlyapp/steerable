import { Box, Text, type Component } from '@earendil-works/pi-tui';

import { keyLabel } from './keys.js';

export interface TranscriptLine {
  kind: 'user' | 'assistant' | 'tool';
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
  status: string;
}

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
  return ['/new 新会话', '/model 查看或切换模型', '/clear 清屏', '/help 帮助'];
}

export function approvalLines(approval: { toolName: string; summary: string }): string[] {
  return [
    `审批 ${approval.toolName} ${approval.summary}`.trimEnd(),
    `${keyLabel('agent.approval.allowOnce')} 本次允许  ${keyLabel('agent.approval.allowSession')} 本会话  ${keyLabel('agent.approval.allowAlways')} 总是`,
    `${keyLabel('agent.approval.denyOnce')} 拒绝  ${keyLabel('agent.approval.denySession')} 本会话拒绝  ${keyLabel('agent.approval.denyAlways')} 总是拒绝  ${keyLabel('agent.approval.abort')} 中止`,
  ];
}

export function footerText(): string {
  return `${keyLabel('agent.interrupt')} 中断 · ${keyLabel('agent.chats')} 会话 · /help`;
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
  if (screen.readOnly) lines.push(readOnlyText);
  if (screen.approval) lines.push(...approvalLines(screen.approval));
  if (screen.ask) lines.push(`追问 ${screen.ask.prompt}`);
  lines.push(`> ${screen.draft}`);
  if (screen.status) lines.push(screen.status);
  lines.push(footerText());
  return lines;
}

class PlainLine implements Component {
  constructor(private readonly text: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    return new Text(this.text.length > 0 ? this.text : ' ', 0, 0).render(width);
  }
}
