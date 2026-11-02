import { describe, expect, it, vi } from 'vitest';

import type { WebContents } from 'electron';

import { BrowserCdp, BrowserRefused, parseKeys } from './browser-cdp';

interface CapturedNode {
  readonly id: number;
  readonly parent?: number;
  readonly name?: string;
  readonly opacity?: string;
  readonly fontSize?: string;
  readonly bounds?: readonly number[];
  /** No layout box. */
  readonly boxless?: true;
  readonly text?: true;
  /** The document this frame element holds. */
  readonly content?: number;
}

/** `DOMSnapshot.captureSnapshot` as Chromium shapes it: strings are shared and indexed, and frames hang off `contentDocumentIndex`. */
function domCapture(documents: readonly { readonly frameId: string; readonly nodes: readonly CapturedNode[] }[]) {
  const strings: string[] = [];
  const at = (value: string): number => {
    if (!strings.includes(value)) strings.push(value);
    return strings.indexOf(value);
  };
  return {
    strings,
    documents: documents.map(({ frameId, nodes }) => {
      const boxed = nodes.flatMap((entry, index) => (entry.boxless ? [] : [{ entry, index }]));
      const owners = nodes.flatMap((entry, index) => (entry.content === undefined ? [] : [{ index, value: entry.content }]));
      return {
        frameId: at(frameId),
        nodes: {
          backendNodeId: nodes.map((entry) => entry.id), parentIndex: nodes.map((entry) => entry.parent ?? -1), nodeName: nodes.map((entry) => at(entry.name ?? 'DIV')),
          nodeType: nodes.map((entry) => (entry.text ? 3 : 1)), contentDocumentIndex: { index: owners.map((owner) => owner.index), value: owners.map((owner) => owner.value) },
        },
        layout: {
          nodeIndex: boxed.map(({ index }) => index),
          styles: boxed.map(({ entry }) => [at(entry.opacity ?? '1'), at(entry.fontSize ?? '16px'), at('visible')]),
          bounds: boxed.map(({ entry }) => entry.bounds ?? [10, 10, 100, 20]),
        },
      };
    }),
  };
}

/** Every node a test names, shown, in the frames it reads. */
const EVERYTHING_SHOWN = domCapture(['main', 'own'].map((frameId, document) => ({ frameId, nodes: Array.from({ length: 1_000 }, (_, index) => ({ id: index + 1 + document * 1_000 })) })));

