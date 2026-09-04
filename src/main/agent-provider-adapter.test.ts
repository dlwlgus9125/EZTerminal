import { describe, expect, it } from 'vitest';

import { validateProviderProbe, type ProviderProbeResult } from './agent-provider-adapter';

const validProbe: ProviderProbeResult = {
  providerId: 'codex',
  displayName: 'Codex',
  protocol: 'codex-app-server',
  available: true,
  executablePath: 'C:\\Tools\\codex.exe',
  executableVersion: '0.152.1',
  argv: ['app-server'],
  environmentVariableNames: ['PATH'],
  capabilities: ['create', 'resume', 'interrupt', 'approvals'],
};

describe('AgentProviderAdapter contract', () => {
  it('accepts a fully inspectable provider probe', () => {
    expect(() => validateProviderProbe(validProbe)).not.toThrow();
  });

  it('rejects probes that cannot be reviewed before enablement', () => {
    expect(() => validateProviderProbe({ ...validProbe, executablePath: '' })).toThrow(/executable identity/i);
    expect(() => validateProviderProbe({ ...validProbe, environmentVariableNames: ['TOKEN=value'] })).toThrow(/variable names/i);
  });
});
