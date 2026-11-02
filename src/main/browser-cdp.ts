import type { NativeImage, WebContents } from 'electron';

import { BROWSER_THUMB_BYTES, type BrowserRefusal, type BrowserSiteClass } from '../shared/browser';
import { MAX_CHAT_ATTACHMENT_BYTES } from '../shared/chat-message';

/**
 * What the AI's tools do to a page, over the view's own debugger. Screenshots are `capturePage`: `Page.captureScreenshot`
 * stalled on a hidden view when measured. Page words pass through here as data: the caller quotes them.
 */

/** A debugger that does not answer means the page is gone, not that the tool should hang. */
const COMMAND_TIMEOUT_MS = 8_000;
const SNAPSHOT_LIMIT = 16_000;
const CONSOLE_LINES = 200;
const CONSOLE_LINE_CHARS = 500;
const SHOT_WIDTH = 1_280;
const SHOT_QUALITY = 80;
const THUMB_WIDTH = 360;
const THUMB_QUALITIES = [60, 40, 25];
const ELEMENT_QUALITIES = [80, 60, 40];
const PICK_HIGHLIGHT = { showInfo: false, contentColor: { r: 111, g: 168, b: 220, a: 0.35 }, borderColor: { r: 111, g: 168, b: 220, a: 0.9 } };
/** A short path to a node, nearest id first. It runs in a world of its own, and all it reads is the page's. */
const ELEMENT_FACTS = `function(){
  const parts=[];
  for(let el=this.nodeType===1?this:this.parentElement;el&&parts.length<5;el=el.parentElement){
    if(el.id){parts.unshift('#'+CSS.escape(el.id));break}
    const same=el.parentElement?[...el.parentElement.children].filter((other)=>other.localName===el.localName):[];
    parts.unshift(el.localName+[...el.classList].slice(0,2).map((name)=>'.'+CSS.escape(name)).join('')+(same.length>1?':nth-of-type('+(same.indexOf(el)+1)+')':''));
  }
  return {selector:parts.join(' > '),url:this.ownerDocument.location.href};
}`;

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'slider', 'spinbutton', 'listbox', 'treeitem',
]);
/** What only structures the page, or repeats its parent's words. */
const SILENT_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'presentation', 'Iframe', 'IframePresentational']);
/** Roles whose name comes from what is inside them, so hidden words inside become their name. */
const NAME_FROM_CONTENT_ROLES = new Set([
  'button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'checkbox', 'switch', 'treeitem',
  'cell', 'gridcell', 'columnheader', 'rowheader', 'row', 'tooltip',
]);

