import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  activateOwnedDesktopProfileRegistry,
  createOwnedDesktopProfile,
  currentOwnedDesktopProfileRegistry,
  OwnedDesktopProfileRegistry,
  trackElectronApplicationClose,
} from '../e2e/owned-desktop-profile.ts';
import {
  buildFixtureState,
  startFakeGateway,
  writeFixtureFiles,
  type FakeGatewayHandle,
} from '../e2e/fixtures/openclaw-fixtures.ts';
import { launchApp } from '../e2e/launch-app.ts';

const createdDirectories: string[] = [];

function createUnregisteredDirectory(prefix = 'ezterm-e2e-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  createdDirectories.push(directory);
  writeFileSync(path.join(directory, 'sentinel.txt'), 'unregistered', 'utf8');
  return directory;
}

function createOwnedDirectory(
  registry: OwnedDesktopProfileRegistry,
  prefix = 'ezterm-e2e-',
): string {
  const directory = registry.createTempDir(prefix);
  createdDirectories.push(directory);
  writeFileSync(path.join(directory, 'sentinel.txt'), 'owned', 'utf8');
  return directory;
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 })
  )));
});

describe('desktop E2E resource ownership', () => {
  it('loads in standalone Node without TypeScript transformation', () => {
    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dirname, '..', 'e2e', 'owned-desktop-profile.ts'),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('returns one concurrent disposal promise and closes each resource once', async () => {
    const registry = new OwnedDesktopProfileRegistry();
    const profile = createOwnedDirectory(registry);
    const lease = registry.reserve(profile);
    let closeCount = 0;
    lease.settle({
      close: async () => {
        closeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });

    const first = registry.disposeAll();
    const concurrent = registry.disposeAll();
    expect(concurrent).toBe(first);
    await Promise.all([first, concurrent]);
    await registry.disposeAll();

    expect(closeCount).toBe(1);
    expect(existsSync(profile)).toBe(false);
  });

  it('freezes creation, reservation, and generic registration during disposal', async () => {
    const registry = new OwnedDesktopProfileRegistry();
    const profile = createOwnedDirectory(registry);
    const lease = registry.reserve(profile);

    const disposal = registry.disposeAll();
    expect(() => registry.createTempDir('ezterm-too-late-'))
      .toThrow(/teardown has already started/u);
    expect(() => registry.reserve(profile)).toThrow(/teardown has already started/u);
    expect(() => registry.registerCloser({ close: async () => {} }))
      .toThrow(/teardown has already started/u);

    lease.settle();
    await disposal;
    expect(existsSync(profile)).toBe(false);
  });

  it('closes every resource globally before removing any profile', async () => {
    const events: string[] = [];
    let closeCount = 0;
    const registry = new OwnedDesktopProfileRegistry(async (directory) => {
      expect(closeCount).toBe(2);
      events.push(`remove:${path.basename(directory)}`);
      await rm(directory, { recursive: true, force: true });
    });
    const first = createOwnedDirectory(registry, 'ezterm-first-e2e-');
    const second = createOwnedDirectory(registry, 'ezterm-second-e2e-');
    for (const [profile, label] of [[first, 'first'], [second, 'second']] as const) {
      const lease = registry.reserve(profile);
      lease.settle({
        close: async () => {
          closeCount += 1;
          events.push(`close:${label}`);
        },
      });
    }

    await registry.disposeAll();

    expect(events.slice(0, 2)).toEqual(['close:second', 'close:first']);
    expect(events.slice(2)).toHaveLength(2);
    expect(events.slice(2).every((event) => event.startsWith('remove:'))).toBe(true);
  });

  it('tries every closer but removes no profile after any close failure, then retries', async () => {
    const removeCalls: string[] = [];
    const registry = new OwnedDesktopProfileRegistry(async (directory) => {
      removeCalls.push(directory);
      await rm(directory, { recursive: true, force: true });
    });
    const first = createOwnedDirectory(registry, 'ezterm-close-first-e2e-');
    const second = createOwnedDirectory(registry, 'ezterm-close-second-e2e-');
    let stableCloseCount = 0;
    let retryingCloseCount = 0;
    const stableLease = registry.reserve(first);
    stableLease.settle({
      close: async () => {
        stableCloseCount += 1;
      },
    });
    const retryingLease = registry.reserve(second);
    const closeError = new Error('close failed');
    retryingLease.settle({
      close: async () => {
        retryingCloseCount += 1;
        if (retryingCloseCount === 1) throw closeError;
      },
    });

    await expect(registry.disposeAll()).rejects.toBe(closeError);
    expect(stableCloseCount).toBe(1);
    expect(retryingCloseCount).toBe(1);
    expect(removeCalls).toEqual([]);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);

    await registry.disposeAll();
    expect(stableCloseCount).toBe(1);
    expect(retryingCloseCount).toBe(2);
    expect(removeCalls).toHaveLength(2);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it('retries a transient remove failure without closing resources twice', async () => {
    let removeCount = 0;
    const removeError = new Error('profile busy');
    const registry = new OwnedDesktopProfileRegistry(async (directory) => {
      removeCount += 1;
      if (removeCount === 1) throw removeError;
      await rm(directory, { recursive: true, force: true });
    });
    const profile = createOwnedDirectory(registry);
    let closeCount = 0;
    const lease = registry.reserve(profile);
    lease.settle({
      close: async () => {
        closeCount += 1;
      },
    });

    await expect(registry.disposeAll()).rejects.toBe(removeError);
    expect(existsSync(profile)).toBe(true);
    await registry.disposeAll();

    expect(closeCount).toBe(1);
    expect(removeCount).toBe(2);
    expect(existsSync(profile)).toBe(false);
  });

  it('waits for a pending launch lease before closing and removing', async () => {
    const events: string[] = [];
    const registry = new OwnedDesktopProfileRegistry(async (directory) => {
      events.push('remove');
      await rm(directory, { recursive: true, force: true });
    });
    const profile = createOwnedDirectory(registry);
    registry.registerCloser({
      close: async () => {
        events.push('resource');
      },
    });
    const lease = registry.reserve(profile);
    let cleanupFinished = false;
    const cleanup = registry.disposeAll().then(() => {
      cleanupFinished = true;
    });

    await Promise.resolve();
    expect(cleanupFinished).toBe(false);
    expect(existsSync(profile)).toBe(true);

    lease.settle({
      close: async () => {
        events.push('late-app');
      },
    });
    await cleanup;
    expect(events).toEqual(['late-app', 'resource', 'remove']);
    expect(existsSync(profile)).toBe(false);
  });

  it('closes app and generic resources in reverse registration order before remove', async () => {
    const events: string[] = [];
    const registry = new OwnedDesktopProfileRegistry(async (directory) => {
      events.push('remove');
      await rm(directory, { recursive: true, force: true });
    });
    const profile = createOwnedDirectory(registry);
    registry.registerCloser({ close: async () => { events.push('resource-a'); } });
    registry.registerCloser({ close: async () => { events.push('resource-b'); } });
    const lease = registry.reserve(profile);
    lease.settle({ close: async () => { events.push('app'); } });

    await registry.disposeAll();

    expect(events).toEqual(['app', 'resource-b', 'resource-a', 'remove']);
  });

  it('makes an explicitly used generic closer concurrent and repeat-safe', async () => {
    const registry = new OwnedDesktopProfileRegistry();
    let closeCount = 0;
    const closer = registry.registerCloser({
      close: async () => {
        closeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });

    await Promise.all([closer.close(), closer.close()]);
    await closer.close();
    await registry.disposeAll();

    expect(closeCount).toBe(1);
  });

  it('does not re-close an Electron process that exited before disposal', async () => {
    let closeCalls = 0;
    let closeListenerRegistrations = 0;
    const app = {
      process: () => ({ exitCode: 0, signalCode: null }),
      once: () => {
        closeListenerRegistrations += 1;
      },
      close: async () => {
        closeCalls += 1;
      },
    } as unknown as Parameters<typeof trackElectronApplicationClose>[0];

    const closer = trackElectronApplicationClose(app);
    await closer.close();

    expect(closeCalls).toBe(0);
    expect(closeListenerRegistrations).toBe(0);
  });

  it('accepts a confirmed close event when Playwright close rejects late', async () => {
    let exitCode: number | null = null;
    let closeListener: (() => void) | undefined;
    let closeCalls = 0;
    const app = {
      process: () => ({ exitCode, signalCode: null }),
      once: (_event: 'close', listener: () => void) => {
        closeListener = listener;
      },
      close: async () => {
        closeCalls += 1;
        exitCode = 0;
        closeListener?.();
        throw new Error('transport closed after process exit');
      },
    } as unknown as Parameters<typeof trackElectronApplicationClose>[0];

    const closer = trackElectronApplicationClose(app);
    const first = closer.close();
    const concurrent = closer.close();
    expect(concurrent).toBe(first);
    await expect(first).resolves.toBeUndefined();
    await closer.close();

    expect(closeCalls).toBe(1);
  });

  it('rejects a matching TEMP path that this registry did not create', async () => {
    const unregistered = createUnregisteredDirectory('ezterm-e2e-');
    const registry = new OwnedDesktopProfileRegistry();

    expect(() => registry.reserve(unregistered))
      .toThrow(/not created by this registry/u);

    await registry.disposeAll();
    expect(existsSync(unregistered)).toBe(true);
  });

  it('owns only exact direct-child TEMP directories in an ezterm mkdtemp namespace', async () => {
    const registry = new OwnedDesktopProfileRegistry();
    const fixture = createOwnedDirectory(registry, 'ezterm-e2e-files-');

    expect(path.dirname(fixture)).toBe(path.resolve(tmpdir()));
    expect(existsSync(fixture)).toBe(true);
    expect(() => registry.reserve(path.join(tmpdir(), 'not-an-owned-profile')))
      .toThrow(/unowned desktop E2E profile/u);
    expect(() => registry.reserve(path.join(tmpdir(), 'ezterm-e2e-static-name')))
      .toThrow(/unowned desktop E2E profile/u);
    expect(() => registry.reserve(path.join(fixture, 'ezterm-e2e-ABC123')))
      .toThrow(/unowned desktop E2E profile/u);
    expect(() => registry.createTempDir('../ezterm-e2e-'))
      .toThrow(/unsafe desktop E2E temp prefix/u);

    await registry.disposeAll();
    expect(existsSync(fixture)).toBe(false);
  });

  it('creates a provenance-safe standalone owner for mobile E2E', async () => {
    const owner = createOwnedDesktopProfile();
    createdDirectories.push(owner.userDataDir);
    let closeCount = 0;
    const closer = {
      close: async () => {
        closeCount += 1;
        expect(existsSync(owner.userDataDir)).toBe(true);
      },
    };
    owner.settle(closer);
    owner.settle(closer);

    await owner.dispose();

    expect(closeCount).toBe(1);
    expect(existsSync(owner.userDataDir)).toBe(false);
  });

  it('auto-closes a fake gateway when launch fails before Electron starts', async () => {
    const registry = new OwnedDesktopProfileRegistry();
    const deactivate = activateOwnedDesktopProfileRegistry(registry);
    let gateway: FakeGatewayHandle | undefined;
    try {
      const { statePath } = writeFixtureFiles(buildFixtureState());
      gateway = await startFakeGateway(statePath);
      const gatewayExit = new Promise<void>((resolve) => {
        gateway?.proc.once('exit', () => resolve());
      });
      const unregistered = createUnregisteredDirectory('ezterm-e2e-');

      await expect(launchApp(unregistered)).rejects.toThrow(/not created by this registry/u);
      await registry.disposeAll();
      await gatewayExit;

      expect(gateway.proc.exitCode !== null || gateway.proc.signalCode !== null).toBe(true);
    } finally {
      try {
        await gateway?.stop();
        await registry.disposeAll();
      } finally {
        deactivate();
      }
    }
  });

  it('exposes exactly one active registry to the public Playwright fixture', () => {
    const registry = new OwnedDesktopProfileRegistry();
    const deactivate = activateOwnedDesktopProfileRegistry(registry);
    try {
      expect(currentOwnedDesktopProfileRegistry()).toBe(registry);
      expect(() => activateOwnedDesktopProfileRegistry(new OwnedDesktopProfileRegistry()))
        .toThrow(/already active/u);
    } finally {
      deactivate();
    }

    deactivate();
    expect(() => currentOwnedDesktopProfileRegistry()).toThrow(/custom Playwright test fixture/u);
  });

  it('requires every root spec to use the custom auto-cleanup test fixture', () => {
    const e2eDirectory = path.resolve(import.meta.dirname, '..', 'e2e');
    const specs = readdirSync(e2eDirectory)
      .filter((filename) => filename.endsWith('.spec.ts'));

    expect(specs.length).toBeGreaterThan(0);
    for (const filename of specs) {
      const source = readFileSync(path.join(e2eDirectory, filename), 'utf8');
      expect(source, filename).toContain("from './test'");
      expect(source, filename).not.toContain("from '@playwright/test'");
    }
  });

  it('reserves the performance profile before Electron launch settles', () => {
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        '..',
        'e2e',
        'release-performance.spec.ts',
      ),
      'utf8',
    );
    const launchStart = source.indexOf('async function launchPerformanceApp');
    const launchEnd = source.indexOf(
      'async function launchArtifactEvidence',
      launchStart,
    );
    const implementation = launchStart >= 0 && launchEnd > launchStart
      ? source.slice(launchStart, launchEnd)
      : '';

    expect(implementation.indexOf('registry.reserve(userDataDir)')).toBeGreaterThan(-1);
    expect(implementation.indexOf('registry.reserve(userDataDir)'))
      .toBeLessThan(implementation.indexOf('electron.launch'));
    expect(implementation.match(/lease\.settle\(/g)).toHaveLength(2);
  });
});
