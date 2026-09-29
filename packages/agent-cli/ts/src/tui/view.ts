import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from '@opentui/core';

import {
  approvalLines,
  chatText,
  footerText,
  helpLines,
  readOnlyText,
  toolText,
  type TranscriptLine,
  type TuiScreen,
} from './screen.js';

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
  private readonly draft: TextRenderable;
  private readonly status: TextRenderable;
  private readonly footer: TextRenderable;
  private bodyKey = '';
  private overlayKey = '';

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
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

    const input = new BoxRenderable(renderer, {
      width: '100%',
      height: 1,
      backgroundColor: bar,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.draft = text(renderer, prompt);
    input.add(this.draft);

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
    shell.add(input);
    shell.add(this.status);
    shell.add(footerBar);
    renderer.root.add(shell);
  }

  apply(screen: TuiScreen): void {
    this.heading.content = `${screen.product}  ${screen.title}`;
    this.model.content = screen.modelName;
    this.readOnly.visible = screen.readOnly;
    this.draft.content = `> ${screen.draft}`;
    this.status.content = screen.status;
    this.status.visible = screen.status.length > 0;
    this.footer.content = footerText();
    this.paintOverlay(screen);

    const key = bodyKey(screen);
    if (key === this.bodyKey) return;
    this.bodyKey = key;
    this.replaceBody(screen);
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
      this.body.add(text(renderer, dim, '会话'));
      for (const chat of screen.chats) {
        const row = new BoxRenderable(renderer, {
          width: '100%',
          height: 1,
          backgroundColor: chat.selected ? selected : canvas,
          paddingLeft: 1,
        });
        row.add(text(renderer, chat.selected ? ink : dim, chatText(chat)));
        this.body.add(row);
      }
      return;
    }
    for (const line of screen.lines) this.body.add(transcriptRow(renderer, line));
  }
}

function bodyKey(screen: TuiScreen): string {
  return JSON.stringify({
    help: screen.help,
    chats: screen.chats,
    lines: screen.lines,
  });
}

function transcriptRow(renderer: CliRenderer, line: TranscriptLine): Renderable {
  if (line.kind === 'tool') {
    const card = new BoxRenderable(renderer, {
      width: '100%',
      border: true,
      borderStyle: 'rounded',
      borderColor: tool,
      paddingLeft: 1,
      paddingRight: 1,
    });
    card.add(text(renderer, tool, toolText(line)));
    return card;
  }
  if (line.kind === 'user') {
    return text(renderer, user, `user ${line.text ?? ''}`);
  }
  return text(renderer, ink, line.text && line.text.length > 0 ? line.text : ' ');
}

function text(renderer: CliRenderer, fg: string, content = ''): TextRenderable {
  return new TextRenderable(renderer, { content, fg, wrapMode: 'word' });
}
