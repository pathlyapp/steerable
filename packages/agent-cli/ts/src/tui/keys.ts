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

function formatKey(key: string): string {
  if (key === 'escape') return 'Esc';
  if (key === 'enter') return 'Enter';
  if (/^shift\+[a-z]$/.test(key)) return key.slice('shift+'.length).toUpperCase();
  if (!key.includes('+')) return key;
  return key.split('+').map((part) => {
    if (part === 'ctrl') return 'Ctrl';
    if (part.length === 1) return part.toUpperCase();
    return part[0]!.toUpperCase() + part.slice(1);
  }).join('+');
}