function fake() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendCommand = vi.fn<(method: string, params?: object) => Promise<unknown>>(async () => ({}));
  const capture = vi.fn<() => unknown>(() => EVERYTHING_SHOWN);
  const contents = {
    isDestroyed: vi.fn(() => false),
    debugger: {
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); }),
      sendCommand: async (method: string, params?: object): Promise<unknown> => (method === 'DOMSnapshot.captureSnapshot' ? capture() : sendCommand(method, params)),
    },
  };
  const requested = vi.fn();
  const classify = vi.fn((url: string) => (url.includes('evil') ? 'external' as const : 'local' as const));
  const cdp = new BrowserCdp(contents as unknown as WebContents, { onNavigationRequested: requested, classify });
  sendCommand.mockClear();
  const emit = (method: string, params: unknown) => listeners.get('message')!({}, method, params);
  return { cdp, contents, sendCommand, capture, listeners, requested, classify, emit };
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
          node('2', 'heading', 'Cart', { parentId: '1', childIds: ['21'], backendDOMNodeId: 20 }),
          node('21', 'StaticText', 'Cart', { parentId: '2', childIds: ['22'], backendDOMNodeId: 21 }),
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
        if (method === 'Accessibility.getFullAXTree') read.push((params as { frameId: string }).frameId);
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
          ...Array.from({ length: 400 }, (_, index) => node(`n${String(index)}`, 'paragraph', 'x'.repeat(100), { parentId: '1', backendDOMNodeId: index + 1 }))]);
      });
      const snapshot = await cdp.snapshot();
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.text.length).toBeLessThan(16_100);
    });

    describe('what a person cannot see stays out, and the filter never fails open', () => {
      const page = (handle: ReturnType<typeof fake>, nodes: readonly Record<string, unknown>[], children: readonly unknown[] = []): void => {
        handle.sendCommand.mockImplementation(async (method) => (method === 'Page.getFrameTree' ? tree(children) : AX([node('root', 'RootWebArea', '', { childIds: nodes.map((entry) => entry.nodeId), backendDOMNodeId: 1 }), ...nodes])));
      };
      const reads = (handle: ReturnType<typeof fake>): number => handle.sendCommand.mock.calls.filter(([method]) => method === 'Accessibility.getFullAXTree').length;

      it('refuses the read when the page could not be checked: a filter that failed is no filter', async () => {
        const handle = fake();
        page(handle, [node('p', 'paragraph', 'WORDS', { backendDOMNodeId: 2 })]);
        handle.capture.mockImplementation(() => { throw new Error('DOMSnapshot failed'); });
        const refused = await handle.cdp.snapshot().catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(BrowserRefused);
        expect((refused as BrowserRefused).reason).toBe('page-gone');
        expect(reads(handle)).toBe(0);
      });

      it('shows nothing the capture does not name, and has no refs for it', async () => {
        const handle = fake();
        page(handle, [node('b', 'button', 'GHOST', { backendDOMNodeId: 7 })]);
        handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }] }]));
        const snapshot = await handle.cdp.snapshot();
        expect(snapshot.text).toBe('');
        expect(await handle.cdp.target('e1').catch((error: unknown) => (error as BrowserRefused).reason)).toBe('stale-ref');
      });

      it('shows nothing with no id at all, and does not re-read for it', async () => {
        const handle = fake();
        page(handle, [node('b', 'paragraph', 'NO-ID')]);
        expect((await handle.cdp.snapshot()).text).toBe('');
        expect(handle.capture).toHaveBeenCalledTimes(1);
      });

      it('captures again when the read and the capture disagree, once', async () => {
        const handle = fake();
        page(handle, [node('b', 'button', 'Pay', { backendDOMNodeId: 7 })]);
        handle.capture.mockReturnValueOnce(domCapture([{ frameId: 'main', nodes: [{ id: 1 }] }])).mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }, { id: 7 }] }]));
        const snapshot = await handle.cdp.snapshot();
        expect(snapshot.text).toMatch(/^button "Pay" \[ref=e\d+\]$/u);
        expect(handle.capture).toHaveBeenCalledTimes(2);
        expect(reads(handle)).toBe(2);
      });

      it('stops at one more: what still disagrees stays out', async () => {
        const handle = fake();
        page(handle, [node('b', 'button', 'Pay', { backendDOMNodeId: 7 })]);
        handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }] }]));
        expect((await handle.cdp.snapshot()).text).toBe('');
        expect(handle.capture).toHaveBeenCalledTimes(2);
      });

      it.each<[string, CapturedNode]>([
        ['transparent', { id: 7, opacity: '0' }], ['off to the left', { id: 7, bounds: [-9999, 10, 100, 20] }], ['off the top', { id: 7, bounds: [10, -9999, 100, 20] }],
        ['of no size', { id: 7, bounds: [10, 10, 0, 0] }], ['with no box', { id: 7, boxless: true }], ['text of no size', { id: 7, text: true, fontSize: '0px' }],
      ])('leaves out a node %s', async (_name, entry) => {
        const handle = fake();
        page(handle, [node('p', 'paragraph', 'HIDDEN-WORDS', { backendDOMNodeId: 7 })]);
        handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }, entry] }]));
        expect((await handle.cdp.snapshot()).text).not.toContain('HIDDEN-WORDS');
      });

      it('takes transparency down a subtree, and not a box\'s font size', async () => {
        const handle = fake();
        page(handle, [node('p', 'paragraph', 'UNDER-GLASS', { backendDOMNodeId: 8 }), node('q', 'paragraph', 'RESTORED', { backendDOMNodeId: 10 })]);
        handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }, { id: 7, parent: 0, opacity: '0' }, { id: 8, parent: 1 }, { id: 9, parent: 0, fontSize: '0px' }, { id: 10, parent: 3 }] }]));
        const { text } = await handle.cdp.snapshot();
        expect(text).not.toContain('UNDER-GLASS');
        expect(text).toContain('RESTORED');
      });

      it('gives an option in a closed select the fate of its select: it has no box of its own', async () => {
        const handle = fake();
        const options = [node('o1', 'option', 'SHOWN-SIZE', { backendDOMNodeId: 3 }), node('o2', 'option', 'HIDDEN-SIZE', { backendDOMNodeId: 5 })];
        page(handle, options);
        handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [
          { id: 1 }, { id: 2, parent: 0, name: 'SELECT' }, { id: 3, parent: 1, name: 'OPTION', boxless: true },
          { id: 4, parent: 0, name: 'SELECT', opacity: '0' }, { id: 5, parent: 3, name: 'OPTION', boxless: true },
        ] }]));
        const { text } = await handle.cdp.snapshot();
        expect(text).toContain('SHOWN-SIZE');
        expect(text).not.toContain('HIDDEN-SIZE');
      });

      describe('a frame', () => {
        const FRAME = { frame: { id: 'own', url: 'about:srcdoc' } };
        const read = (handle: ReturnType<typeof fake>): readonly unknown[] => handle.sendCommand.mock.calls.filter(([method]) => method === 'Accessibility.getFullAXTree').map(([, params]) => (params as { frameId: string }).frameId);

        it.each<[string, CapturedNode]>([
          ['transparent', { id: 2, opacity: '0', content: 1 }], ['off the page', { id: 2, bounds: [-9999, 0, 300, 150], content: 1 }],
          ['of no size', { id: 2, bounds: [10, 10, 0, 0], content: 1 }], ['with no box', { id: 2, boxless: true, content: 1 }],
        ])('is not read when its element is %s, and is named instead', async (_name, owner) => {
          const handle = fake();
          page(handle, [], [FRAME]);
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }, owner] }, { frameId: 'own', nodes: [{ id: 3 }] }]));
          const snapshot = await handle.cdp.snapshot();
          expect(read(handle)).toEqual(['main']);
          expect(snapshot.unreadFrames).toEqual(['about:srcdoc']);
        });

        it('carries that down: a frame inside a hidden frame is hidden, whatever its own element says', async () => {
          const handle = fake();
          page(handle, [], [{ ...FRAME, childFrames: [{ frame: { id: 'deep', url: 'about:srcdoc' } }] }]);
          handle.capture.mockReturnValue(domCapture([
            { frameId: 'main', nodes: [{ id: 1, opacity: '0' }, { id: 2, parent: 0, content: 1 }] },
            { frameId: 'own', nodes: [{ id: 3 }, { id: 4, parent: 0, content: 2 }] },
            { frameId: 'deep', nodes: [{ id: 5 }] },
          ]));
          const snapshot = await handle.cdp.snapshot();
          expect(read(handle)).toEqual(['main']);
          expect(snapshot.unreadFrames).toHaveLength(2);
        });

        it('is read when its element is on show', async () => {
          const handle = fake();
          page(handle, [], [FRAME]);
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }, { id: 2, parent: 0, content: 1 }] }, { frameId: 'own', nodes: [{ id: 3 }] }]));
          expect(read(handle)).toEqual([]);
          await handle.cdp.snapshot();
          expect(read(handle)).toEqual(['main', 'own']);
        });

        it('is not read when the capture does not hold its document', async () => {
          const handle = fake();
          page(handle, [], [FRAME]);
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }] }]));
          expect((await handle.cdp.snapshot()).unreadFrames).toEqual(['about:srcdoc']);
        });
      });

      describe('a name that comes from an element\'s content', () => {
        const hiding: readonly CapturedNode[] = [{ id: 1 }, { id: 2, parent: 0 }, { id: 3, parent: 1, text: true, fontSize: '0px' }, { id: 4, parent: 1, text: true }];
        const named = (role: string, name: string): readonly Record<string, unknown>[] => [
          node('b', role, name, { backendDOMNodeId: 2, childIds: ['t1', 't2'] }),
          node('t1', 'StaticText', 'HIDDEN-WORDS', { parentId: 'b', backendDOMNodeId: 3 }),
          node('t2', 'StaticText', 'Buy now', { parentId: 'b', backendDOMNodeId: 4 }),
        ];

        it.each(['button', 'link', 'heading', 'tab', 'menuitem'])('a %s keeps only the words a person sees', async (role) => {
          const handle = fake();
          page(handle, named(role, 'HIDDEN-WORDS Buy now'));
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: hiding }]));
          const { text } = await handle.cdp.snapshot();
          expect(text).not.toContain('HIDDEN-WORDS');
          expect(text).toContain(`${role} "Buy now"`);
        });

        it('drops the name when no words are left', async () => {
          const handle = fake();
          page(handle, [node('b', 'link', 'HIDDEN-WORDS', { backendDOMNodeId: 2, childIds: ['t1'] }), node('t1', 'StaticText', 'HIDDEN-WORDS', { parentId: 'b', backendDOMNodeId: 3 })]);
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: hiding }]));
          expect((await handle.cdp.snapshot()).text).toMatch(/^link \[ref=e\d+\]$/u);
        });

        it('drops words kept in anything hidden under it, an image\'s alt too', async () => {
          const handle = fake();
          page(handle, [node('b', 'button', 'HIDDEN-ALT', { backendDOMNodeId: 2, childIds: ['i'] }), node('i', 'image', 'HIDDEN-ALT', { parentId: 'b', backendDOMNodeId: 3 })]);
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: [{ id: 1 }, { id: 2, parent: 0 }, { id: 3, parent: 1, opacity: '0' }] }]));
          expect((await handle.cdp.snapshot()).text).toMatch(/^button \[ref=e\d+\]$/u);
        });

        it('keeps a name nothing hidden went into, an aria-label too', async () => {
          const handle = fake();
          page(handle, [node('b', 'button', 'Close the cart', { backendDOMNodeId: 2, childIds: ['t2'] }), node('t2', 'StaticText', 'x', { parentId: 'b', backendDOMNodeId: 4 })]);
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: hiding }]));
          expect((await handle.cdp.snapshot()).text).toContain('button "Close the cart"');
        });

        it('hands the rebuilt name to what approves a click', async () => {
          const handle = fake();
          page(handle, named('button', 'HIDDEN-WORDS Buy now'));
          handle.capture.mockReturnValue(domCapture([{ frameId: 'main', nodes: hiding }]));
          await handle.cdp.snapshot();
          const reading = handle.sendCommand.getMockImplementation()!;
          handle.sendCommand.mockImplementation(async (method, params) => (method === 'DOM.describeNode' ? { node: { nodeName: 'BUTTON' } } : reading(method, params)));
          expect((await handle.cdp.target('e1')).name).toBe('Buy now');
        });
      });
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
