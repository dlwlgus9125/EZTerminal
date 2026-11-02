import { describe, expect, it, vi } from 'vitest';

import type { WebContents } from 'electron';

import { BrowserCdp, BrowserRefused, parseKeys } from './browser-cdp';

function fake() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendCommand = vi.fn<(method: string, params?: object) => Promise<unknown>>(async () => ({}));
  const contents = {
    isDestroyed: vi.fn(() => false),
    debugger: {
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); }),
      sendCommand,
    },
  };
  const requested = vi.fn();
  const classify = vi.fn((url: string) => (url.includes('evil') ? 'external' as const : 'local' as const));
  const cdp = new BrowserCdp(contents as unknown as WebContents, { onNavigationRequested: requested, classify });
  sendCommand.mockClear();
  const emit = (method: string, params: unknown) => listeners.get('message')!({}, method, params);
  return { cdp, contents, sendCommand, listeners, requested, classify, emit };
}

const AX = (nodes: readonly Record<string, unknown>[]) => ({ nodes });
const node = (nodeId: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({ nodeId, role: { value: role }, name: { value: name }, ...extra });

describe('parseKeys', () => {
  it('reads the keys the tool sends', () => {
    expect(parseKeys('Enter')).toMatchObject({ key: 'Enter', keyCode: 13, modifiers: 0, text: '\r' });
    expect(parseKeys('Control+Enter')).toMatchObject({ key: 'Enter', modifiers: 2 });
    expect(parseKeys('Control+Shift+a')).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 10 });
    expect(parseKeys('a')).toMatchObject({ key: 'a', text: 'a' });
    expect(parseKeys('Shift+a')).toMatchObject({ text: 'a' });
    expect(parseKeys('Control+a')).not.toHaveProperty('text');
    expect(parseKeys('7')).toMatchObject({ code: 'Digit7' });
    expect(parseKeys('Space')).toMatchObject({ key: ' ', text: ' ' });
  });

  it.each(['', 'F12', 'Hyper+a', 'Control+', 'ab', 'Enter+Control', '가'])('refuses %j', (keys) => {
    expect(parseKeys(keys)).toBeUndefined();
  });
});

