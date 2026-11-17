# Desktop paste

How a `Cmd+V` / `Ctrl+V` in the desktop app reaches the composer, and the four
places it used to lose content. Read this before changing the pasteboard read,
the menu wiring, or anything that rewrites the composer's draft.

## Why the renderer does not own paste

On macOS the app menu owns `CmdOrCtrl+V`. The menu item runs before the web
content sees the keystroke, so the page never receives a `paste` event, and a
WKWebView paste event that does arrive carries an empty `clipboardData` for
screenshots and copied files. The page therefore cannot read what the user
copied.

The host reads the pasteboard instead and hands the result to the renderer:

```
menu accelerator (Cmd+V)
  → "edit-paste" menu handler            src-tauri …/lib.rs
  → spawn_blocking(clipboard::read_clipboard)   reads OS pasteboard off-thread
  → emit("menu:paste", {text, files})
  → host-paste.ts installHostPaste() callback
  → insertHostClipboard → target field
```

`installHostPaste()` subscribes once, in `bootstrap()`. The composer also
handles its own `paste` event and `Cmd+V` keydown for the cases where the
keystroke does reach the page, and both routes call `requestHostPaste()`.

## The four ways a paste was lost

Each of these was independently enough to drop content. All four are fixed;
the notes below say what the failure looked like, so a regression is
recognizable.

### 1. The pasteboard read blocked the main thread

Reading an image with `arboard` returns RGBA, which then had to be re-encoded
as PNG. For a 2560×1440 screenshot that encode alone measured **985 ms**, and
it ran inside the menu callback — on the main thread. Any paste pressed during
that window was lost, and the UI stopped responding.

Screenshot tools already publish `public.png`, so the bytes are now taken as
they are (~5 ms) and only formats without a PNG payload are decoded:

```rust
// packages/agent-shell/tauri/src/clipboard.rs
fn clipboard_image() -> Option<ClipboardFile> {
    clipboard_image_from(pasteboard_png(), encoded_png)
}
```

The read also moved off the main thread — `spawn_blocking` in the menu handler
and `async` on `host_read_clipboard` / `host_read_clipboard_text` — so a slow
pasteboard can never stall the UI again.

### 2. A paste arriving during a read was dropped

`requestHostPaste` guarded a module-level `pending` flag and returned early
when it was set. That turns a second `Cmd+V` in the same second into a no-op
with no signal to the user.

Reads are now serialised through a promise chain, so a paste that arrives
while one is in flight runs after it rather than disappearing:

```ts
// packages/agent-shell/web/src/lib/host-paste.ts
pasteQueue = pasteQueue.then(() =>
  readHostClipboard(readClipboard, readText)
    .then((clip) => { insertHostClipboard(clip, target ?? null); })
    .catch((error: unknown) => {
      console.warn('[host-paste] clipboard read failed', error);
    }),
);
```

### 3. Two edits in one React commit overwrote each other

`replaceSelection` / `replaceRange` built the next draft from the `value`
**prop**. Two pastes landing in the same commit both read the pre-paste value,
so the second rebuilt the text without the first and collapsed to a no-op —
six rapid `Cmd+V` inserted four copies.

Edits now compose from `latestValueRef`, which tracks every accepted change,
and the caret comes from `editCaret`: while the DOM still shows the previous
draft its selection describes text the composer no longer considers current,
so the pending caret from the last edit is used instead.

### 4. A paste aimed at a composer that was being replaced

Sending the first message remounts the composer (hero layout → conversation
layout). A paste landing inside that gap had no connected target, so it was
dropped. `insertHostClipboard` now holds the content for at most
`HELD_PASTE_TTL_MS` (2 s) and writes it into the composer that replaces the
unmounted one. The window bounds the hold so a stale pasteboard can never
surface in a later conversation.

## Which field receives the paste

`focusedEditable()` picks, in order: the focused element if editable, then
`lastEditable`, then `composerPasteTarget`. Two exclusions matter:

- **xterm's hidden textarea** is never a target. The terminal pastes into its
  PTY itself; text written into that textarea never reaches the shell.
- **`lastEditable` expires.** Opening the app menu takes key focus, so the
  field must survive a blur — but once focus lands on another control *inside
  the page*, the remembered field is cleared, because a paste after the user
  clicked elsewhere must not go back to a field they left. The `focusout`
  handler decides on the next task, since a menu opens before focus settles.

## Fallback when the rich read is refused

Desktop capabilities may allow only `host_read_clipboard_text`. A denial of
the rich command must still insert plain text, so `readHostClipboard` falls
back to the text-only command and re-throws the original error only if that
also fails.

## Tests

| Behaviour | Test |
| --- | --- |
| Plain-text fallback on a denied rich read | `host-paste.test.ts` |
| A paste during an in-flight read still lands | `host-paste.test.ts` |
| Content held for the composer that replaces a sent one | `host-paste.test.ts` |
| Held content expires instead of leaking into a later chat | `host-paste.test.ts` |
| A field is forgotten once focus moves to another control | `host-paste.test.ts` |
| A field survives focus leaving the page for the menu | `host-paste.test.ts` |
| A paste for an unmounted target never lands elsewhere | `host-paste.test.ts` |
| The terminal keeps its own paste | `host-paste.test.ts` |
| Two edits in one commit both keep their text | `ChatInput.test.tsx` |
| A pasteboard PNG skips decode + re-encode | `clipboard.rs` |
| A TIFF-only image still reaches the composer | `clipboard.rs` |
| An empty pasteboard yields no attachment | `clipboard.rs` |

Rapid-input tests that drive the real app need care: injecting `Cmd+V` through
AppleScript drops keystrokes on any app — a plain browser textarea loses the
same ones — so it cannot distinguish a product bug from the harness.
