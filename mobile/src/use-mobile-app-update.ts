import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppUpdateOpenResult, AppUpdateSnapshot } from '../../src/shared/app-update';
import { MobileAppUpdateService } from './app-update';

export interface MobileAppUpdateController {
  readonly snapshot: AppUpdateSnapshot;
  readonly check: () => Promise<void>;
  readonly download: () => Promise<void>;
  readonly cancelDownload: () => Promise<void>;
  readonly openDownloaded: () => Promise<AppUpdateOpenResult>;
}

const AUTOMATIC_CHECK_ENABLED =
  import.meta.env.MODE !== 'test'
  && !(typeof __EZTERMINAL_E2E__ !== 'undefined' && __EZTERMINAL_E2E__);

export function useMobileAppUpdate(): MobileAppUpdateController {
  const serviceRef = useRef<MobileAppUpdateService | null>(null);
  if (serviceRef.current === null) serviceRef.current = new MobileAppUpdateService();
  const service = serviceRef.current;
  const [snapshot, setSnapshot] = useState(() => service.getSnapshot());
  const lifecycleGenerationRef = useRef(0);

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;
    const unsubscribe = service.subscribe(setSnapshot);
    if (AUTOMATIC_CHECK_ENABLED) void service.check();
    return () => {
      unsubscribe();
      // React StrictMode performs setup -> cleanup -> setup against the same
      // hook state. Defer final disposal so that development probe cannot
      // permanently disable the second, real setup.
      queueMicrotask(() => {
        if (lifecycleGenerationRef.current === generation) void service.dispose();
      });
    };
  }, [service]);

  const check = useCallback(async (): Promise<void> => {
    setSnapshot(await service.check());
  }, [service]);
  const download = useCallback(async (): Promise<void> => {
    setSnapshot(await service.download());
  }, [service]);
  const cancelDownload = useCallback(
    () => service.cancelDownload(),
    [service],
  );
  const openDownloaded = useCallback(
    () => service.openDownloaded(),
    [service],
  );

  return { snapshot, check, download, cancelDownload, openDownloaded };
}
