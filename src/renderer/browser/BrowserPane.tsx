import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';

import type { BrowserDevCandidate, BrowserSiteClass } from '../../shared/browser';
import { useChatCopy, type ChatCopy } from '../chat/copy';
import { Button, IconButton } from '../ui';
import { Glyph, glyphIcon, Led, type GlyphName, type LedTone } from '../ui/Glyph';
import { VisuallyHidden } from '../ui/VisuallyHidden';
import './browser-pane.css';

/**
 * The in-app browser's pane, as a view: what it shows comes in as props and everything it does goes out through
 * `onAction`. The page itself is a native view the app will place over the page plate, and a native view always sits
 * above the DOM, so nothing of the app's is ever drawn over a page: the toolbar and every strip stand apart from it, and
 * an open dialog hides it (`pageHidden`).
 */

/** The one line between the toolbar and the page. Only `waiting` is amber: it alone waits on the person. */
export type BrowserPaneStrip =
  /** `scope`: what 중지 stops. The drawn alternative stops the turn; see the story. */
  | { readonly kind: 'driving'; readonly scope?: 'browser' | 'turn' }
  | { readonly kind: 'stopped'; readonly scope?: 'browser' | 'turn' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'blocked'; readonly origin: string }
  | { readonly kind: 'not-read'; readonly origin: string }
  | { readonly kind: 'allowed'; readonly origin: string }
  | { readonly kind: 'unsupported'; readonly reason: string };

export type BrowserPaneBody =
  | { readonly kind: 'empty'; readonly candidates: readonly BrowserDevCandidate[] }
  | { readonly kind: 'page' }
  | { readonly kind: 'server-down'; readonly origin: string }
  /** `ended`: the app closed the page itself, so nothing crashed. */
  | { readonly kind: 'gone'; readonly ended?: 'rebind-suspected' };

export type BrowserPaneAction =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' | 'forward' | 'reload' | 'pick' | 'cancel-pick' | 'stop-ai' | 'stop-turn' | 'answer' | 'dismiss' | 'retry' | 'reopen' }
  | { readonly kind: 'allow-site'; readonly origin: string };

export interface BrowserPaneProps {
  readonly address: string;
  readonly site?: BrowserSiteClass;
  readonly body: BrowserPaneBody;
  readonly strip?: BrowserPaneStrip;
  readonly canBack?: boolean;
  readonly canForward?: boolean;
  readonly picking?: boolean;
  /** An app dialog is open: the native page view is hidden until it closes. */
  readonly pageHidden?: boolean;
  /** Stories only: what the native view would show. The app leaves this plate empty and places the view over it. */
  readonly page?: ReactNode;
  /** The plate the native view is placed over. */
  readonly pageRef?: RefObject<HTMLDivElement>;
  readonly onAction: (action: BrowserPaneAction) => void;
}

/** `allowed` is a key, not the shield: the person gave access, and nothing here vouches for the site. */
const SITE_GLYPH: Readonly<Record<BrowserSiteClass, GlyphName>> = { local: 'pc', file: 'file', allowed: 'key', external: 'eyeOff' };

function SiteBadge({ site, copy }: { readonly site: BrowserSiteClass; readonly copy: ChatCopy['browser'] }): JSX.Element {
  return (
    <span className="browser-pane__site" data-site={site} title={copy.siteHint[site]} data-testid="browser-site-badge">
      <Glyph name={SITE_GLYPH[site]} size={14} />
      <span>{copy.site[site]}</span>
      <VisuallyHidden>{copy.siteHint[site]}</VisuallyHidden>
    </span>
  );
}

function Toolbar({ address, site, canBack = false, canForward = false, picking = false, loaded, onAction, copy, addressRef, pickRef }: {
  readonly address: string;
  readonly site?: BrowserSiteClass;
  readonly canBack?: boolean;
  readonly canForward?: boolean;
  readonly picking?: boolean;
  readonly loaded: boolean;
  readonly onAction: BrowserPaneProps['onAction'];
  readonly copy: ChatCopy['browser']['pane'];
  readonly addressRef: RefObject<HTMLInputElement>;
  readonly pickRef: RefObject<HTMLButtonElement>;
}): JSX.Element {
  const [draft, setDraft] = useState(address);
  useEffect(() => setDraft(address), [address]);
  const pickable = loaded && site !== undefined && site !== 'external';
  const go = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.trim()) onAction({ kind: 'navigate', url: draft.trim() });
  };
  const fullCopy = useChatCopy().browser;
  return (
    <div className="browser-pane__bar" role="group" aria-label={copy.label}>
      <IconButton size="sm" variant="ghost" aria-label={copy.back} title={copy.back} icon={glyphIcon('back')} disabled={!canBack} onClick={() => onAction({ kind: 'back' })} />
      <IconButton size="sm" variant="ghost" aria-label={copy.forward} title={copy.forward} icon={glyphIcon('next')} disabled={!canForward} onClick={() => onAction({ kind: 'forward' })} />
      <IconButton size="sm" variant="ghost" aria-label={copy.reload} title={copy.reload} icon={glyphIcon('refresh')} disabled={!loaded} onClick={() => onAction({ kind: 'reload' })} />
      <form className="browser-pane__address" onSubmit={go}>
        <input ref={addressRef} aria-label={copy.address} value={draft} placeholder={copy.address} spellCheck={false} autoComplete="off" onChange={(event) => setDraft(event.target.value)} data-testid="browser-address" />
      </form>
      {site && <SiteBadge site={site} copy={fullCopy} />}
      <IconButton ref={pickRef} size="sm" variant={picking ? 'secondary' : 'ghost'} aria-label={copy.pick} title={pickable ? copy.pick : copy.pickOff} aria-pressed={picking} icon={glyphIcon('pointer')}
        disabled={!pickable} onClick={() => onAction({ kind: picking ? 'cancel-pick' : 'pick' })} data-testid="browser-pick" />
    </div>
  );
}

