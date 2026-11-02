import type { NativeImage, WebContents } from 'electron';

import type { BrowserRefusal, BrowserSiteClass } from '../shared/browser';

/**
 * What the AI's tools do to a page, over the view's own debugger. Screenshots are `capturePage`: `Page.captureScreenshot`
 * stalled on a hidden view when measured. Page words pass through here as data: the caller quotes them (step 11).
 */

/** A debugger that does not answer means the page is gone, not that the tool should hang. */
const COMMAND_TIMEOUT_MS = 8_000;
const SNAPSHOT_LIMIT = 16_000;
const CONSOLE_LINES = 200;
const CONSOLE_LINE_CHARS = 500;
const SHOT_WIDTH = 1_280;
const SHOT_QUALITY = 80;

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'slider', 'spinbutton', 'listbox', 'treeitem',
]);
/** What only structures the page, or repeats its parent's words. */
const SILENT_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'presentation', 'Iframe', 'IframePresentational']);

/** A refusal in the tools' own words. */
export class BrowserRefused extends Error {
  constructor(readonly reason: BrowserRefusal, message?: string) {
    super(message ?? reason);
    this.name = 'BrowserRefused';
  }
}

interface AxValue { readonly value?: unknown }
interface AxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AxValue;
  readonly name?: AxValue;
  readonly value?: AxValue;
  readonly backendDOMNodeId?: number;
  readonly childIds?: readonly string[];
  readonly parentId?: string;
}
interface FrameTree { readonly frame: { readonly id: string; readonly url: string }; readonly childFrames?: readonly FrameTree[] }

interface Ref {
  readonly backendNodeId: number;
  readonly frameId: string;
  readonly role: string;
  readonly name: string;
}

export interface BrowserTarget {
  readonly role: string;
  /** The name the page gives it: page text. */
  readonly name: string;
  readonly password: boolean;
}

export interface BrowserSnapshot {
  readonly text: string;
  readonly truncated: boolean;
  /** Frames the host did not read, by URL: their site is not one the AI may read, or they are in another process. */
  readonly unreadFrames: readonly string[];
}

const KEYS: Readonly<Record<string, { readonly code: string; readonly keyCode: number; readonly text?: string }>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
};
const MODIFIERS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export interface BrowserKeyStroke {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly modifiers: number;
  readonly text?: string;
}

/** `Control+Enter`, `a`, `ArrowDown`. Undefined when it names no key the tool sends. */
export function parseKeys(keys: string): BrowserKeyStroke | undefined {
  const parts = keys.split('+').map((part) => part.trim());
  const name = parts.pop();
  if (!name) return undefined;
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined) return undefined;
    modifiers |= bit;
  }
  const special = KEYS[name];
  if (special) return { key: name === 'Space' ? ' ' : name, code: special.code, keyCode: special.keyCode, modifiers, ...(special.text ? { text: special.text } : {}) };
  if (!/^[a-zA-Z0-9]$/u.test(name)) return undefined;
  const upper = name.toUpperCase();
  const printable = (modifiers & ~MODIFIERS.Shift!) === 0;
  return { key: name, code: /\d/u.test(name) ? `Digit${name}` : `Key${upper}`, keyCode: upper.charCodeAt(0), modifiers, ...(printable ? { text: name } : {}) };
}

function text(value: AxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value.trim() : '';
}

function quoted(value: string): string {
  return JSON.stringify(value.length > 300 ? `${value.slice(0, 300)}…` : value);
}

export interface BrowserCdpOptions {
  /** A frame asked to navigate, and why: read before `will-navigate`, which cannot tell a link from a script. */
  readonly onNavigationRequested: (url: string, reason: string) => void;
  /** The class of a frame's URL for this conversation. */
  readonly classify: (url: string) => BrowserSiteClass;
}

export class BrowserCdp {
  private refs = new Map<string, Ref>();
  private nextRef = 1;
  private readonly consoleBuffer: string[] = [];
  private chooserOpened = false;
  private closed = false;

