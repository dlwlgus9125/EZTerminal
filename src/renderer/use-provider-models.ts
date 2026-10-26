import { useEffect, useRef, useState } from 'react';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { ProviderModel } from '../shared/daemon-provider';
import type { CapabilityAccess } from './capability-access';

export type ProviderModelCatalogs = Readonly<Record<string, readonly { readonly id: string; readonly displayName: string }[]>>;

/**
 * Model lists of the ready AI providers, asked once per provider revision. Claude
 * answers by launching its CLI, which takes seconds while the snapshot changes
 * many times; the revision is claimed before asking so it is asked only once.
 */
export function useProviderModelCatalogs(snapshot: DaemonSnapshot | null, capabilities: CapabilityAccess): ProviderModelCatalogs {
  const [catalogs, setCatalogs] = useState<ProviderModelCatalogs>({});
  const revisions = useRef<Readonly<Record<string, number>>>({});
  useEffect(() => {
    if (!snapshot) return;
    const targets = snapshot.providers.filter((provider) => (
      provider.enabled
      && provider.health === 'ready'
      && revisions.current[provider.id] !== provider.revision
    ));
    if (targets.length === 0) return;
    // Claimed before asking: Claude answers by launching its CLI, which takes seconds, and the
    // snapshot changes many times meanwhile. Asking again on each change launched a CLI each time.
    revisions.current = {
      ...revisions.current,
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
        const next = { ...revisions.current };
        const answered: Record<string, readonly ProviderModel[]> = {};
        for (const [providerId, providerRevision, models] of entries) {
          // A newer provider revision was asked for meanwhile; its answer wins.
          if (next[providerId] !== providerRevision) continue;
          if (models) answered[providerId] = models;
          else delete next[providerId];
        }
        revisions.current = next;
        if (Object.keys(answered).length > 0) setCatalogs((current) => ({ ...current, ...answered }));
      });
  }, [capabilities, snapshot]);
  return catalogs;
}
