import { readFileSync } from 'node:fs';
import path from 'node:path';
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

function workflowStep(name: string): string {
  const workflow = readFileSync(path.resolve('.github', 'workflows', 'release.yml'), 'utf8');
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Release workflow step is missing: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
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

  it('keeps the isolated silent-install smoke unattended and preserves its primary failure', () => {
    const step = workflowStep('Verify signatures after a silent install');
    const workflow = readFileSync(path.resolve('.github', 'workflows', 'release.yml'), 'utf8');

    expect(step).toContain("EZTERMINAL_REMOTE_ALLOW_DEV_INSTALL: '1'");
    expect(workflow.match(/EZTERMINAL_REMOTE_ALLOW_DEV_INSTALL/g)).toHaveLength(1);
    expect(step).toContain('function Remove-SignatureSmokeDirectory');
    expect(step).toContain("throw 'Silent uninstaller timed out.'");
    expect(step).toContain('$primaryError');
  });
});
