import { describe, expect, it, vi } from 'vitest';

import {
  E2E_TELEMETRY_ENABLED,
  e2eLog,
  installE2ETerminalOutputProbe,
} from './e2e-telemetry';

describe('production E2E telemetry boundary', () => {
  it('is inert when the compile-time E2E flag is absent', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');

    expect(E2E_TELEMETRY_ENABLED).toBe(false);
    e2eLog('output:', 'secret terminal output');
    installE2ETerminalOutputProbe(document.body)();

    expect(log).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
});
