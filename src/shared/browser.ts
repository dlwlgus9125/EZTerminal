import { parseApprovalRequest, type ApprovalRequest } from './approval-request';
import type { ChatAttachment } from './chat-message';
import { quotedData } from './quoted-data';
import { SUGGEST_TASK_SERVER } from './turn-wrap-up';

/**
 * The in-app browser's contract: the site policy every layer applies, the tools the AI gets, and the words the screens
 * share. Pure, so the host, the screens and the tests read one rule.
 */

export const BROWSER_CAPABILITY = 'in-app-browser-v1';

/** One profile for every project: separate from the app and from OpenClaw, and nothing is ever imported into it. */
export const BROWSER_PARTITION = 'persist:ezterminal-browser';

/** The principal of the one turn the host sends to check a change on screen. */
export const BROWSER_CHECK_PRINCIPAL = 'browser-check-runtime';

export function isBrowserCheckPrincipal(principal: { readonly kind: string; readonly id: string; readonly sessionId?: string }): boolean {
  return principal.kind === 'cli' && principal.id === BROWSER_CHECK_PRINCIPAL && principal.sessionId === undefined;
}

/** What the app sends for the automatic check: shown as sent, in the words the AI gets. */
export const BROWSER_CHECK_PROMPT = 'Open the page you just changed in the in-app browser, take a screenshot, and report only what you saw.';

export const BROWSER_READ_TOOLS = ['browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_wait'] as const;
export const BROWSER_ACTION_TOOLS = ['browser_navigate', 'browser_click', 'browser_type', 'browser_press'] as const;
export const BROWSER_TOOLS = [...BROWSER_READ_TOOLS, ...BROWSER_ACTION_TOOLS] as const;
export type BrowserToolName = (typeof BROWSER_TOOLS)[number];

export function isBrowserTool(name: string): name is BrowserToolName {
  return (BROWSER_TOOLS as readonly string[]).includes(name);
}

/** The exact names Claude's `allowedTools` needs: this server's, and never another's `browser_click`. */
export const BROWSER_CLAUDE_TOOLS: readonly string[] = BROWSER_TOOLS.map((name) => `mcp__${SUGGEST_TASK_SERVER}__${name}`);

/** This app's browser tool under either AI's name, and never another server's `browser_click`. */
export function hostBrowserTool(name: string, server?: string): BrowserToolName | undefined {
  const prefix = `mcp__${SUGGEST_TASK_SERVER}__`;
  const bare = name.startsWith(prefix) ? name.slice(prefix.length) : server === SUGGEST_TASK_SERVER ? name : undefined;
  return bare !== undefined && isBrowserTool(bare) ? bare : undefined;
}

/** What stands in a row for a value typed into a page. */
export const BROWSER_MASK = '••••••••';

/** 24 KB of JPEG, in base64: the most of a screenshot a row carries to a phone. */
export const BROWSER_THUMB_BYTES = 24_000;
export const BROWSER_THUMB_CHARS = Math.ceil(BROWSER_THUMB_BYTES / 3) * 4;

/**
 * A tool's input as a transcript row may hold it. A row is written when the AI asks, before the host can know the field is a
 * password, and rows reach phones and last, so what `browser_type` types is in none of them. A shape it cannot read goes whole.
 */
export function browserRowInput(name: string, input: unknown, server?: string): unknown {
  if (hostBrowserTool(name, server) !== 'browser_type') return input;
  if (typeof input === 'string') {
    try {
      const parsed = browserRowInput(name, JSON.parse(input), server);
      return parsed === BROWSER_MASK ? BROWSER_MASK : JSON.stringify(parsed);
    } catch {
      return BROWSER_MASK;
    }
  }
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...input, text: BROWSER_MASK } : BROWSER_MASK;
}

/** How the app classes a site, by name alone. Only `local`, `file` and `allowed` reach the AI's tools. */
export type BrowserSiteClass = 'local' | 'file' | 'allowed' | 'external';

export const BROWSER_ACTION_KINDS = ['navigate', 'click', 'type', 'press'] as const;
export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];
export const BROWSER_STEP_KINDS = ['snapshot', 'screenshot', 'console', 'wait', ...BROWSER_ACTION_KINDS] as const;
export type BrowserStepKind = (typeof BROWSER_STEP_KINDS)[number];

/**
 * Why the app said no to a browser tool. `stopped`: the person pressed 중지 on the pane during this turn. `browser-off`:
 * the setting is off; the tools stay listed, because the list is frozen for the conversation's prompt cache.
 */
