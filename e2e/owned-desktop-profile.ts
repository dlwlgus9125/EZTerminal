import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';

export interface AsyncCloser {
  close(): Promise<void>;
}

/**
 * Converts Playwright's Electron handle into an idempotent close contract.
 *
 * The application may exit before teardown, and Playwright may reject
 * close() after the OS has already terminated the process. The close event
 * and child-process state are authoritative in those cases so a dead process
 * cannot strand its otherwise removable profile.
 */
export function trackElectronApplicationClose(
  app: ElectronApplication,
): AsyncCloser {
  let closeObserved = false;
  let closing: Promise<void> | null = null;
  const processExited = (): boolean => {
    try {
      const child = app.process();
      return child.exitCode !== null || child.signalCode !== null;
    } catch {
      return closeObserved;
    }
  };

  if (processExited()) {
    closeObserved = true;
  } else {
    app.once('close', () => {
      closeObserved = true;
    });
  }

  return {
    close: () => {
      if (closing) return closing;
      if (closeObserved || processExited()) {
        closeObserved = true;
        return Promise.resolve();
      }

      const attempt = (async () => {
        try {
          await app.close();
        } catch (error) {
          if (!closeObserved && !processExited()) throw error;
        }
        closeObserved = true;
      })().finally(() => {
        if (closing === attempt) closing = null;
      });
      closing = attempt;
      return attempt;
    },
  };
}

export interface OwnedDesktopProfileLease {
  /**
   * Resolves a launch reservation. Pass the application only when launch
   * succeeded; a failed launch still settles the reservation so teardown can
   * safely remove the profile.
   */
  settle(closer?: AsyncCloser): void;
}

export interface OwnedDesktopProfileOwner {
  readonly userDataDir: string;
  settle(closer?: AsyncCloser): void;
  dispose(): Promise<void>;
}

export type OwnedDesktopProfileRemover = (userDataDir: string) => Promise<void>;

const OWNED_PROFILE_NAME =
  /^ezterm-(?:[a-z0-9]+-)*[a-z0-9]+-[a-z0-9]{6}$/iu;
const OWNED_TEMP_PREFIX = /^ezterm-(?:[a-z0-9]+-)+$/iu;

function assertOwnedDesktopE2eProfile(userDataDir: string): string {
  const temporaryRoot = path.resolve(tmpdir());
  const resolved = path.resolve(userDataDir);
  const relative = path.relative(temporaryRoot, resolved);
  if (
    relative === ''
    || path.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.dirname(relative) !== '.'
    || !OWNED_PROFILE_NAME.test(path.basename(resolved))
  ) {
    throw new Error(`Refusing to remove an unowned desktop E2E profile: ${resolved}`);
  }
  return resolved;
}

