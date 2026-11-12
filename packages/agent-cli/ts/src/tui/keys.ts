import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type Keybinding,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from '@earendil-works/pi-tui';

declare module '@earendil-works/pi-tui' {
  interface Keybindings {
    'agent.interrupt': true;
    'agent.chats': true;
    'agent.approval.allowOnce': true;
    'agent.approval.allowSession': true;
    'agent.approval.allowAlways': true;
    'agent.approval.denyOnce': true;
    'agent.approval.denySession': true;
    'agent.approval.denyAlways': true;
    'agent.approval.abort': true;
    'agent.tool.toggle': true;
    'agent.clipboard.paste': true;
    'agent.queue.pull': true;
    'agent.copy.reply': true;
    'agent.editor': true;
  }
}

export const AGENT_KEYBINDINGS = {
  'agent.interrupt': { defaultKeys: 'ctrl+c', description: 'Interrupt the current turn or leave' },
  'agent.chats': { defaultKeys: 'ctrl+l', description: 'Show chats' },
  'agent.approval.allowOnce': { defaultKeys: 'y', description: 'Allow this tool once' },
  'agent.approval.allowSession': { defaultKeys: 's', description: 'Allow this tool for the chat' },
  'agent.approval.allowAlways': { defaultKeys: 'a', description: 'Always allow this tool' },
  'agent.approval.denyOnce': { defaultKeys: 'n', description: 'Deny this tool once' },
  'agent.approval.denySession': { defaultKeys: 'shift+n', description: 'Deny this tool for the chat' },
  'agent.approval.denyAlways': { defaultKeys: 'shift+a', description: 'Always deny this tool' },
  'agent.approval.abort': { defaultKeys: 'escape', description: 'Abort the turn' },
  'agent.tool.toggle': { defaultKeys: 'ctrl+o', description: 'Expand the latest finished tool' },
  'agent.clipboard.paste': {
    defaultKeys: process.platform === 'win32' ? 'alt+v' : 'ctrl+v',
    description: 'Paste an image or text from the clipboard',
  },
  'agent.queue.pull': { defaultKeys: 'alt+up', description: 'Pull the latest queued line back into the composer' },
  'agent.copy.reply': { defaultKeys: 'alt+c', description: 'Copy the latest assistant reply' },
  'agent.editor': { defaultKeys: 'alt+e', description: 'Edit the draft in an external editor' },
} as const satisfies KeybindingDefinitions;

const DEFINITIONS: KeybindingDefinitions = { ...TUI_KEYBINDINGS, ...AGENT_KEYBINDINGS };

export function installAgentKeybindings(user: KeybindingsConfig = {}): void {
  setKeybindings(new KeybindingsManager(DEFINITIONS, user));
}

export function ensureAgentKeybindings(): void {
  if (getKeybindings().getKeys('agent.interrupt').length === 0) installAgentKeybindings();
}

export function keyLabel(id: Keybinding): string {
  ensureAgentKeybindings();
  const key = getKeybindings().getKeys(id)[0] ?? '';
  return formatKey(key);
}

const MAC_NAME: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Option',
  opt: 'Option',
  option: 'Option',
  meta: 'Command',
  cmd: 'Command',
  command: 'Command',
  super: 'Command',
  enter: 'Return',
  return: 'Return',
  escape: 'Esc',
  esc: 'Esc',
  tab: 'Tab',
  backspace: 'Delete',
  delete: 'Forward Delete',
  space: 'Space',
};

export function formatKey(key: string, platform = process.platform): string {
  if (/^shift\+[a-z]$/.test(key)) return key.slice('shift+'.length).toUpperCase();
  if (platform === 'darwin') {
    const parts = key.split('+');
    return parts.map((part, index) => macName(part, parts.length > 1 && index === parts.length - 1)).join('+');
  }
  if (key === 'escape') return 'Esc';
  if (key === 'enter') return 'Enter';
  if (!key.includes('+')) return key;
  return key.split('+').map((part) => wordPart(part)).join('+');
}

function macName(part: string, chordKey: boolean): string {
  if (MAC_NAME[part]) return MAC_NAME[part];
  if (part.length === 1) return chordKey ? part.toUpperCase() : part;
  return part[0]!.toUpperCase() + part.slice(1);
}

function wordPart(part: string): string {
  if (part === 'ctrl') return 'Ctrl';
  if (part.length === 1) return part.toUpperCase();
  return part[0]!.toUpperCase() + part.slice(1);
}