export const BROWSER_REFUSALS = [
  'site-not-allowed', 'plan-mode', 'unattended', 'no-page', 'stale-ref', 'page-gone', 'password-field',
  'upload-unsupported', 'approval-declined', 'approval-timeout', 'rebind-suspected', 'limit', 'download-blocked', 'stopped',
  'browser-off', 'approval-void',
] as const;
export type BrowserRefusal = (typeof BROWSER_REFUSALS)[number];

/** A host approval raised for a browser action carries this prefix in `providerRequestId`. */
const BROWSER_ACTION_REQUEST = 'browser-action:';

export function isBrowserActionRequest(id: string | undefined): boolean {
  return id?.startsWith(BROWSER_ACTION_REQUEST) === true;
}

export function browserActionRequestId(callId: string): string {
  return `${BROWSER_ACTION_REQUEST}${callId}`;
}

/** How long the host holds a browser action for an answer; then it is void and the tool refuses. */
export const BROWSER_APPROVAL_HOLD_MS = 240_000;

/** What will run, from the host's own call: the full URL, the value to type, the keys. */
export type BrowserActionRun =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click' }
  | { readonly kind: 'type'; readonly value: string; readonly submit?: true }
  | { readonly kind: 'press'; readonly keys: string };

/** What the decision dock shows for a browser action: the app's facts, then the one thing the page wrote. */
export interface BrowserActionView {
  readonly origin: string;
  readonly action: BrowserActionKind;
  readonly run: BrowserActionRun;
  /** The element's role and name as the page gives them: page text, never the app's words. */
  readonly pageElement?: string;
}

const ACTIONS: Readonly<Record<string, BrowserActionKind>> = {
  browser_navigate: 'navigate', browser_click: 'click', browser_type: 'type', browser_press: 'press',
};

export function browserActionKind(tool: string): BrowserActionKind | undefined {
  return ACTIONS[tool];
}

/** The phone's line for a browser action: all it is told, which site and what kind of action, and when the wait ends. */
export function browserWaitingOf(approval: { readonly providerRequestId?: string; readonly createdAt: string; readonly request?: unknown }): { readonly origin: string; readonly action: BrowserActionKind; readonly expiresAt: string } | undefined {
  if (!isBrowserActionRequest(approval.providerRequestId)) return undefined;
  const request = parseApprovalRequest(approval.request);
  const action = request?.kind === 'tool' ? ACTIONS[request.toolName] : undefined;
  if (request?.kind !== 'tool' || !request.target || !action) return undefined;
  return { origin: request.target, action, expiresAt: new Date(Date.parse(approval.createdAt) + BROWSER_APPROVAL_HOLD_MS).toISOString() };
}

function inputOf(input: string | undefined): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(input ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function runOf(action: BrowserActionKind, input: Readonly<Record<string, unknown>>): BrowserActionRun | undefined {
  switch (action) {
    case 'click': return { kind: 'click' };
    case 'navigate': return typeof input.url === 'string' ? { kind: 'navigate', url: input.url } : undefined;
    case 'type': return typeof input.value === 'string' ? { kind: 'type', value: input.value, ...(input.submit === true ? { submit: true as const } : {}) } : undefined;
    case 'press': return typeof input.keys === 'string' ? { kind: 'press', keys: input.keys } : undefined;
  }
}

/** Undefined when what will run cannot be read: the generic dock then shows the raw input, and nothing is implied. */
export function browserActionOf(request: ApprovalRequest | undefined): BrowserActionView | undefined {
  if (request?.kind !== 'tool' || !request.target) return undefined;
  const action = ACTIONS[request.toolName];
  const input = inputOf(request.input);
  if (!action || !input) return undefined;
  const run = runOf(action, input);
  if (!run) return undefined;
  return { origin: request.target, action, run, ...(typeof input.element === 'string' ? { pageElement: input.element } : {}) };
}

const SECRET_PREFIX = /^(?:sk[-_]|pk[-_]|ghp_|gho_|github_pat_|xox[abp]-|AKIA|AIza|eyJ)/u;
const SECRET_NAMED = /\b(?:password|passwd|secret|token|api[-_]?key)\b\s*[:=]/iu;

/** A value to type that reads as a credential starts masked on the approval card. A guess, so it only ever hides. */
export function looksSecret(value: string): boolean {
  const text = value.trim();
  if (SECRET_PREFIX.test(text) || SECRET_NAMED.test(text)) return true;
  return /^\S{20,}$/u.test(text) && /[a-z]/iu.test(text) && /\d/u.test(text);
}

const LOCAL_NAMES = /^(?:localhost|.+\.localhost|\[::1\]|127\.\d+\.\d+\.\d+)$/u;

/** A host that is this PC by its name alone. `localhost.`, `0.0.0.0` and `[::ffff:…]` only look it, and are not. */
export function isLocalHostName(hostname: string): boolean {
  return LOCAL_NAMES.test(hostname.toLowerCase());
}

/** The URL a request's site is judged on: a socket has the site of its page. */
export function webForm(url: string): string {
  return url.replace(/^ws(s?):/iu, 'http$1:');
}

export interface SiteClassOptions {
  /** The page that made an `about:blank` or `about:srcdoc`: they take its class. */
  readonly creator?: string;
  /** The app's own listening ports: never `local`, whoever asks. */
  readonly controlPorts?: ReadonlySet<number>;
}

/** A URL on one of the app's own listening ports. Named, so every layer refuses the same thing. */
export function isControlPortUrl(url: string, controlPorts: ReadonlySet<number>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(webForm(url));
  } catch {
    return false;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isLocalHostName(parsed.hostname)) return false;
  return controlPorts.has(Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80));
}

