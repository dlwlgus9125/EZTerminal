// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const electron = vi.hoisted(() => ({
  on: vi.fn(), removeListener: vi.fn(),
  getVersion: vi.fn(() => '1.0.53'),
  getGPUFeatureStatus: vi.fn(() => ({ gpu_compositing: 'enabled' })),
}));
vi.mock('electron', () => ({ app: electron }));
import { installWindowRenderDiagnostics } from './window-render-diagnostics';

function harness() {
  const execute = vi.fn<(source: string) => Promise<unknown>>().mockResolvedValue({ root: { opacity: '1' } });
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getOSProcessId: () => 42, executeJavaScript: execute,
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false, isVisible: () => true,
    isMinimized: () => false, isFocused: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
  });
  const write = vi.fn();
  installWindowRenderDiagnostics(window as unknown as BrowserWindow, write);
  const records = () => write.mock.calls.map(([line]) => JSON.parse(String(line).replace('[render-diagnostics] ', '')));
  return { window, contents, execute, write, records };
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('window render diagnostics', () => {
  it('leaves ordinary builds untouched and allows opting out of a diagnostic build', () => {
    vi.stubEnv('EZTERMINAL_RENDER_DIAGNOSTICS_DEFAULT', '1');
    vi.stubEnv('EZTERMINAL_RENDER_DIAGNOSTICS', '0');
    const h = harness();
    expect(h.contents.listenerCount('before-input-event')).toBe(0);
    expect(electron.on).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('uses the installer default and marks an incident without consuming ordinary input', async () => {
    vi.stubEnv('EZTERMINAL_RENDER_DIAGNOSTICS', undefined);
    vi.stubEnv('EZTERMINAL_RENDER_DIAGNOSTICS_DEFAULT', '1');
    const h = harness();
    const event = { preventDefault: vi.fn() };
    h.contents.emit('before-input-event', event, { type: 'keyDown', control: true, shift: false, key: 'c' });
    expect(event.preventDefault).not.toHaveBeenCalled();
    h.contents.emit('before-input-event', event, { type: 'keyDown', control: true, shift: true, key: 'F12' });
    await settle();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(h.records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'enabled', version: '1.0.53' }),
      expect.objectContaining({ reason: 'user-black-screen-marker', phase: 'native' }),
      expect.objectContaining({ reason: 'user-black-screen-marker', phase: 'renderer' }),
    ]));
    h.window.emit('closed');
  });

  it('keeps a hung renderer probe bounded, records timeout, and resumes after it settles', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EZTERMINAL_RENDER_DIAGNOSTICS', '1');
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.execute.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.window.emit('focus');
    h.window.emit('minimize');
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    h.window.emit('restore');
    await settle();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.records()).toContainEqual(expect.objectContaining({ phase: 'renderer-probe-timeout' }));
    resolve({ root: null });
    await settle();
    h.window.emit('focus');
    await settle();
    expect(h.execute).toHaveBeenCalledTimes(2);
    h.window.emit('closed');
  });

  it('survives a synchronous renderer failure and removes its app listener when the window closes', async () => {
    vi.stubEnv('EZTERMINAL_RENDER_DIAGNOSTICS', '1');
    const h = harness();
    h.execute.mockImplementationOnce(() => { throw new Error('destroyed'); });
    h.window.emit('focus');
    await settle();
    expect(h.records()).toContainEqual(expect.objectContaining({ phase: 'renderer-probe-failed' }));
    h.window.emit('closed');
    expect(electron.removeListener).toHaveBeenCalledWith('child-process-gone', expect.any(Function));
    const count = h.write.mock.calls.length;
    h.window.emit('focus');
    await settle();
    expect(h.write).toHaveBeenCalledTimes(count);
  });

  it('the actual renderer probe omits terminal text and input values', async () => {
    vi.stubEnv('EZTERMINAL_RENDER_DIAGNOSTICS', '1');
    document.body.innerHTML = '<div id="root"><div data-presentation-mode="live" data-xterm-renderer="webgl">PRIVATE-TERMINAL-TEXT</div><input value="PRIVATE-COMMAND"></div>';
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [] });
    const h = harness();
    h.execute.mockImplementation(async (source) => Function(`return ${source}`)());
    h.window.emit('restore');
    await settle();
    const record = h.records().find((item) => item.phase === 'renderer');
    expect(record.state).toMatchObject({ liveTerminals: 1, webglTerminals: 1, root: { children: 2 } });
    expect(JSON.stringify(h.records())).not.toMatch(/PRIVATE-TERMINAL-TEXT|PRIVATE-COMMAND/);
    h.window.emit('closed');
  });
});
