import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  bold,
  dim as dimText,
  italic,
  reverse,
  strikethrough,
  t,
  underline,
  type CliRenderer,
  type Renderable,
  type StyledText,
} from '@opentui/core';

import { splitAtCursor } from './editor.js';
import { childLines } from './children.js';
import {
  approvalLines,
  attachmentText,
  bannerLines,
  chatText,
  composerRows,
  draftHint,
  footerText,
  helpLines,
  pickText,
  readOnlyText,
  reasoningBlock,
  toolBlock,
  type TranscriptLine,
  type TuiScreen,
} from './screen.js';
import { pageScrollLines } from './scroll.js';
import { plainMarkdown } from './transcript.js';

const canvas = '#16161e';
const bar = '#24283b';
const ink = '#c0caf5';
const dim = '#565f89';
const user = '#7aa2f7';
const tool = '#9ece6a';
const warn = '#e0af68';
const danger = '#f7768e';
const prompt = '#bb9af7';
const selected = '#33467c';

/** Live terminal picture. The session still owns input and the text snapshot. */
export class OpenTuiView {
  private readonly renderer: CliRenderer;
  private readonly heading: TextRenderable;
  private readonly model: TextRenderable;
  private readonly body: ScrollBoxRenderable;
  private readonly readOnly: TextRenderable;
  private readonly overlay: BoxRenderable;
  private readonly picks: BoxRenderable;
  private readonly attached: TextRenderable;
  private readonly queued: TextRenderable;
  private readonly search: TextRenderable;
  private readonly banner: TextRenderable;
  private readonly composer: BoxRenderable;
  private readonly draft: TextRenderable;
  private readonly status: TextRenderable;
  private readonly footer: TextRenderable;
  private bodyKey = '';
  private overlayKey = '';
  private picksKey = '';
  private chatListOpen = false;
  private transcriptPinned = true;
  private transcriptScroll = 0;
  private revealId: string | null = null;
  private restoreTranscript = false;
  private readonly onFrame = (): void => {
    if (this.restoreTranscript) {
      this.restoreTranscript = false;
      this.body.stickyScroll = true;
      const max = this.maxScrollTop();
      this.body.scrollTop = this.transcriptPinned ? max : Math.min(this.transcriptScroll, max);
      return;
    }
    if (!this.revealId) return;
    const id = this.revealId;
    this.revealId = null;
    this.body.scrollChildIntoView(id);
  };

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
    renderer.on('frame', this.onFrame);
    renderer.once('destroy', () => {
      renderer.off('frame', this.onFrame);
    });
    const shell = new BoxRenderable(renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: canvas,
    });
    const header = new BoxRenderable(renderer, {
      width: '100%',
      height: 1,
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: bar,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.heading = text(renderer, ink);
    this.model = text(renderer, user);
    header.add(this.heading);
    header.add(this.model);

    this.body = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      flexShrink: 1,
      width: '100%',
      stickyScroll: true,
      stickyStart: 'bottom',
      viewportCulling: false,
      rootOptions: { backgroundColor: canvas },
      contentOptions: { backgroundColor: canvas, paddingLeft: 1, paddingRight: 1, gap: 1 },
    });

    this.readOnly = text(renderer, danger);
    this.readOnly.content = readOnlyText;

    this.overlay = new BoxRenderable(renderer, {
      width: '100%',
      border: true,
      borderStyle: 'rounded',
      borderColor: warn,
      backgroundColor: '#2d2a1f',
      paddingLeft: 1,
      paddingRight: 1,
      visible: false,
    });

    this.picks = new BoxRenderable(renderer, {
      width: '100%',
      border: true,
      borderStyle: 'rounded',
      borderColor: user,
      backgroundColor: '#1a1b2e',
      paddingLeft: 1,
      paddingRight: 1,
      visible: false,
    });
    this.attached = text(renderer, warn);
    this.queued = text(renderer, warn);
    this.queued.visible = false;
    this.search = text(renderer, warn);
    this.search.visible = false;
    this.banner = text(renderer, warn);
    this.banner.visible = false;
    this.composer = new BoxRenderable(renderer, {
      width: '100%',
      height: 1,
      flexShrink: 0,
      backgroundColor: bar,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.draft = new TextRenderable(renderer, {
      content: '',
      fg: prompt,
      width: '100%',
      wrapMode: 'word',
    });
    this.composer.add(this.draft);

    this.status = text(renderer, warn);
    this.footer = text(renderer, dim);
    const footerBar = new BoxRenderable(renderer, {
      width: '100%',
      height: 1,
      backgroundColor: canvas,
      paddingLeft: 1,
      paddingRight: 1,
    });
    footerBar.add(this.footer);

    shell.add(header);
    shell.add(this.body);
    shell.add(this.readOnly);
    shell.add(this.overlay);
    shell.add(this.picks);
    shell.add(this.attached);
    shell.add(this.banner);
    shell.add(this.queued);
    shell.add(this.search);
    shell.add(this.composer);
    shell.add(this.status);
    shell.add(footerBar);
    renderer.root.add(shell);
  }

  scrollPage(direction: -1 | 1): void {
    const height = this.body.viewport.height;
    this.body.scrollBy(pageScrollLines(typeof height === 'number' ? height : 0, direction));
  }

  scrollEdge(edge: 'top' | 'bottom'): void {
    if (edge === 'top') this.body.scrollTo(0);
    else this.body.scrollTo(this.body.scrollHeight);
  }

  apply(screen: TuiScreen): void {
    this.heading.content = `${screen.product}  ${screen.title}`;
    this.model.content = screen.modelName;
    this.readOnly.visible = screen.readOnly;
    this.draft.content = draftContent(screen.draft, screen.cursor);
    this.composer.height = composerRows(screen.draft, Math.max(1, this.renderer.width - 2));
    this.status.content = screen.status;
    this.status.visible = screen.status.length > 0;
    this.footer.content = footerText();
    const attached = attachmentText(screen.attachments ?? []);
    this.attached.content = attached;
    this.attached.visible = attached.length > 0;
    const queued = screen.queued ?? [];
    this.queued.content = queued.map((item) => `排队 ${item}`).join('\n');
    this.queued.visible = queued.length > 0;
    this.queued.height = queued.length;
    const search = screen.search ?? '';
    this.search.content = search;
    this.search.visible = search.length > 0;
    this.search.height = search.length > 0 ? 1 : 0;
    const banner = bannerLines(screen);
    this.banner.content = banner.join('\n');
    this.banner.visible = banner.length > 0;
    this.banner.height = banner.length;
    if (screen.scroll) this.scrollEdge(screen.scroll);
    if (typeof screen.searchFocus === 'number') this.body.scrollChildIntoView(`line-${screen.searchFocus}`);
    this.paintOverlay(screen);
    this.paintPicks(screen);
    this.followChats(screen);

    const key = bodyKey(screen);
    if (key === this.bodyKey) return;
    this.bodyKey = key;
    this.replaceBody(screen);
  }

  /** Transcript stays pinned to the bottom. The chat list follows the selected row instead. */
  private followChats(screen: TuiScreen): void {
    const chats = screen.chats;
    if (chats && !this.chatListOpen) {
      this.transcriptPinned = this.atBottom();
      this.transcriptScroll = this.body.scrollTop;
      this.body.stickyScroll = false;
      this.body.scrollTop = 0;
      this.chatListOpen = true;
    } else if (!chats && this.chatListOpen) {
      this.chatListOpen = false;
      this.revealId = null;
      this.restoreTranscript = true;
      this.body.stickyScroll = false;
    }
    if (!chats) return;
    const index = chats.findIndex((chat) => chat.selected);
    this.revealId = index < 0 ? null : index === 0 ? 'chat-heading' : `chat-${index}`;
  }

  private atBottom(): boolean {
    return this.body.scrollTop >= this.maxScrollTop() - 1;
  }

  private maxScrollTop(): number {
    return Math.max(0, this.body.scrollHeight - this.viewportRows());
  }

  private viewportRows(): number {
    const height = this.body.viewport.height;
    return typeof height === 'number' ? height : 0;
  }

  private paintOverlay(screen: TuiScreen): void {
    const lines = screen.approval
      ? approvalLines(screen.approval)
      : screen.ask
        ? [`追问 ${screen.ask.prompt}`]
        : [];
    const key = lines.join('\n');
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    for (const child of this.overlay.getChildren()) {
      this.overlay.remove(child);
      child.destroyRecursively();
    }
    this.overlay.visible = lines.length > 0;
    this.overlay.height = lines.length === 0 ? 0 : lines.length + 2;
    if (lines.length === 0) return;
    this.overlay.add(new TextRenderable(this.renderer, {
      content: lines.join('\n'),
      fg: ink,
      width: '100%',
      height: lines.length,
      wrapMode: 'none',
    }));
  }

  private paintPicks(screen: TuiScreen): void {
    const lines = (screen.picks ?? []).map(pickText);
    const key = lines.join('\n');
    if (key === this.picksKey) return;
    this.picksKey = key;
    for (const child of this.picks.getChildren()) {
      this.picks.remove(child);
      child.destroyRecursively();
    }
    this.picks.visible = lines.length > 0;
    this.picks.height = lines.length === 0 ? 0 : lines.length + 2;
    if (lines.length === 0) return;
    this.picks.add(new TextRenderable(this.renderer, {
      content: lines.join('\n'),
      fg: ink,
      width: '100%',
      height: lines.length,
      wrapMode: 'none',
    }));
  }

  private replaceBody(screen: TuiScreen): void {
    for (const child of this.body.getChildren()) {
      this.body.remove(child);
      child.destroyRecursively();
    }
    const renderer = this.renderer;
    if (screen.help) {
      for (const line of helpLines()) this.body.add(text(renderer, dim, line));
      return;
    }
    if (screen.chats) {
      this.body.add(text(renderer, dim, '会话', 'chat-heading'));
      screen.chats.forEach((chat, index) => {
        const row = new BoxRenderable(renderer, {
          id: `chat-${index}`,
          width: '100%',
          height: 1,
          backgroundColor: chat.selected ? selected : canvas,
          paddingLeft: 1,
        });
        row.add(text(renderer, chat.selected ? ink : dim, chatText(chat)));
        this.body.add(row);
      });
      return;
    }
    screen.lines.forEach((line, index) => {
      this.body.add(transcriptRow(renderer, line, `line-${index}`));
    });
    for (const line of childLines(screen.children ?? [])) this.body.add(text(renderer, tool, line));
  }
}