/**
 * The class of a URL, by name alone: it never resolves DNS, and anything that only looks local fails closed. `file` here
 * is the scheme; whether the file sits inside the conversation's folders is the host's check. `blob:` and `about:` take
 * their creator's class.
 */
export function siteClass(url: string, allowedOrigins: readonly string[], options: SiteClassOptions = {}): BrowserSiteClass {
  let parsed: URL;
  try {
    parsed = new URL(webForm(url));
  } catch {
    return 'external';
  }
  const ports = options.controlPorts ? { controlPorts: options.controlPorts } : {};
  if (parsed.protocol === 'about:') return options.creator ? siteClass(options.creator, allowedOrigins, ports) : 'external';
  if (parsed.protocol === 'blob:') return siteClass(parsed.origin, allowedOrigins, ports);
  if (parsed.username || parsed.password) return 'external';
  // A `file://server/share` goes over the network, and would hand it this PC's credentials.
  if (parsed.protocol === 'file:') return parsed.hostname ? 'external' : 'file';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'external';
  if (isLocalHostName(parsed.hostname)) return options.controlPorts && isControlPortUrl(url, options.controlPorts) ? 'external' : 'local';
  return allowedOrigins.includes(parsed.origin) ? 'allowed' : 'external';
}

/**
 * What the address bar loads: http(s), with the scheme a person leaves out, and a `file:` the host then limits to the
 * conversation's folders. Nothing that runs (`javascript:`) or shows the browser's own pages.
 */
export function addressBarUrl(text: string): string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  // `localhost:5173/cart` parses as the scheme `localhost:`: a host and a port are no scheme.
  const hostAndPort = /^[^/:\s]+:\d+(?:[/?#]|$)/u.test(value);
  if (scheme && !hostAndPort) return ['http', 'https', 'file'].includes(scheme) && URL.canParse(value) ? new URL(value).href : undefined;
  if (/\s/u.test(value)) return undefined;
  const local = /^(?:localhost|.+\.localhost|\[::1\]|127\.\d+\.\d+\.\d+)(?:[:/?#]|$)/iu.test(value);
  const url = `${local ? 'http' : 'https'}://${value}`;
  return URL.canParse(url) ? new URL(url).href : undefined;
}

/** The exact origin a person may allow, or undefined: an http(s) site with no credentials or path, that needs allowing at all. */
export function allowableOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return undefined;
  // One exact site: the URL parser lets `*.example` through as a name, and nothing here is a pattern.
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/u.test(parsed.hostname)) return undefined;
  return siteClass(parsed.origin, []) === 'external' ? parsed.origin : undefined;
}

/** An element a person pressed in the pane, in the host's own reading. Everything here but `url` is the page's. */
export interface BrowserPickedElement {
  readonly conversationId: string;
  readonly url: string;
  readonly selector: string;
  readonly role: string;
  readonly name: string;
  /** The element's picture, JPEG. Absent when it would not fit a message. */
  readonly imageBase64?: string;
}

const oneLine = (value: string, chars: number): string => value.replace(/\s+/gu, ' ').trim().slice(0, chars);

/**
 * What a picked element puts in the message: its picture and a note. The words are the page's, so the note quotes them: they
 * reach the AI as data and never as the person's, whatever the person writes beside them. At most 2 KB.
 */
export function browserElementAttachments(picked: BrowserPickedElement, createId: () => string): readonly ChatAttachment[] {
  const origin = URL.canParse(picked.url) ? new URL(picked.url).origin : 'the page';
  const note = quotedData(`Page element from ${origin}`, [
    `url: ${oneLine(picked.url, 1_000)}`, `selector: ${oneLine(picked.selector, 400)}`, `role: ${oneLine(picked.role, 60)}`, `name: ${oneLine(picked.name, 300)}`,
  ].join('\n'));
  const label = `element ${oneLine(picked.selector, 80)}`;
  return [
    ...(picked.imageBase64 ? [{ id: createId(), name: `${label}.jpg`, mimeType: 'image/jpeg', kind: 'image' as const, data: picked.imageBase64 }] : []),
    { id: createId(), name: `${label}.txt`, mimeType: 'text/plain', kind: 'text', data: note },
  ];
}

/** Settings › 에이전트 › 내장 브라우저. */
export interface BrowserSettings {
  /** The AI's browser tools; applies to the next conversation it starts. */
  readonly enabled: boolean;
  readonly autoCheck: boolean;
}

export function parseBrowserSettings(value: unknown): BrowserSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { enabled, autoCheck, ...rest } = value as Record<string, unknown>;
  return typeof enabled === 'boolean' && typeof autoCheck === 'boolean' && Object.keys(rest).length === 0 ? { enabled, autoCheck } : undefined;
}