interface StripView {
  readonly tone: 'plain' | 'live' | 'amber';
  readonly lamp?: LedTone;
  readonly glyph?: GlyphName;
  readonly title: string;
  readonly detail?: string;
  readonly origin?: string;
  readonly actions: readonly { readonly label: string; readonly ariaLabel?: string; readonly primary?: boolean; readonly action: BrowserPaneAction; readonly testId: string }[];
}

function stripView(strip: BrowserPaneStrip, copy: ChatCopy['browser']['pane']['strip']): StripView {
  switch (strip.kind) {
    case 'driving': {
      const turn = strip.scope === 'turn';
      return {
        tone: 'live', lamp: 'on', title: copy.driving,
        actions: [{ label: turn ? copy.stopTurn : copy.stop, ...(turn ? { ariaLabel: copy.stopTurnLabel } : {}), action: { kind: turn ? 'stop-turn' : 'stop-ai' }, testId: 'browser-stop' }],
      };
    }
    case 'stopped':
      return strip.scope === 'turn'
        ? { tone: 'plain', glyph: 'stop', title: copy.stoppedTurn, detail: copy.stoppedTurnDetail, actions: [] }
        : { tone: 'plain', glyph: 'stop', title: copy.stopped, detail: copy.stoppedDetail, actions: [] };
    case 'waiting':
      return { tone: 'amber', lamp: 'amber', title: copy.waiting, actions: [{ label: copy.answer, action: { kind: 'answer' }, testId: 'browser-answer' }] };
    case 'blocked':
      return {
        tone: 'plain', glyph: 'unlink', title: copy.blocked, detail: copy.blockedDetail, origin: strip.origin,
        actions: [
          { label: copy.dismiss, action: { kind: 'dismiss' }, testId: 'browser-dismiss' },
          { label: copy.allow, action: { kind: 'allow-site', origin: strip.origin }, testId: 'browser-allow-open' },
        ],
      };
    case 'not-read':
      return {
        tone: 'plain', glyph: 'eyeOff', title: copy.notRead, detail: copy.notReadDetail,
        actions: [{ label: copy.allow, action: { kind: 'allow-site', origin: strip.origin }, testId: 'browser-allow-open' }],
      };
    case 'allowed':
      return { tone: 'plain', glyph: 'key', title: copy.allowed, detail: copy.allowedDetail, origin: strip.origin, actions: [{ label: copy.dismiss, action: { kind: 'dismiss' }, testId: 'browser-dismiss' }] };
    case 'unsupported':
      return { tone: 'plain', glyph: 'eyeOff', title: copy.unsupported, detail: `${strip.reason} ${copy.unsupportedDetail}`, actions: [] };
  }
}

