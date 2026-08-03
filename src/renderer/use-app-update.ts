import { useCallback, useEffect, useState } from 'react';

import {
  createInitialAppUpdateSnapshot,
  type AppUpdateOpenResult,
  type AppUpdateSnapshot,
} from '../shared/app-update';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';

export interface AppUpdateController {
  readonly snapshot: AppUpdateSnapshot;
  readonly check: () => Promise<void>;
  readonly download: () => Promise<void>;
  readonly cancelDownload: () => Promise<void>;
  readonly openDownloaded: (acknowledgeUnsigned: boolean) => Promise<AppUpdateOpenResult | null>;
}

export function useAppUpdate(
  capabilities: CapabilityAccess = rendererCapabilities,
): AppUpdateController {
  const currentVersion = capabilities.runtimeVersions()?.app ?? '0.0.0';
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot>(
    () => createInitialAppUpdateSnapshot(currentVersion),
  );

  useEffect(() => capabilities.appUpdates.observe(setSnapshot), [capabilities]);

  const check = useCallback(async (): Promise<void> => {
    const next = await capabilities.appUpdates.check();
    if (next) setSnapshot(next);
  }, [capabilities]);
  const download = useCallback(async (): Promise<void> => {
    const next = await capabilities.appUpdates.download();
    if (next) setSnapshot(next);
  }, [capabilities]);
  const cancelDownload = useCallback(async (): Promise<void> => {
    await capabilities.appUpdates.cancelDownload();
  }, [capabilities]);
  const openDownloaded = useCallback(
    (acknowledgeUnsigned: boolean) =>
      capabilities.appUpdates.openDownloaded(acknowledgeUnsigned),
    [capabilities],
  );

  return {
    snapshot,
    check,
    download,
    cancelDownload,
    openDownloaded,
  };
}