export interface BrowserProjectSites {
  readonly projectId: string;
  readonly projectName: string;
  readonly origins: readonly string[];
}

/** A local address a terminal or an AI named. Nothing opens it until a person presses it. */
export interface BrowserDevCandidate {
  readonly url: string;
  readonly source: 'terminal' | 'ai';
}

/** What the pane shows of one conversation's page: pushed over IPC, never in the daemon snapshot. */
export interface BrowserViewState {
  readonly conversationId: string;
  readonly url: string;
  /** Addresses to offer in an empty pane. */
  readonly candidates?: readonly BrowserDevCandidate[];
  readonly site?: BrowserSiteClass;
  readonly loading: boolean;
  readonly canBack: boolean;
  readonly canForward: boolean;
  /** The person is picking an element. */
  readonly picking?: boolean;
  /** An action on this page waits on a person. */
  readonly waiting?: boolean;
  /** This conversation's AI is older than the tools were measured on: they are off, and the pane is not. */
  readonly belowFloor?: { readonly providerId: string; readonly version: string; readonly minimum: string };
  /** Who is at the page: `driving`, a tool ran this turn; `stopped`, the person pressed 브라우저만 중지 this turn. */
  readonly ai: 'none' | 'driving' | 'stopped';
  /** The last thing the guards stopped, for the pane bar. `serial` tells one stop from the next, so a closed bar stays closed. */
  readonly blocked?: { readonly origin: string; readonly reason: BrowserRefusal; readonly serial: number };
  /** The site the person just allowed from this pane. */
  readonly allowed?: string;
  readonly fault?: 'server-down' | 'gone';
  /** `url` is the last page. The app never reloads it unasked after a restart or an eviction. */
  readonly needsReopen?: boolean;
}

/** A pane's place on screen, as the renderer reports it. */
export interface BrowserSurfaceSnapshot {
  readonly conversationId: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly mounted: boolean;
  readonly windowName: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly visible: boolean;
}

export function isBrowserSurfaceSnapshot(value: unknown): value is BrowserSurfaceSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const surface = value as Record<string, unknown>;
  const bounds = surface.bounds as Record<string, unknown> | undefined;
  const whole = (entry: unknown): boolean => typeof entry === 'number' && Number.isSafeInteger(entry);
  return typeof surface.conversationId === 'string' && surface.conversationId.length > 0 && surface.conversationId.length <= 256
    && typeof surface.instanceId === 'string' && surface.instanceId.length > 0 && surface.instanceId.length <= 128
    && whole(surface.revision) && typeof surface.mounted === 'boolean' && typeof surface.visible === 'boolean'
    && typeof surface.windowName === 'string' && surface.windowName.length <= 256
    && typeof bounds === 'object' && bounds !== null && [bounds.x, bounds.y, bounds.width, bounds.height].every(whole);
}