describe('BrowserCdp', () => {
  it('attaches once, intercepts file choosers and hears navigation reasons', () => {
    const { contents, requested, emit } = fake();
    expect(contents.debugger.on).toHaveBeenCalledWith('message', expect.any(Function));
    emit('Page.frameRequestedNavigation', { url: 'http://a/', reason: 'anchorClick' });
    expect(requested).toHaveBeenCalledWith('http://a/', 'anchorClick');
  });

  it('attaches again if something detaches it, and not once closed', () => {
    const { cdp, contents, listeners } = fake();
    contents.debugger.isAttached.mockReturnValue(false);
    listeners.get('detach')!();
    expect(contents.debugger.attach).toHaveBeenCalledWith('1.3');
    contents.debugger.attach.mockClear();
    cdp.close();
    listeners.get('detach')!();
    expect(contents.debugger.attach).not.toHaveBeenCalled();
  });

  it('keeps the last 200 console lines, bounded', () => {
    const { cdp, emit } = fake();
    for (let index = 0; index < 205; index += 1) emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: `line ${String(index)}` }] });
    emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: x' } } });
    emit('Log.entryAdded', { entry: { level: 'error', text: 'x'.repeat(900), url: 'http://a/' } });
    const lines = cdp.consoleLines();
    expect(lines).toHaveLength(200);
    expect(lines.at(-2)).toBe('exception: TypeError: x');
    expect(lines.at(-1)!.length).toBeLessThan(510);
  });

  describe('snapshot', () => {
    const tree = (children: readonly unknown[] = []) => ({ frameTree: { frame: { id: 'main', url: 'http://localhost:5173/' }, childFrames: children } });

    it('writes each frame the AI may read, with refs on what can be acted on', async () => {
      const { cdp, sendCommand } = fake();
      sendCommand.mockImplementation(async (method, params) => {
        if (method === 'Page.getFrameTree') return tree();
        if (method === 'DOM.describeNode') return { node: { nodeName: 'BUTTON' } };
        expect(params).toEqual({ frameId: 'main' });
        return AX([
          node('1', 'RootWebArea', 'Shop', { childIds: ['2', '3', '4', '5'] }),
          node('2', 'heading', 'Cart', { parentId: '1', childIds: ['21'] }),
          node('21', 'StaticText', 'Cart', { parentId: '2', childIds: ['22'] }),
          node('22', 'InlineTextBox', 'Cart', { parentId: '21' }),
          node('3', 'button', 'Pay', { parentId: '1', backendDOMNodeId: 30 }),
          node('4', 'textbox', 'Coupon', { parentId: '1', backendDOMNodeId: 40, value: { value: 'SPRING' } }),
          node('5', 'button', 'Hidden', { parentId: '1', ignored: true, backendDOMNodeId: 50 }),
        ]);
      });
      const snapshot = await cdp.snapshot();
      expect(snapshot.text).toBe('heading "Cart"\n  "Cart"\nbutton "Pay" [ref=e1]\ntextbox "Coupon" value="SPRING" [ref=e2]');
      expect(snapshot.unreadFrames).toEqual([]);
      expect(await cdp.target('e1').catch((error: unknown) => error)).not.toBeInstanceOf(BrowserRefused);
    });

    it('never reads a frame whose site the AI may not read, and names it instead', async () => {
      const { cdp, sendCommand } = fake();
      const read: unknown[] = [];
      sendCommand.mockImplementation(async (method, params) => {
        if (method === 'Page.getFrameTree') return tree([{ frame: { id: 'evil', url: 'http://evil.example/ads' } }, { frame: { id: 'own', url: 'about:srcdoc' } }]);
        read.push((params as { frameId: string }).frameId);
        return AX([node('1', 'RootWebArea', '', { childIds: [] })]);
      });
      const snapshot = await cdp.snapshot();
      expect(read).toEqual(['main', 'own']);
      expect(snapshot.unreadFrames).toEqual(['http://evil.example/ads']);
    });

    it('lists a frame in another process as unread', async () => {
      const { cdp, sendCommand } = fake();
      sendCommand.mockImplementation(async (method, params) => {
        if (method === 'Page.getFrameTree') return tree([{ frame: { id: 'cross', url: 'http://other.localhost/' } }]);
        if ((params as { frameId: string }).frameId === 'cross') throw new Error('Frame with the given id does not belong to the target');
        return AX([]);
      });
      expect((await cdp.snapshot()).unreadFrames).toEqual(['http://other.localhost/']);
    });

    it('names a frame its debugger never saw: a cross-origin one has a process of its own', async () => {
      const { cdp, contents, sendCommand } = fake();
      Object.assign(contents, { mainFrame: { framesInSubtree: [{ url: 'http://localhost:5173/' }, { url: 'https://elsewhere.example/ad' }] } });
      sendCommand.mockImplementation(async (method) => (method === 'Page.getFrameTree' ? tree() : AX([])));
      expect((await cdp.snapshot()).unreadFrames).toEqual(['https://elsewhere.example/ad']);
    });

    it('caps what it returns', async () => {
      const { cdp, sendCommand } = fake();
      sendCommand.mockImplementation(async (method) => {
        if (method === 'Page.getFrameTree') return tree();
        return AX([node('1', 'RootWebArea', '', { childIds: Array.from({ length: 400 }, (_, index) => `n${String(index)}`) }),
          ...Array.from({ length: 400 }, (_, index) => node(`n${String(index)}`, 'paragraph', 'x'.repeat(100), { parentId: '1' }))]);
      });
      const snapshot = await cdp.snapshot();
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.text.length).toBeLessThan(16_100);
    });
  });

  describe('refs', () => {
    const withButton = async () => {
      const handle = fake();
      handle.sendCommand.mockImplementation(async (method) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: 'http://localhost:5173/' } } };
        if (method === 'Accessibility.getFullAXTree') return AX([node('1', 'button', 'Pay', { backendDOMNodeId: 30 })]);
        if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 30 };
        return {};
      });
      await handle.cdp.snapshot();
      return handle;
    };

    it('clicks the middle of the element, once the page shows it there', async () => {
      const { cdp, sendCommand } = await withButton();
      await cdp.click('e1');
      const mouse = sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params);
      expect(mouse).toEqual([
        { type: 'mouseMoved', x: 20, y: 20 },
        { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 },
        { type: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1 },
      ]);
    });

    it('refuses a click something else now covers', async () => {
      const { cdp, sendCommand } = await withButton();
      sendCommand.mockImplementation(async (method, params) => {
        if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 99 };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        if (method === 'DOM.resolveNode') return { object: { objectId: `object-${String((params as { backendNodeId: number }).backendNodeId)}` } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: false } };
        return {};
      });
      await expect(cdp.click('e1')).rejects.toMatchObject({ reason: 'stale-ref' });
      expect(sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('takes a hit on the element\'s own child as a hit on it', async () => {
      const { cdp, sendCommand } = await withButton();
      sendCommand.mockImplementation(async (method) => {
        if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 31 };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'object' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
        return {};
      });
      await cdp.click('e1');
      expect(sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent')).toHaveLength(3);
    });

    it('ends every ref at a navigation', async () => {
      const { cdp } = await withButton();
      cdp.clearRefs();
      await expect(cdp.click('e1')).rejects.toMatchObject({ reason: 'stale-ref' });
    });

    it('ends the old refs at the next snapshot', async () => {
      const { cdp } = await withButton();
      await cdp.snapshot();
      await expect(cdp.click('e1')).rejects.toMatchObject({ reason: 'stale-ref' });
      await expect(cdp.click('e2')).resolves.toBeUndefined();
    });

    it('refuses a ref it never gave', async () => {
      const { cdp } = await withButton();
      await expect(cdp.type('e77', 'x')).rejects.toMatchObject({ reason: 'stale-ref' });
    });

    it('tells a password field from the host\'s own reading', async () => {
      const { cdp, sendCommand } = await withButton();
      sendCommand.mockImplementation(async () => ({ node: { nodeName: 'INPUT', attributes: ['id', 'pw', 'type', 'password'] } }));
      expect(await cdp.target('e1')).toMatchObject({ password: true, role: 'button', name: 'Pay' });
      sendCommand.mockImplementation(async () => ({ node: { nodeName: 'INPUT', attributes: ['type', 'text', 'data-note', 'password'] } }));
      expect(await cdp.target('e1')).toMatchObject({ password: false });
    });

    it('calls a node the page removed a stale ref', async () => {
      const { cdp, sendCommand } = await withButton();
      sendCommand.mockImplementation(async () => { throw new Error('No node with given id found'); });
      await expect(cdp.target('e1')).rejects.toMatchObject({ reason: 'stale-ref' });
    });
  });

  it('reports a gone page rather than hanging', async () => {
    const { cdp, contents } = fake();
    contents.debugger.isAttached.mockReturnValue(false);
    await expect(cdp.snapshot()).rejects.toMatchObject({ reason: 'page-gone' });
    contents.isDestroyed.mockReturnValue(true);
    await expect(cdp.snapshot()).rejects.toMatchObject({ reason: 'page-gone' });
  });

  it('says when a click opened a file chooser', async () => {
    const { cdp, emit } = fake();
    expect(cdp.fileChooserOpened()).toBe(false);
    emit('Page.fileChooserOpened', { mode: 'selectSingle' });
    expect(cdp.fileChooserOpened()).toBe(true);
  });
});