  constructor(private readonly contents: WebContents, private readonly options: BrowserCdpOptions) {
    const dbg = contents.debugger;
    dbg.on('message', (_event, method, params: Record<string, unknown>) => this.message(method, params));
    dbg.on('detach', () => { if (!this.closed && !contents.isDestroyed()) this.attach(); });
    this.attach();
  }

  close(): void {
    this.closed = true;
  }

  /** A navigation ended every ref. */
  clearRefs(): void {
    this.refs.clear();
  }

  private attach(): void {
    const dbg = this.contents.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch {
      return; // Nothing attached: a link then reads like a script, and the tools report a gone page.
    }
    for (const [method, params] of [['Page.enable', {}], ['Page.setInterceptFileChooserDialog', { enabled: true }], ['DOM.enable', {}], ['Accessibility.enable', {}], ['Runtime.enable', {}], ['Log.enable', {}]] as const) {
      void dbg.sendCommand(method, params).catch(() => undefined);
    }
  }

  private message(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Page.frameRequestedNavigation':
        if (typeof params.url === 'string' && typeof params.reason === 'string') this.options.onNavigationRequested(params.url, params.reason);
        return;
      case 'Page.fileChooserOpened':
        this.chooserOpened = true;
        return;
      case 'Runtime.consoleAPICalled': {
        const args = (params.args as readonly { readonly value?: unknown; readonly description?: string }[] | undefined) ?? [];
        this.log(`${String(params.type)}: ${args.map((arg) => (arg.value === undefined ? arg.description ?? '' : String(arg.value))).join(' ')}`);
        return;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as { readonly text?: string; readonly exception?: { readonly description?: string } } | undefined;
        this.log(`exception: ${details?.exception?.description ?? details?.text ?? 'unknown'}`);
        return;
      }
      case 'Log.entryAdded': {
        const entry = params.entry as { readonly level?: string; readonly text?: string; readonly url?: string } | undefined;
        if (entry?.text) this.log(`${entry.level ?? 'log'}: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
        return;
      }
      default:
    }
  }

  private log(line: string): void {
    this.consoleBuffer.push(line.length > CONSOLE_LINE_CHARS ? `${line.slice(0, CONSOLE_LINE_CHARS)}…` : line);
    if (this.consoleBuffer.length > CONSOLE_LINES) this.consoleBuffer.shift();
  }

  consoleLines(): readonly string[] {
    return [...this.consoleBuffer];
  }

  private async send<T>(method: string, params: object = {}): Promise<T> {
    if (this.contents.isDestroyed() || !this.contents.debugger.isAttached()) throw new BrowserRefused('page-gone');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.contents.debugger.sendCommand(method, params) as Promise<T>,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserRefused('page-gone', `${method} did not answer`)), COMMAND_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The accessibility tree of each frame the AI may read; refs from any earlier snapshot end here. */
  async snapshot(): Promise<BrowserSnapshot> {
    const { frameTree } = await this.send<{ frameTree: FrameTree }>('Page.getFrameTree');
    const refs = new Map<string, Ref>();
    const unreadFrames: string[] = [];
    const lines: string[] = [];
    const walk = async (tree: FrameTree, creator: string, depth: number): Promise<void> => {
      const url = tree.frame.url;
      const blank = /^about:/iu.test(url);
      const site = this.options.classify(blank ? creator : url);
      if (depth > 0) lines.push(`${'  '.repeat(depth - 1)}frame ${quoted(url)}`);
      if (site === 'external') {
        unreadFrames.push(url);
      } else {
        const read = await this.send<{ nodes: readonly AxNode[] }>('Accessibility.getFullAXTree', { frameId: tree.frame.id }).catch((error: unknown) => {
          if (error instanceof BrowserRefused) throw error;
          return undefined; // Another process: a cross-origin frame answers with nothing.
        });
        if (read) this.appendTree(read.nodes, tree.frame.id, depth, lines, refs);
        else unreadFrames.push(url);
      }
      for (const child of tree.childFrames ?? []) await walk(child, blank ? creator : url, depth + 1);
    };
    await walk(frameTree, frameTree.frame.url, 0);
    // A cross-origin frame runs in another process: this debugger's tree does not hold it, and it is named here instead.
    const inTree = (tree: FrameTree): readonly string[] => [tree.frame.url, ...(tree.childFrames ?? []).flatMap(inTree)];
    const walked = new Set(inTree(frameTree));
    for (const frame of this.contents.mainFrame?.framesInSubtree ?? []) if (!walked.has(frame.url)) unreadFrames.push(frame.url);
    this.refs = refs;
    const joined = lines.join('\n');
    return { text: joined.length > SNAPSHOT_LIMIT ? `${joined.slice(0, SNAPSHOT_LIMIT)}\n…` : joined, truncated: joined.length > SNAPSHOT_LIMIT, unreadFrames };
  }

  private appendTree(nodes: readonly AxNode[], frameId: string, frameDepth: number, lines: string[], refs: Map<string, Ref>): void {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const visit = (node: AxNode, depth: number): void => {
      const role = text(node.role);
      const name = text(node.name);
      const value = text(node.value);
      const shown = !node.ignored && !SILENT_ROLES.has(role) && (name !== '' || value !== '' || INTERACTIVE_ROLES.has(role));
      if (shown) {
        const indent = '  '.repeat(depth + frameDepth);
        if (role === 'StaticText') {
          lines.push(`${indent}${quoted(name)}`);
        } else {
          let ref = '';
          if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined) {
            const id = `e${String(this.nextRef)}`;
            this.nextRef += 1;
            refs.set(id, { backendNodeId: node.backendDOMNodeId, frameId, role, name });
            ref = ` [ref=${id}]`;
          }
          lines.push(`${indent}${role}${name ? ` ${quoted(name)}` : ''}${value ? ` value=${quoted(value)}` : ''}${ref}`);
        }
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) visit(child, depth + (shown ? 1 : 0));
      }
    };
    const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0];
    if (root) visit(root, 0);
  }

  private ref(id: string): Ref {
    const ref = this.refs.get(id);
    if (!ref) throw new BrowserRefused('stale-ref');
    return ref;
  }

  /** What a ref points at now, from the host's own reading; a node the page removed is a stale ref. */
  async target(id: string): Promise<BrowserTarget> {
    const ref = this.ref(id);
    const described = await this.send<{ node: { readonly nodeName?: string; readonly attributes?: readonly string[] } }>('DOM.describeNode', { backendNodeId: ref.backendNodeId })
      .catch((error: unknown) => {
        if (error instanceof BrowserRefused) throw error;
        throw new BrowserRefused('stale-ref');
      });
    const attributes = described.node.attributes ?? [];
    const type = attributes[attributes.indexOf('type') + 1]?.toLowerCase();
    return { role: ref.role, name: ref.name, password: described.node.nodeName?.toLowerCase() === 'input' && attributes.includes('type') && type === 'password' };
  }

  /** Runs in a world the page cannot reach: a page's own `contains` or `focus` is not asked. */
  private async inIsolatedWorld<T>(ref: Ref, declaration: string, other?: number): Promise<T> {
    const { executionContextId } = await this.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: ref.frameId, worldName: 'ezterminal-browser', grantUniveralAccess: false });
    const object = async (backendNodeId: number): Promise<string> => {
      const { object: resolved } = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId, executionContextId });
      return resolved.objectId;
    };
    const objectId = await object(ref.backendNodeId);
    const { result } = await this.send<{ result: { value?: T } }>('Runtime.callFunctionOn', {
      objectId, functionDeclaration: declaration, returnByValue: true,
      ...(other === undefined ? {} : { arguments: [{ objectId: await object(other) }] }),
    });
    return result.value as T;
  }

  /** The point to click, once the page shows this very element there: an overlay a page slid in would take the click. */
  private async clickPoint(id: string): Promise<{ readonly x: number; readonly y: number }> {
    const ref = this.ref(id);
    try {
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendNodeId });
      const { quads } = await this.send<{ quads: readonly (readonly number[])[] }>('DOM.getContentQuads', { backendNodeId: ref.backendNodeId });
      const quad = quads[0];
      if (!quad) throw new BrowserRefused('stale-ref');
      const point = { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
      const { backendNodeId: hit } = await this.send<{ backendNodeId: number }>('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false });
      const own = hit === ref.backendNodeId || await this.inIsolatedWorld<boolean>(ref, 'function(hit){return this.contains(hit)}', hit);
      if (!own) throw new BrowserRefused('stale-ref', 'Something else covers that element now.');
      return point;
    } catch (error) {
      if (error instanceof BrowserRefused) throw error;
      throw new BrowserRefused('stale-ref');
    }
  }

  async click(id: string): Promise<void> {
    const { x, y } = await this.clickPoint(id);
    this.chooserOpened = false;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** A click opened a file chooser. Nothing opened: the tools say so. */
  fileChooserOpened(): boolean {
    return this.chooserOpened;
  }

  /** Replaces what the field holds. A parked page has no focus of its own, so it is lent one. */
  async type(id: string, value: string): Promise<void> {
    const ref = this.ref(id);
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      await this.inIsolatedWorld(ref, 'function(){this.focus();if(this.select)this.select();else if(this.isContentEditable){const s=this.ownerDocument.getSelection();const r=this.ownerDocument.createRange();r.selectNodeContents(this);s.removeAllRanges();s.addRange(r)}}');
    } catch (error) {
      if (error instanceof BrowserRefused) throw error;
      throw new BrowserRefused('stale-ref');
    }
    await this.send('Input.insertText', { text: value });
  }

  async press(stroke: BrowserKeyStroke): Promise<void> {
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const common = { key: stroke.key, code: stroke.code, windowsVirtualKeyCode: stroke.keyCode, nativeVirtualKeyCode: stroke.keyCode, modifiers: stroke.modifiers };
    await this.send('Input.dispatchKeyEvent', { type: stroke.text ? 'keyDown' : 'rawKeyDown', ...common, ...(stroke.text ? { text: stroke.text, unmodifiedText: stroke.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  /** At most `SHOT_WIDTH` wide, in CSS pixels: `capturePage` answers in physical ones. */
  async screenshot(id?: string): Promise<{ readonly jpegBase64: string; readonly width: number; readonly height: number }> {
    let rect: { x: number; y: number; width: number; height: number } | undefined;
    if (id !== undefined) {
      const ref = this.ref(id);
      const { model } = await this.send<{ model: { readonly border: readonly number[]; readonly width: number; readonly height: number } }>('DOM.getBoxModel', { backendNodeId: ref.backendNodeId })
        .catch((error: unknown) => {
          if (error instanceof BrowserRefused) throw error;
          throw new BrowserRefused('stale-ref');
        });
      rect = { x: Math.floor(model.border[0]!), y: Math.floor(model.border[1]!), width: Math.ceil(model.width), height: Math.ceil(model.height) };
    }
    const captured: NativeImage = rect ? await this.contents.capturePage(rect) : await this.contents.capturePage();
    if (captured.isEmpty()) throw new BrowserRefused('page-gone');
    const cssWidth = rect?.width ?? (await this.send<{ cssLayoutViewport: { clientWidth: number } }>('Page.getLayoutMetrics')).cssLayoutViewport.clientWidth;
    const physical = captured.getSize();
    const width = Math.min(SHOT_WIDTH, cssWidth);
    const image = physical.width === width ? captured : captured.resize({ width, quality: 'good' });
    const size = image.getSize();
    return { jpegBase64: image.toJPEG(SHOT_QUALITY).toString('base64'), width: size.width, height: size.height };
  }
}