function Strip({ view, onAction, focus = false }: { readonly view: StripView; readonly onAction: BrowserPaneProps['onAction']; readonly focus?: boolean }): JSX.Element {
  const title = useRef<HTMLParagraphElement>(null);
  // The button that was pressed is gone: focus stays with what the press did.
  useEffect(() => { if (focus) title.current?.focus(); }, [focus]);
  return (
    <section className="browser-pane__strip" data-tone={view.tone} data-testid="browser-strip">
      {view.lamp ? <Led tone={view.lamp} /> : view.glyph && <Glyph name={view.glyph} size={16} />}
      <div className="browser-pane__strip-text" role="status">
        <p className="browser-pane__strip-title" ref={title} tabIndex={-1}>
          <strong>{view.title}</strong>
          {view.origin && <code>{view.origin}</code>}
        </p>
        {view.detail && <p className="browser-pane__strip-detail">{view.detail}</p>}
      </div>
      {view.actions.length > 0 && (
        <div className="browser-pane__strip-actions">
          {view.actions.map((entry) => (
            <Button key={entry.testId} size="sm" variant={entry.testId === 'browser-allow-open' ? 'primary' : 'secondary'} aria-label={entry.ariaLabel} onClick={() => onAction(entry.action)} data-testid={entry.testId}>{entry.label}</Button>
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyBody({ candidates, onAction, copy }: {
  readonly candidates: readonly BrowserDevCandidate[];
  readonly onAction: BrowserPaneProps['onAction'];
  readonly copy: ChatCopy['browser']['pane']['empty'];
}): JSX.Element {
  return (
    <div className="browser-pane__state" data-testid="browser-empty">
      <Glyph name="globe" size={28} />
      <h3>{copy.title}</h3>
      {candidates.length > 0 ? (
        <>
          <p className="browser-pane__state-lead">{copy.found}</p>
          <ul className="browser-pane__candidates">
            {candidates.map((candidate) => (
              <li key={candidate.url}>
                <div>
                  <code>{candidate.url}</code>
                  <span>{copy.source[candidate.source]}</span>
                </div>
                <Button size="sm" variant="secondary" aria-label={`${copy.open} ${candidate.url}`} onClick={() => onAction({ kind: 'navigate', url: candidate.url })}>{copy.open}</Button>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="browser-pane__state-lead">{copy.none}</p>}
      <p className="browser-pane__state-hint">{copy.hint}</p>
    </div>
  );
}

function FaultBody({ glyph, title, detail, ai, label, action, onAction }: {
  readonly glyph: GlyphName;
  readonly title: string;
  readonly detail: string;
  readonly ai: string;
  readonly label: string;
  readonly action: BrowserPaneAction;
  readonly onAction: BrowserPaneProps['onAction'];
}): JSX.Element {
  return (
    <div className="browser-pane__state" data-testid="browser-fault">
      <Glyph name={glyph} size={28} />
      <h3>{title}</h3>
      <p className="browser-pane__state-lead">{detail}</p>
      <Button size="sm" variant="primary" onClick={() => onAction(action)} data-testid="browser-retry">{label}</Button>
      <p className="browser-pane__state-hint">{ai}</p>
    </div>
  );
}

export function BrowserPane({ address, site, body, strip, canBack, canForward, picking = false, pageHidden = false, page, pageRef, onAction }: BrowserPaneProps): JSX.Element {
  const browserCopy = useChatCopy().browser;
  const copy = browserCopy.pane;
  const addressRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const pressStrip = (action: BrowserPaneAction): void => {
    onAction(action);
    // These buttons go with their strip: focus moves to where the person can go on.
    if (action.kind === 'dismiss') addressRef.current?.focus();
    if (action.kind === 'cancel-pick') pickRef.current?.focus();
  };
  useEffect(() => {
    if (!picking) return undefined;
    // In the app the page has the keyboard, so the host forwards Esc; this covers focus left in the app's own chrome.
    const cancel = (event: KeyboardEvent): void => { if (event.key === 'Escape') onAction({ kind: 'cancel-pick' }); };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [onAction, picking]);
  const view = strip ? stripView(strip, copy.strip) : undefined;
  const stopped = strip?.kind === 'stopped' || strip?.kind === 'allowed';
  return (
    <section className="browser-pane" aria-label={copy.label} data-testid="browser-pane">
      <Toolbar key={address} address={address} {...(site ? { site } : {})} canBack={canBack ?? false} canForward={canForward ?? false} picking={picking} loaded={body.kind === 'page'} onAction={onAction} copy={copy} addressRef={addressRef} pickRef={pickRef} />
      {picking
        ? <Strip view={{ tone: 'live', lamp: 'on', title: copy.strip.picking, detail: copy.strip.pickingDetail, actions: [{ label: copy.strip.pickCancel, action: { kind: 'cancel-pick' }, testId: 'browser-pick-cancel' }] }} onAction={pressStrip} />
        : view && <Strip view={view} onAction={pressStrip} focus={stopped} />}
      <div ref={pageRef} className="browser-pane__page" data-testid="browser-page" data-hidden={pageHidden || undefined}>
        {body.kind === 'empty' && <EmptyBody candidates={body.candidates} onAction={onAction} copy={copy.empty} />}
        {body.kind === 'server-down' && <FaultBody glyph="offline" title={copy.fault.downTitle} detail={copy.fault.down(body.origin)} ai={copy.fault.ai} label={copy.fault.retry} action={{ kind: 'retry' }} onAction={onAction} />}
        {body.kind === 'gone' && <FaultBody glyph="warn" title={copy.fault.goneTitle} detail={body.ended ? browserCopy.refusal[body.ended] : copy.fault.gone} ai={copy.fault.ai} label={copy.fault.reopen} action={{ kind: 'reopen' }} onAction={onAction} />}
        {body.kind === 'page' && !pageHidden && page}
        {body.kind === 'page' && pageHidden && <p className="browser-pane__hidden">{copy.pageHidden}</p>}
      </div>
    </section>
  );
}
