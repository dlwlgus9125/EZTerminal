import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const device = vi.hoisted(() => ({ output: '', fail: false, calls: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn((_command: string, args: string[]) => {
    device.calls.push(args);
    if (args.includes('devices')) return { status: 0, stdout: 'List of devices attached\nemulator-5558\tdevice\n', stderr: '' };
    return { status: device.fail ? 1 : 0, stdout: device.output, stderr: device.fail ? 'fixture unavailable' : '' };
  }),
}));

import { APP_ID, getAndroidAppMemorySnapshot } from '../mobile/e2e/lib.ts';

beforeEach(() => {
  vi.stubEnv('ANDROID_SERIAL', 'emulator-5558');
  device.output = '';
  device.fail = false;
  device.calls = [];
});

afterEach(() => vi.unstubAllEnvs());

describe('Android app memory sampling', () => {
  it('reads system accounting without the app callback that forces Java GC', () => {
    device.output = 'App Summary\n Java Heap: 14,296\n Native Heap: 20,032\n TOTAL PSS: 120,255 TOTAL RSS: 237104\n';
    expect(getAndroidAppMemorySnapshot()).toEqual({
      pssSource: 'dumpsys meminfo --local', totalPssKb: 120255,
      javaHeapKb: 14296, nativeHeapKb: 20032, rawMeminfo: device.output,
    });
    expect(device.calls.filter(args => args.includes('meminfo'))).toEqual([
      ['-s', 'emulator-5558', 'shell', 'dumpsys', 'meminfo', '--local', APP_ID],
    ]);
  });

  it('supports a TOTAL table row when the optional summary categories are absent', () => {
    device.output = ' Pss Private Private\n Total Dirty Clean\n TOTAL 12,345 6789 1024\n';
    expect(getAndroidAppMemorySnapshot()).toMatchObject({
      totalPssKb: 12345, javaHeapKb: null, nativeHeapKb: null,
    });
  });

  it('rejects missing PSS and failed adb queries instead of fabricating a zero measurement', () => {
    device.output = 'No process found';
    expect(() => getAndroidAppMemorySnapshot()).toThrow('did not expose app TOTAL PSS');
    device.fail = true;
    expect(() => getAndroidAppMemorySnapshot()).toThrow('fixture unavailable');
  });
});
