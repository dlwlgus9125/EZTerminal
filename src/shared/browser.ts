import type { ApprovalRequest } from './approval-request';

/**
 * 시안: the words the in-app browser's screens share. Types and the approval prefix only: the site policy, the tools and
 * the host come with the implementation. Nothing in production writes these yet.
 */

export const BROWSER_CAPABILITY = 'in-app-browser-v1';

/** How the app classes a site, by name alone. Only `local`, `file` and `allowed` reach the AI's tools. */
export type BrowserSiteClass = 'local' | 'file' | 'allowed' | 'external';

export type BrowserActionKind = 'navigate' | 'click' | 'type' | 'press';
export type BrowserStepKind = 'snapshot' | 'screenshot' | 'console' | 'wait' | BrowserActionKind;

/** Why the app said no to a browser tool. `stopped`: the person pressed 중지 on the pane during this turn. */
export type BrowserRefusal =
  | 'site-not-allowed' | 'plan-mode' | 'unattended' | 'no-page' | 'stale-ref' | 'page-gone' | 'password-field'
  | 'upload-unsupported' | 'approval-declined' | 'approval-timeout' | 'rebind-suspected' | 'limit' | 'download-blocked' | 'stopped';

/** A host approval raised for a browser action carries this prefix in `providerRequestId`. */
const BROWSER_ACTION_REQUEST = 'browser-action:';

export function isBrowserActionRequest(id: string | undefined): boolean {
  return id?.startsWith(BROWSER_ACTION_REQUEST) === true;
}

/** How long the host holds a browser action for an answer; then it is void and the tool refuses. */
export const BROWSER_APPROVAL_HOLD_MS = 240_000;

/** What will run, from the host's own call: the full URL, the value to type, the keys. */
export type BrowserActionRun =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click' }
  | { readonly kind: 'type'; readonly value: string }
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
    case 'type': return typeof input.value === 'string' ? { kind: 'type', value: input.value } : undefined;
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

/**
 * The class of a URL, by name alone: it never resolves DNS, and anything that only looks local fails closed. `file` here
 * is the scheme; whether the file sits inside the conversation's folders is the host's check.
 */
export function siteClass(url: string, allowedOrigins: readonly string[]): BrowserSiteClass {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'external';
  }
  if (parsed.username || parsed.password) return 'external';
  if (parsed.protocol === 'file:') return 'file';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'external';
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(host)) return 'local';
  return allowedOrigins.includes(parsed.origin) ? 'allowed' : 'external';
}

/** Settings › 에이전트 › 내장 브라우저. */
export interface BrowserSettings {
  /** The AI's browser tools; applies to the next conversation it starts. */
  readonly enabled: boolean;
  readonly autoCheck: boolean;
}

export interface BrowserProjectSites {
  readonly projectId: string;
  readonly projectName: string;
  readonly origins: readonly string[];
}