function draftContent(draft: string, cursor: number): StyledText {
  const { before, head, after } = splitAtCursor(draft, cursor);
  const mark = reverse('▍');
  if (draft.length === 0) return t`> ${mark} ${dimText(draftHint())}`;
  if (head.length === 0) return t`> ${before}${mark}`;
  return t`> ${before}${mark}${head}${after}`;
}

function bodyKey(screen: TuiScreen): string {
  return JSON.stringify({
    help: screen.help,
    chats: screen.chats,
    lines: screen.lines,
    children: screen.children ?? [],
  });
}

function transcriptRow(renderer: CliRenderer, line: TranscriptLine, id: string): Renderable {
  if (line.kind === 'reasoning') {
    const card = new BoxRenderable(renderer, {
      id,
      width: '100%',
      border: true,
      borderStyle: 'rounded',
      borderColor: warn,
      paddingLeft: 1,
      paddingRight: 1,
    });
    for (const row of reasoningBlock(line)) card.add(text(renderer, row.startsWith('  ') ? dim : warn, row));
    return card;
  }
  if (line.kind === 'tool') {
    const card = new BoxRenderable(renderer, {
      id,
      width: '100%',
      border: true,
      borderStyle: 'rounded',
      borderColor: tool,
      paddingLeft: 1,
      paddingRight: 1,
    });
    for (const row of toolBlock(line)) card.add(text(renderer, row.startsWith('  ') ? dim : tool, row));
    return card;
  }
  if (line.kind === 'user') {
    return text(renderer, user, `user ${line.text ?? ''}`, id);
  }
  if (line.kind === 'assistant') {
    return markdown(renderer, line.text ?? '', id);
  }
  const plain = plainMarkdown(line.text ?? '');
  return text(renderer, ink, plain.length > 0 ? plain : ' ', id);
}