async function removeOwnedDesktopE2eProfile(userDataDir: string): Promise<void> {
  await rm(userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

interface RegisteredCloserState {
  readonly closer: AsyncCloser;
  closed: boolean;
  closing: Promise<void> | null;
}

interface LeaseState {
  closer: AsyncCloser | undefined;
  settled: boolean;
  readonly settledPromise: Promise<void>;
  readonly resolveSettled: () => void;
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/**
 * Owns one test's desktop profiles, application leases, and auxiliary
 * resources.
 *
 * Teardown is one global barrier: freeze registration, wait for every launch
 * reservation to settle, close every resource in reverse registration order,
 * and only then remove profiles. If any close fails, no profile is removed.
 * Successful closes and removals are remembered so a later dispose retries
 * only the failed work.
 */
export class OwnedDesktopProfileRegistry {
  private readonly profiles = new Set<string>();
  private readonly leases = new Set<LeaseState>();
  private readonly closers: RegisteredCloserState[] = [];
  private readonly removeProfile: OwnedDesktopProfileRemover;
  private acceptingResources = true;
  private disposal: Promise<void> | null = null;

  constructor(
    removeProfile: OwnedDesktopProfileRemover = removeOwnedDesktopE2eProfile,
  ) {
    this.removeProfile = removeProfile;
  }

  private assertAcceptingResources(): void {
    if (!this.acceptingResources) {
      throw new Error('Desktop E2E resource teardown has already started');
    }
  }

  createTempDir(prefix: string): string {
    this.assertAcceptingResources();
    if (!OWNED_TEMP_PREFIX.test(prefix)) {
      throw new Error(`Refusing unsafe desktop E2E temp prefix: ${JSON.stringify(prefix)}`);
    }
    const directory = assertOwnedDesktopE2eProfile(
      mkdtempSync(path.join(tmpdir(), prefix)),
    );
    this.profiles.add(directory);
    return directory;
  }

  reserve(userDataDir: string): OwnedDesktopProfileLease {
    this.assertAcceptingResources();
    const ownedProfile = assertOwnedDesktopE2eProfile(userDataDir);
    if (!this.profiles.has(ownedProfile)) {
      throw new Error(
        `Desktop E2E profile was not created by this registry: ${ownedProfile}`,
      );
    }

    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const lease: LeaseState = {
      closer: undefined,
      settled: false,
      settledPromise,
      resolveSettled,
    };
    this.leases.add(lease);

    return {
      settle: (closer?: AsyncCloser) => {
        if (lease.settled) {
          if (closer !== undefined && closer !== lease.closer) {
            throw new Error('Desktop E2E profile lease was settled more than once');
          }
          return;
        }
        lease.closer = closer;
        lease.settled = true;
        if (closer) this.addCloser(closer);
        lease.resolveSettled();
      },
    };
  }

  /**
   * Registers a non-profile resource in the same LIFO teardown barrier.
   * The returned closer is safe to call explicitly and concurrently; a
   * successful explicit close makes fixture teardown a no-op for that item.
   */
  registerCloser(closer: AsyncCloser): AsyncCloser {
    this.assertAcceptingResources();
    return this.addCloser(closer);
  }

  disposeAll(): Promise<void> {
    this.acceptingResources = false;
    if (this.disposal) return this.disposal;

    const disposal = this.runDisposal().finally(() => {
      if (this.disposal === disposal) this.disposal = null;
    });
    this.disposal = disposal;
    return disposal;
  }

  private addCloser(closer: AsyncCloser): AsyncCloser {
    const state: RegisteredCloserState = {
      closer,
      closed: false,
      closing: null,
    };
    this.closers.push(state);
    return {
      close: () => this.closeRegistered(state),
    };
  }

  private async closeRegistered(state: RegisteredCloserState): Promise<void> {
    if (state.closed) return;
    if (state.closing) return state.closing;

    const attempt = (async () => {
      await state.closer.close();
      state.closed = true;
    })();
    state.closing = attempt;
    try {
      await attempt;
    } finally {
      if (state.closing === attempt) state.closing = null;
    }
  }

  private async runDisposal(): Promise<void> {
    // No new lease or generic resource can be registered after disposeAll()
    // freezes the registry, so this set is the complete pending-launch barrier.
    await Promise.all([...this.leases].map((lease) => lease.settledPromise));

    const closeErrors: unknown[] = [];
    for (let index = this.closers.length - 1; index >= 0; index -= 1) {
      try {
        await this.closeRegistered(this.closers[index]);
      } catch (error) {
        // Keep closing older resources. A gateway must still be stopped even
        // when a later-registered Electron application failed to close.
        closeErrors.push(error);
      }
    }

    // A rejected close does not prove that its process exited. Keep every
    // profile intact until a later retry has closed every resource.
    throwCleanupErrors(closeErrors, 'Desktop E2E resources could not all be closed');

    const removeErrors: unknown[] = [];
    await Promise.all([...this.profiles].map(async (ownedProfile) => {
      try {
        await this.removeProfile(ownedProfile);
        this.profiles.delete(ownedProfile);
      } catch (error) {
        removeErrors.push(error);
      }
    }));
    throwCleanupErrors(removeErrors, 'Desktop E2E profiles could not all be removed');
  }
}

let activeTestRegistry: OwnedDesktopProfileRegistry | null = null;

/** Activates a test-scoped registry for launchApp's public Playwright fixture. */
export function activateOwnedDesktopProfileRegistry(
  registry: OwnedDesktopProfileRegistry,
): () => void {
  if (activeTestRegistry) {
    throw new Error('A desktop E2E profile registry is already active');
  }
  activeTestRegistry = registry;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (activeTestRegistry !== registry) {
      throw new Error('Desktop E2E profile registry activation order was corrupted');
    }
    activeTestRegistry = null;
  };
}

export function currentOwnedDesktopProfileRegistry(): OwnedDesktopProfileRegistry {
  if (!activeTestRegistry) {
    throw new Error(
      'launchApp() requires the custom Playwright test fixture from e2e/test.ts',
    );
  }
  return activeTestRegistry;
}

/** Standalone owner used by Node-driven mobile E2E scripts. */
export function createOwnedDesktopProfile(
  prefix = 'ezterm-e2e-',
): OwnedDesktopProfileOwner {
  const registry = new OwnedDesktopProfileRegistry();
  const userDataDir = registry.createTempDir(prefix);
  const lease = registry.reserve(userDataDir);
  return {
    userDataDir,
    settle: lease.settle,
    dispose: () => registry.disposeAll(),
  };
}
