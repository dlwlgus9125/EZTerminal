export type TerminalAccessoryKeyId =
  | 'escape'
  | 'tab'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'shift-tab'
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'home'
  | 'end'
  | 'page-up'
  | 'page-down'
  | 'ctrl-l'
  | 'ctrl-z'
  | 'ctrl-r'
  | 'ctrl-a'
  | 'ctrl-e'
  | 'ctrl-w'
  | 'ctrl-u';

export interface TerminalAccessoryKey {
  readonly id: TerminalAccessoryKeyId;
  readonly label: string;
  readonly accessibleLabel: string;
  readonly bytes: string;
  readonly repeatable: boolean;
}

export const TERMINAL_ACCESSORY_KEYS: readonly TerminalAccessoryKey[] = [
  { id: 'escape', label: 'Esc', accessibleLabel: 'Escape', bytes: '\x1b', repeatable: false },
  { id: 'tab', label: 'Tab', accessibleLabel: 'Tab', bytes: '\t', repeatable: false },
  { id: 'ctrl-c', label: 'Ctrl+C', accessibleLabel: 'Control C', bytes: '\x03', repeatable: false },
  { id: 'ctrl-d', label: 'Ctrl+D', accessibleLabel: 'Control D', bytes: '\x04', repeatable: false },
  { id: 'arrow-up', label: '↑', accessibleLabel: 'Up arrow', bytes: '\x1b[A', repeatable: true },
  { id: 'arrow-down', label: '↓', accessibleLabel: 'Down arrow', bytes: '\x1b[B', repeatable: true },
  { id: 'arrow-left', label: '←', accessibleLabel: 'Left arrow', bytes: '\x1b[D', repeatable: true },
  { id: 'arrow-right', label: '→', accessibleLabel: 'Right arrow', bytes: '\x1b[C', repeatable: true },
  { id: 'shift-tab', label: 'Shift+Tab', accessibleLabel: 'Shift Tab', bytes: '\x1b[Z', repeatable: false },
  { id: 'enter', label: 'Enter', accessibleLabel: 'Enter', bytes: '\r', repeatable: false },
  { id: 'backspace', label: '⌫', accessibleLabel: 'Backspace', bytes: '\x7f', repeatable: true },
  { id: 'delete', label: 'Del', accessibleLabel: 'Delete', bytes: '\x1b[3~', repeatable: true },
  { id: 'home', label: 'Home', accessibleLabel: 'Home', bytes: '\x1b[H', repeatable: false },
  { id: 'end', label: 'End', accessibleLabel: 'End', bytes: '\x1b[F', repeatable: false },
  { id: 'page-up', label: 'PgUp', accessibleLabel: 'Page Up', bytes: '\x1b[5~', repeatable: false },
  { id: 'page-down', label: 'PgDn', accessibleLabel: 'Page Down', bytes: '\x1b[6~', repeatable: false },
  { id: 'ctrl-l', label: 'Ctrl+L', accessibleLabel: 'Control L', bytes: '\x0c', repeatable: false },
  { id: 'ctrl-z', label: 'Ctrl+Z', accessibleLabel: 'Control Z', bytes: '\x1a', repeatable: false },
  { id: 'ctrl-r', label: 'Ctrl+R', accessibleLabel: 'Control R', bytes: '\x12', repeatable: false },
  { id: 'ctrl-a', label: 'Ctrl+A', accessibleLabel: 'Control A', bytes: '\x01', repeatable: false },
  { id: 'ctrl-e', label: 'Ctrl+E', accessibleLabel: 'Control E', bytes: '\x05', repeatable: false },
  { id: 'ctrl-w', label: 'Ctrl+W', accessibleLabel: 'Control W', bytes: '\x17', repeatable: false },
  { id: 'ctrl-u', label: 'Ctrl+U', accessibleLabel: 'Control U', bytes: '\x15', repeatable: false },
];

export const DEFAULT_TERMINAL_ACCESSORY_KEY_IDS: readonly TerminalAccessoryKeyId[] = [
  'escape',
  'tab',
  'ctrl-c',
  'ctrl-d',
  'arrow-up',
  'arrow-down',
  'arrow-left',
  'arrow-right',
];

const KEY_BY_ID = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]));

export function isTerminalAccessoryKeyId(value: unknown): value is TerminalAccessoryKeyId {
  return typeof value === 'string' && KEY_BY_ID.has(value as TerminalAccessoryKeyId);
}

export function getTerminalAccessoryKey(id: TerminalAccessoryKeyId): TerminalAccessoryKey {
  const key = KEY_BY_ID.get(id);
  if (!key) throw new Error(`Unknown terminal accessory key: ${id}`);
  return key;
}
