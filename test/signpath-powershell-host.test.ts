import { describe, expect, it, vi } from 'vitest';

import { selectAuthenticodePowerShell } from '../scripts/signpath-windows-lib.mjs';

describe('SignPath Authenticode PowerShell host selection', () => {
  it('prefers pwsh when both hosts can load Authenticode support', () => {
    const probe = vi.fn(() => true);

    expect(selectAuthenticodePowerShell(probe)).toBe('pwsh.exe');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('pwsh.exe');
  });

  it('falls back to Windows PowerShell only when pwsh cannot verify Authenticode', () => {
    const probe = vi.fn((candidate: string) => candidate === 'powershell.exe');

    expect(selectAuthenticodePowerShell(probe)).toBe('powershell.exe');
    expect(probe.mock.calls).toEqual([
      ['pwsh.exe'],
      ['powershell.exe'],
    ]);
  });

  it('fails closed when neither host can verify Authenticode', () => {
    expect(() => selectAuthenticodePowerShell(() => false))
      .toThrow('No PowerShell host with working Authenticode support was found.');
  });
});