/** A refusal in the tools' own words. */
export class BrowserRefused extends Error {
  constructor(readonly reason: BrowserRefusal, message?: string, readonly detail?: Readonly<Record<string, unknown>>) {
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
interface FrameTree { readonly frame: { readonly id: string; readonly url: string; readonly loaderId?: string }; readonly childFrames?: readonly FrameTree[] }

/** Where the keyboard is: a same-origin frame or an open shadow root hands focus on, and a frame it cannot enter answers for what is inside. */
const DEEPEST_FOCUS = `(()=>{
  let at=document.activeElement;
  for(;;){
    let inner=null;
    try{inner=at&&(at.shadowRoot?at.shadowRoot.activeElement:at.contentDocument&&at.contentDocument.activeElement)}catch{}
    if(!inner)return at;
    at=inner;
  }
})()`;

const CAPTURED_STYLES = ['opacity', 'font-size', 'visibility'];
const TEXT_NODE = 3;

/** The parts of `DOMSnapshot.captureSnapshot` read here. `styles` holds indexes into `strings`, in the order of `CAPTURED_STYLES`. */
interface DomDocument {
  readonly frameId: number;
  readonly nodes: {
    readonly parentIndex?: readonly number[];
    readonly backendNodeId?: readonly number[];
    readonly nodeName?: readonly number[];
    readonly nodeType?: readonly number[];
    /** Which of `nodes` hold which of `documents`. */
    readonly contentDocumentIndex?: { readonly index: readonly number[]; readonly value: readonly number[] };
  };
  readonly layout: { readonly nodeIndex: readonly number[]; readonly styles: readonly (readonly number[])[]; readonly bounds: readonly (readonly number[])[] };
}
interface DomCapture { readonly strings: readonly string[]; readonly documents: readonly DomDocument[] }

/** What a capture says a person can see. Whatever it does not name is not shown: that is the rule, and it cannot fail open. */
interface PageVisibility {
  /** Backend node ids positively on show. */
  readonly shown: ReadonlySet<number>;
  /** Every id the capture holds, on show or not: an id outside it means the page moved between the two reads. */
  readonly known: ReadonlySet<number>;
  readonly frames: ReadonlySet<string>;
}

/** Which nodes of one document a person could see, were the document itself on show. */
function shownInDocument({ nodes, layout }: DomDocument, strings: readonly string[]): (node: number) => boolean {
  const parents = nodes.parentIndex ?? [];
  const transparent = new Set<number>();
  const onShow = new Set<number>();
  layout.nodeIndex.forEach((node, at) => {
    const [opacity, fontSize, visibility] = (layout.styles[at] ?? []).map((style) => strings[style] ?? '');
    const [x = 0, y = 0, width = 0, height = 0] = layout.bounds[at] ?? [];
    if (Number.parseFloat(opacity ?? '') === 0) transparent.add(node);
    // `font-size` hides words and no box: a button in a whitespace-trick wrapper is on show.
    const wordless = nodes.nodeType?.[node] === TEXT_NODE && Number.parseFloat(fontSize ?? '') === 0;
    if (!wordless && visibility === 'visible' && width > 0 && height > 0 && x + width > 0 && y + height > 0) onShow.add(node);
  });
  const ancestors = function* (node: number): Generator<number> {
    for (let at = node; at >= 0; at = parents[at] ?? -1) yield at;
  };
  const tag = (node: number): string | undefined => strings[nodes.nodeName?.[node] ?? -1];
  return (node) => {
    // An option in a closed select has no box of its own: it is as seen as its select.
    const box = [...ancestors(node)].find((at) => tag(at) === 'SELECT') ?? node;
    return onShow.has(box) && ![...ancestors(box)].some((at) => transparent.has(at));
  };
}

function pageVisibility({ strings, documents }: DomCapture): PageVisibility {
  const owners = new Map<number, { readonly document: number; readonly node: number }>();
  documents.forEach(({ nodes }, document) => {
    const { index = [], value = [] } = nodes.contentDocumentIndex ?? {};
    index.forEach((node, at) => { if (value[at] !== undefined) owners.set(value[at], { document, node }); });
  });
  const shownIn = documents.map((document) => shownInDocument(document, strings));
  // Opacity and position do not cross a frame's edge, so what hides a frame element is carried down by hand.
  const documentOnShow = (document: number): boolean => {
    const owner = owners.get(document);
    return !owner || (documentOnShow(owner.document) && shownIn[owner.document]!(owner.node));
  };
  const shown = new Set<number>();
  const known = new Set<number>();
  const frames = new Set<string>();
  documents.forEach(({ frameId, nodes }, document) => {
    const onShow = documentOnShow(document);
    if (onShow && strings[frameId] !== undefined) frames.add(strings[frameId]);
    nodes.backendNodeId?.forEach((id, node) => {
      known.add(id);
      if (onShow && shownIn[document]!(node)) shown.add(id);
    });
  });
  return { shown, known, frames };
}

/** One read of the page: its words, its refs, and whether the two reads behind it saw the same page. */
interface PageRead {
  readonly lines: string[];
  readonly refs: Map<string, Ref>;
  readonly unreadFrames: string[];
  disagreed: boolean;
}

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

/** What an element is, read by the host. */
export interface BrowserElementReading {
  readonly url: string;
  readonly selector: string;
  readonly role: string;
  readonly name: string;
  readonly imageBase64?: string;
}

export interface BrowserCdpOptions {
  /** A frame asked to navigate, and why: read before `will-navigate`, which cannot tell a link from a script. */
  readonly onNavigationRequested: (url: string, reason: string) => void;
  /** The class of a frame's URL for this conversation. */
  readonly classify: (url: string) => BrowserSiteClass;
  /** A person pressed an element while picking. The page never heard it (measured). */
  readonly onElementPressed?: (backendNodeId: number) => void;
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
      case 'Overlay.inspectNodeRequested':
        if (typeof params.backendNodeId === 'number') this.options.onElementPressed?.(params.backendNodeId);
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

  /** The accessibility tree of each frame on show that the AI may read; refs from any earlier snapshot end here. */
  async snapshot(): Promise<BrowserSnapshot> {
    const first = await this.readPage();
    // A page that moved between the two reads gets one more look. What still disagrees stays out.
    const { lines, refs, unreadFrames } = first.disagreed ? await this.readPage() : first;
    this.refs = refs;
    const joined = lines.join('\n');
    return { text: joined.length > SNAPSHOT_LIMIT ? `${joined.slice(0, SNAPSHOT_LIMIT)}\n…` : joined, truncated: joined.length > SNAPSHOT_LIMIT, unreadFrames };
  }

  private async readPage(): Promise<PageRead> {
    const { frameTree } = await this.send<{ frameTree: FrameTree }>('Page.getFrameTree');
    const visibility = await this.visibility();
    const read: PageRead = { lines: [], refs: new Map(), unreadFrames: [], disagreed: false };
    const walk = async (tree: FrameTree, creator: string, depth: number): Promise<void> => {
      const url = tree.frame.url;
      const blank = /^about:/iu.test(url);
      const site = this.options.classify(blank ? creator : url);
      if (depth > 0) read.lines.push(`${'  '.repeat(depth - 1)}frame ${quoted(url)}`);
      if (site === 'external' || !visibility.frames.has(tree.frame.id)) {
        read.unreadFrames.push(url);
      } else {
        const axTree = await this.send<{ nodes: readonly AxNode[] }>('Accessibility.getFullAXTree', { frameId: tree.frame.id }).catch((error: unknown) => {
          if (error instanceof BrowserRefused) throw error;
          return undefined; // Another process: a cross-origin frame answers with nothing.
        });
        if (axTree) this.appendTree(axTree.nodes, tree.frame.id, depth, read, visibility);
        else read.unreadFrames.push(url);
      }
      for (const child of tree.childFrames ?? []) await walk(child, blank ? creator : url, depth + 1);
    };
    await walk(frameTree, frameTree.frame.url, 0);
    // A cross-origin frame runs in another process: this debugger's tree does not hold it, and it is named here instead.
    const inTree = (tree: FrameTree): readonly string[] => [tree.frame.url, ...(tree.childFrames ?? []).flatMap(inTree)];
    const walked = new Set(inTree(frameTree));
    for (const frame of this.contents.mainFrame?.framesInSubtree ?? []) if (!walked.has(frame.url)) read.unreadFrames.push(frame.url);
    return read;
  }

  /**
   * What a person can see. The accessibility tree reads more than that (measured): transparent text, text of no size, text off
   * the page, whole frames behind any of those. This covers what a page hides, not all it could: white on white stays, and
   * nothing here claims to detect anything. A capture that fails refuses the read: the words would go out unfiltered, unsaid.
   */
  private async visibility(): Promise<PageVisibility> {
    const capture = await this.send<DomCapture>('DOMSnapshot.captureSnapshot', { computedStyles: CAPTURED_STYLES }).catch((error: unknown) => {
      if (error instanceof BrowserRefused) throw error;
      throw new BrowserRefused('page-gone', 'The page could not be checked for hidden text, so it was not read.');
    });
    return pageVisibility(capture);
  }

  /** The words of the main frame, for a wait. It ends no refs. */
  async pageText(): Promise<string> {
    const { nodes } = await this.send<{ nodes: readonly AxNode[] }>('Accessibility.getFullAXTree');
    return nodes.filter((node) => !node.ignored).map((node) => text(node.name)).join('\n');
  }

  private appendTree(nodes: readonly AxNode[], frameId: string, frameDepth: number, read: PageRead, visibility: PageVisibility): void {
    const { lines, refs } = read;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const onShow = (node: AxNode): boolean => node.backendDOMNodeId !== undefined && visibility.shown.has(node.backendDOMNodeId);
    /** Only what a person sees of a name made from content. No part hidden, the page's own name stands: it may be an `aria-label`. */
    const nameOf = (node: AxNode, role: string): string => {
      const name = text(node.name);
      if (!NAME_FROM_CONTENT_ROLES.has(role)) return name;
      const words: string[] = [];
      let hidden = false;
      const collect = (entry: AxNode): void => {
        for (const child of (entry.childIds ?? []).flatMap((id) => byId.get(id) ?? [])) {
          const said = text(child.name);
          if (said && !child.ignored && !onShow(child)) hidden = true;
          else if (said && text(child.role) === 'StaticText') words.push(said);
          if (text(child.role) !== 'StaticText') collect(child);
        }
      };
      collect(node);
      return hidden ? words.join(' ') : name;
    };
    const visit = (node: AxNode, depth: number): void => {
      const role = text(node.role);
      const name = nameOf(node, role);
      const value = text(node.value);
      const worthShowing = !node.ignored && !SILENT_ROLES.has(role) && (name !== '' || value !== '' || INTERACTIVE_ROLES.has(role));
      if (worthShowing && node.backendDOMNodeId !== undefined && !visibility.known.has(node.backendDOMNodeId)) read.disagreed = true;
      const shown = worthShowing && onShow(node);
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

  /** An element's role and name now: a page can rename a button under a ref, so a snapshot's words answer for nothing here. */
  private async liveElement(backendNodeId: number): Promise<{ readonly role: string; readonly name: string }> {
    const { nodes } = await this.send<{ nodes: readonly AxNode[] }>('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }).catch((error: unknown) => {
      if (error instanceof BrowserRefused) throw error;
      throw new BrowserRefused('stale-ref');
    });
    const node = nodes.find((entry) => entry.backendDOMNodeId === backendNodeId) ?? nodes[0];
    return { role: text(node?.role), name: text(node?.name) };
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
    return { ...await this.liveElement(ref.backendNodeId), password: described.node.nodeName?.toLowerCase() === 'input' && attributes.includes('type') && type === 'password' };
  }

  /** The element the keyboard is on, read in a world the page cannot reach. */
  private async focus(frameId: string): Promise<string> {
    const { executionContextId } = await this.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: 'ezterminal-browser', grantUniveralAccess: false });
    const { result } = await this.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: DEEPEST_FOCUS, contextId: executionContextId });
    if (!result.objectId) return '';
    const { node } = await this.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: result.objectId });
    const { role, name } = await this.liveElement(node.backendNodeId);
    return `${String(node.backendNodeId)}:${role}:${name}`;
  }

  /**
   * What an approval was given for, read live: which document this is, in the main frame and the element's, where the keyboard
   * is, and what the element is. Two equal readings mean the page did not move under the person; any difference voids the answer.
   */
  async binding(id?: string): Promise<string> {
    const { frameTree } = await this.send<{ frameTree: FrameTree }>('Page.getFrameTree');
    const frames = (tree: FrameTree): readonly FrameTree[] => [tree, ...(tree.childFrames ?? []).flatMap(frames)];
    const ref = id === undefined ? undefined : this.ref(id);
    const frame = ref ? frames(frameTree).find((entry) => entry.frame.id === ref.frameId)?.frame : undefined;
    if (ref && !frame) throw new BrowserRefused('stale-ref');
    return JSON.stringify({
      page: [frameTree.frame.id, frameTree.frame.loaderId],
      frame: frame ? [frame.id, frame.loaderId] : null,
      element: ref ? { node: ref.backendNodeId, ...await this.target(id!) } : null,
      focus: await this.focus(frameTree.frame.id),
    });
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

  async startPick(): Promise<void> {
    await this.send('DOM.enable');
    await this.send('Overlay.enable');
    await this.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: PICK_HIGHLIGHT });
  }

  async stopPick(): Promise<void> {
    await this.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    await this.send('Overlay.hideHighlight');
  }

  /** The frame a node sits in is whichever gives it a world. */
  private async elementFacts(backendNodeId: number): Promise<{ readonly selector: string; readonly url: string } | undefined> {
    const { frameTree } = await this.send<{ frameTree: FrameTree }>('Page.getFrameTree');
    const frames = (tree: FrameTree): readonly FrameTree[] => [tree, ...(tree.childFrames ?? []).flatMap(frames)];
    for (const { frame } of frames(frameTree)) {
      const facts = await this.inIsolatedWorld<{ selector: string; url: string }>({ backendNodeId, frameId: frame.id, role: '', name: '' }, ELEMENT_FACTS).catch((error: unknown) => {
        if (error instanceof BrowserRefused) throw error;
        return undefined;
      });
      if (facts) return facts;
    }
    return undefined;
  }

  /** The element a person pressed. Undefined when it went before it could be read. */
  async element(backendNodeId: number): Promise<BrowserElementReading | undefined> {
    const facts = await this.elementFacts(backendNodeId);
    if (!facts) return undefined;
    const { nodes } = await this.send<{ nodes: readonly AxNode[] }>('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    const image = await this.capture(await this.boxOf(backendNodeId));
    const jpeg = ELEMENT_QUALITIES.map((quality) => image.toJPEG(quality)).find((bytes) => bytes.length <= MAX_CHAT_ATTACHMENT_BYTES);
    return { ...facts, role: text(nodes[0]?.role), name: text(nodes[0]?.name), ...(jpeg ? { imageBase64: jpeg.toString('base64') } : {}) };
  }

  private async boxOf(backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const { model } = await this.send<{ model: { readonly border: readonly number[]; readonly width: number; readonly height: number } }>('DOM.getBoxModel', { backendNodeId })
      .catch((error: unknown) => {
        if (error instanceof BrowserRefused) throw error;
        throw new BrowserRefused('stale-ref');
      });
    return { x: Math.floor(model.border[0]!), y: Math.floor(model.border[1]!), width: Math.ceil(model.width), height: Math.ceil(model.height) };
  }

  /** At most `SHOT_WIDTH` wide, in CSS pixels: `capturePage` answers in physical ones. */
  private async capture(rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImage> {
    const captured: NativeImage = rect ? await this.contents.capturePage(rect) : await this.contents.capturePage();
    if (captured.isEmpty()) throw new BrowserRefused('page-gone');
    const cssWidth = rect?.width ?? (await this.send<{ cssLayoutViewport: { clientWidth: number } }>('Page.getLayoutMetrics')).cssLayoutViewport.clientWidth;
    const width = Math.min(SHOT_WIDTH, cssWidth);
    return captured.getSize().width === width ? captured : captured.resize({ width, quality: 'good' });
  }

  async screenshot(id?: string): Promise<{ readonly jpegBase64: string; readonly thumbBase64?: string; readonly width: number; readonly height: number }> {
    const image = await this.capture(id === undefined ? undefined : await this.boxOf(this.ref(id).backendNodeId));
    const size = image.getSize();
    const thumb = image.resize({ width: Math.min(THUMB_WIDTH, size.width), quality: 'good' });
    const thumbJpeg = THUMB_QUALITIES.map((quality) => thumb.toJPEG(quality)).find((jpeg) => jpeg.length <= BROWSER_THUMB_BYTES);
    return { jpegBase64: image.toJPEG(SHOT_QUALITY).toString('base64'), ...(thumbJpeg ? { thumbBase64: thumbJpeg.toString('base64') } : {}), width: size.width, height: size.height };
  }
}
