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

/** What the decision dock shows for a browser action: the app's facts, and the one thing the page wrote. */
export interface BrowserActionView {
  readonly origin: string;
  readonly action: BrowserActionKind;
  /** The element's role and name as the page gives them: page text, never the app's words. */
  readonly pageElement?: string;
}

const ACTIONS: Readonly<Record<string, BrowserActionKind>> = {
  browser_navigate: 'navigate', browser_click: 'click', browser_type: 'type', browser_press: 'press',
};

export function browserActionOf(request: ApprovalRequest | undefined): BrowserActionView | undefined {
  if (request?.kind !== 'tool' || !request.target) return undefined;
  const action = ACTIONS[request.toolName];
  if (!action) return undefined;
  return { origin: request.target, action, ...(request.input ? { pageElement: request.input } : {}) };
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
