import { describe, expect, it } from 'vitest';

import {
  SIGNPATH_CONFIGURATION_NAMES,
  resolveWindowsSigningMode,
} from '../scripts/resolve-windows-signing-mode.mjs';

function completeConfiguration(): Record<string, string> {
  return Object.fromEntries(
    SIGNPATH_CONFIGURATION_NAMES.map((name) => [name, `configured-${name}`]),
  );
}

describe('Windows release signing mode', () => {
  it('allows unsigned maintenance releases only when SignPath is completely absent', () => {
    expect(resolveWindowsSigningMode('unsigned', {})).toBe('unsigned');
    expect(() => resolveWindowsSigningMode('unsigned', {
      SIGNPATH_PROJECT_SLUG: 'ezterminal',
    })).toThrow('still selects unsigned Windows releases');
  });

  it('requires every SignPath value once signed releases are enabled', () => {
    expect(resolveWindowsSigningMode('signpath', completeConfiguration())).toBe('signpath');
    expect(() => resolveWindowsSigningMode('signpath', {
      SIGNPATH_API_TOKEN: 'token',
    })).toThrow('SignPath configuration is incomplete');
  });

  it('rejects unknown policy modes and whitespace-only values', () => {
    expect(() => resolveWindowsSigningMode('automatic', {}))
      .toThrow('Unsupported Windows signing policy mode');
    expect(() => resolveWindowsSigningMode('signpath', {
      ...completeConfiguration(),
      SIGNPATH_API_TOKEN: '   ',
    })).toThrow('SIGNPATH_API_TOKEN');
  });
});
