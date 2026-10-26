import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { ProviderModel } from '../shared/daemon-provider';
import type { CapabilityAccess } from './capability-access';

export type ProviderModelCatalogs = Readonly<Record<string, readonly { readonly id: string; readonly displayName: string }[]>>;

interface CatalogStore {
  revisions: Readonly<Record<string, number>>;
  catalogs: ProviderModelCatalogs;
  readonly listeners: Set<() => void>;
}

/** One catalog per host bridge, shared by every conversation tab and terminal AI input. */
const stores = new WeakMap<CapabilityAccess, CatalogStore>();

function storeFor(capabilities: CapabilityAccess): CatalogStore {
  const existing = stores.get(capabilities);
  if (existing) return existing;
  const created: CatalogStore = { revisions: {}, catalogs: {}, listeners: new Set() };
  stores.set(capabilities, created);
  return created;
}

/**
 * Ask for the model lists of ready providers whose revision was not asked for
 * yet. Claude answers by launching its CLI, which takes seconds while the
 * snapshot changes many times, so the revision is claimed before asking — and
 * claimed once for the whole renderer, not once per open box.
 */
function askChanged(store: CatalogStore, capabilities: CapabilityAccess, snapshot: DaemonSnapshot): void {
  const targets = snapshot.providers.filter((provider) => (
    provider.enabled
    && provider.health === 'ready'
    && store.revisions[provider.id] !== provider.revision
  ));
  if (targets.length === 0) return;
  store.revisions = {
    ...store.revisions,
    ...Object.fromEntries(targets.map((provider) => [provider.id, provider.revision])),
  };
  void Promise.all(targets
    .map(async (provider) => {
      const result = await Promise.resolve()
        .then(() => capabilities.structuredProviders.listModels(provider.id))
        .catch(() => null);
      return [provider.id, provider.revision, result?.ok ? result.value : null] as const;
    }))
    .then((entries) => {
      const revisions = { ...store.revisions };
      const answered: Record<string, readonly ProviderModel[]> = {};
      for (const [providerId, providerRevision, models] of entries) {
        // A newer provider revision was asked for meanwhile; its answer wins.
        if (revisions[providerId] !== providerRevision) continue;
        if (models) answered[providerId] = models;
        else delete revisions[providerId];
      }
      store.revisions = revisions;
      if (Object.keys(answered).length === 0) return;
      store.catalogs = { ...store.catalogs, ...answered };
      for (const listener of [...store.listeners]) listener();
    });
}

/** Model lists of the ready AI providers, asked once per provider revision for the whole renderer. */
export function useProviderModelCatalogs(snapshot: DaemonSnapshot | null, capabilities: CapabilityAccess): ProviderModelCatalogs {
  const store = storeFor(capabilities);
  const subscribe = useCallback((listener: () => void) => {
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  }, [store]);
  const catalogs = useSyncExternalStore(subscribe, () => store.catalogs);
  useEffect(() => {
    if (snapshot) askChanged(store, capabilities, snapshot);
  }, [capabilities, snapshot, store]);
  return catalogs;
}
