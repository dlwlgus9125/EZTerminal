// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { discoverCapabilities } from './capability-discovery-cache';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useProviderModelCatalogs } from './use-provider-models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = (revision: number): DaemonSnapshot => ({
  providers: [{ id: 'claude', enabled: true, health: 'ready', revision }],
} as unknown as DaemonSnapshot);

describe('provider model catalogs', () => {
  it('asks each provider once per revision for every box in the renderer', async () => {
    const listModels = vi.fn(async () => ({ ok: true as const, value: [{ id: 'opus', displayName: 'Opus' }] }));
    const capabilities = { ...rendererCapabilities, structuredProviders: { ...rendererCapabilities.structuredProviders, listModels } } as unknown as CapabilityAccess;
    const seen: string[] = [];
    function Box({ revision }: { readonly revision: number }) {
      const catalogs = useProviderModelCatalogs(snapshot(revision), capabilities);
      seen.push(catalogs.claude?.[0]?.id ?? '');
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => { root.render(<><Box revision={1} /><Box revision={1} /><Box revision={1} /></>); });
    await act(async () => { await Promise.resolve(); });
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(seen.slice(-3)).toEqual(['opus', 'opus', 'opus']);
    await act(async () => { root.render(<><Box revision={2} /><Box revision={2} /></>); });
    expect(listModels).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); });
  });
});

describe('capability discovery cache', () => {
  it('shares one listing per scope for a minute and does not keep a failure', async () => {
    let now = 0;
    const list = vi.fn(async () => ({ ok: true as const, value: { items: [] } }));
    const client = { list, manage: vi.fn() } as never;
    const request = { providerId: 'claude', workspaceId: 'w', sessionId: 's' } as const;
    await discoverCapabilities(client, request, () => now);
    await discoverCapabilities(client, request, () => now);
    expect(list).toHaveBeenCalledTimes(1);
    now = 61_000;
    await discoverCapabilities(client, request, () => now);
    expect(list).toHaveBeenCalledTimes(2);

    // Two boxes wrap the same bridge function in their own client objects: one listing.
    const shared = vi.fn(async () => ({ ok: true as const, value: { items: [] } }));
    await discoverCapabilities({ list: shared, manage: vi.fn() } as never, request, () => 0);
    await discoverCapabilities({ list: shared, manage: vi.fn() } as never, request, () => 0);
    expect(shared).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => ({ ok: false as const, code: 'unavailable', message: 'down' }));
    const broken = { list: failing, manage: vi.fn() } as never;
    await discoverCapabilities(broken, request, () => 0);
    await Promise.resolve();
    await discoverCapabilities(broken, request, () => 0);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
