import { describe, expect, it } from 'vitest';

import {
  ClaudeProviderAdapter,
  MemoryClaudeProviderEnablementStore,
  resolveClaudeExecutable,
  type ClaudeProviderEnablement,
} from './claude-provider-adapter';

/**
 * The packaged app resolves the Claude CLI the user installed, so the version
 * gate must accept whatever that CLI currently reports. Pinning it to one exact
 * build made every auto-updated install unenablable; this lane fails as soon as
 * the supported range drifts away from a real installation again.
 */

const consented: ClaudeProviderEnablement = {
  enabled: true,
  termsAccepted: true,
  commercialUseApproved: true,
  authenticationPath: 'existing-cli-environment',
  anthropicThirdPartyApproval: false,
};

const installedExecutable = await resolveClaudeExecutable();

describe.skipIf(installedExecutable === null)('installed Claude CLI compatibility', () => {
  it('probes the installed executable as available once consent is complete', async () => {
    const adapter = new ClaudeProviderAdapter({
      enablementStore: new MemoryClaudeProviderEnablementStore(consented),
    });

    const probe = await adapter.probe();

    expect(probe.executablePath).toBe(installedExecutable);
    expect(probe.executableVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(probe.unavailableReason).toBeUndefined();
    expect(probe.available).toBe(true);
  });
});