function markdown(renderer: CliRenderer, source: string, id: string): Renderable {
  const box = new BoxRenderable(renderer, {
    id,
    width: '100%',
    flexDirection: 'column',
  });
  let fenced = false;
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      box.add(text(renderer, tool, raw.length > 0 ? raw : ' '));
      continue;
    }
    const content = plainMarkdown(raw);
    if (/^#{1,6}\s+/.test(raw)) box.add(text(renderer, user, t`${bold(content)}`));
    else if (/^\s*>/.test(raw)) box.add(text(renderer, dim, t`${italic(content.replace(/^\s*>\s?/, ''))}`));
    else if (/\*\*[^*\n]+\*\*/.test(raw)) box.add(text(renderer, ink, t`${bold(content)}`));
    else if (/~~[^~\n]+~~/.test(raw)) box.add(text(renderer, ink, t`${strikethrough(content)}`));
    else if (/\[[^\]\n]+\]\([^)]+\)/.test(raw)) box.add(text(renderer, user, t`${underline(content)}`));
    else if (/`[^`\n]+`/.test(raw)) box.add(text(renderer, tool, content));
    else box.add(text(renderer, ink, content.length > 0 ? content : ' '));
  }
  return box;
}

function text(renderer: CliRenderer, fg: string, content: string | StyledText = '', id?: string): TextRenderable {
  return new TextRenderable(renderer, { ...(id ? { id } : {}), content, fg, wrapMode: 'word' });
}
