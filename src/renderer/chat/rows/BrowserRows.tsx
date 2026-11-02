import type { BrowserRefusal, BrowserStepKind } from '../../../shared/browser';
import { Glyph, Led, type GlyphName } from '../../ui/Glyph';
import { useChatContext } from '../ChatContext';
import { formatClock, useChatCopy, type ChatCopy } from '../copy';
import type { ChatBrowserRun, ChatBrowserStep, ChatRow } from '../model/types';
import { providerName } from '../review/review-presentation';
import { aiLines, InlineCode } from '../wrap-up/wrap-up-presentation';
import { ActionCard, type ActionCardAction, type ActionCardState } from './ActionCard';
import '../browser/browser-rows.css';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;

const READS: ReadonlySet<BrowserStepKind> = new Set(['snapshot', 'console']);
const ACTIONS: ReadonlySet<BrowserStepKind> = new Set(['navigate', 'click', 'type', 'press']);

/** `localhost:5173`: a CLI target has no room for the scheme. */
const hostOf = (origin: string): string => origin.replace(/^[a-z]+:\/\//u, '');

/** What ran, from the app's log. "Sent" is all the app knows: whether the AI read it is the AI's to say. */
function runSummary(run: ChatBrowserRun, copy: ChatCopy['browser']['run']): string {
  const count = (test: (kind: BrowserStepKind) => boolean): number => run.steps.filter((step) => test(step.kind)).length;
  const shots = count((kind) => kind === 'screenshot');
  const reads = count((kind) => READS.has(kind));
  const actions = count((kind) => ACTIONS.has(kind));
  const sent = [shots ? copy.screenshots(shots) : '', reads ? copy.reads(reads) : ''].filter(Boolean).join(' · ');
  return [sent ? `${sent} ${copy.sent}` : '', actions ? copy.actions(actions) : ''].filter(Boolean).join(' · ');
}

/** A page's words, in their own inset, under the app's line that says whose they are. */
function PageText({ origin, text }: { readonly origin: string; readonly text: string }): JSX.Element {
  const copy = useChatCopy().browser.run;
  return (
    <blockquote className="chat-browser-page-text">
      <span>{copy.pageText(origin)}</span>
      <p>{text}</p>
    </blockquote>
  );
}

function StepLine({ step, origin }: { readonly step: ChatBrowserStep; readonly origin: string }): JSX.Element {
  const copy = useChatCopy().browser;
  const { locale } = useChatContext();
  return (
    <li className="chat-browser-step">
      <p>
        <span>{copy.steps[step.kind]}</span>
        <time dateTime={step.at}>{formatClock(step.at, locale)}</time>
      </p>
      {step.pageText && <PageText origin={origin} text={step.pageText} />}
    </li>
  );
}

/**
 * One run of browser tools on one site, folded to a line and the latest screenshot. The screenshot is the page's, in an
 * inset of its own; the caption above it is the app's, and says only that it was sent.
 */
export function BrowserRunRow({ row }: { readonly row: RowOf<'browser-run'> }): JSX.Element {
  const copy = useChatCopy().browser;
  const context = useChatContext();
  const { run } = row;
  const summary = runSummary(run, copy.run);
  const key = `browser-run:${row.id}`;
  const open = context.isExpanded(key, false);
  const clock = run.latestShot ? formatClock(run.latestShot.takenAt, context.locale) : '';
  const shot = run.latestShot && (
    <figure className="chat-browser-shot">
      <figcaption>{copy.run.lastShot(clock)}</figcaption>
      <img src={run.latestShot.thumb} alt={copy.run.shotAlt(run.origin)} />
    </figure>
  );
  const toggle = (
    <button type="button" className="chat-browser-run__toggle" aria-expanded={open} onClick={() => context.setExpanded(key, !open)}>
      <Glyph name="next" className="chat-chevron" />{copy.run.showSteps(run.steps.length)}
    </button>
  );
  const steps = open && (
    <ol className="chat-browser-run__steps">
      {run.steps.map((step) => <StepLine key={step.id} step={step} origin={run.origin} />)}
    </ol>
  );
  if (context.skin === 'cli') {
    return (
      <section className="chat-cli-line chat-cli-browser" aria-label={copy.run.label(run.origin, summary)} data-testid="chat-browser-run">
        <span className="chat-cli-glyph" data-tone="muted" aria-hidden="true">⏺</span>
        <div className="chat-cli-line__body">
          <p className="chat-cli-action-card__head">
            <span className="chat-cli-tool__name">{copy.run.name}</span>
            <span className="chat-cli-tool__target">({hostOf(run.origin)})</span>
            {' '}<span className="chat-cli-dim">{summary}</span>
          </p>
          {shot && <div className="chat-cli-result" data-tone="muted"><span className="chat-cli-result__elbow" aria-hidden="true">⎿</span><div className="chat-cli-result__body">{shot}</div></div>}
          {toggle}
          {steps}
        </div>
      </section>
    );
  }
  return (
    <section className="chat-browser-run" aria-label={copy.run.label(run.origin, summary)} data-testid="chat-browser-run">
      <p className="chat-browser-run__head">
        <Glyph name="globe" />
        <strong>{copy.run.name}</strong>
        <code>{hostOf(run.origin)}</code>
        <span>{summary}</span>
      </p>
      {shot}
      {toggle}
      {steps}
    </section>
  );
}

const REFUSAL_GLYPH: Partial<Record<BrowserRefusal, GlyphName>> = { 'site-not-allowed': 'unlink', 'rebind-suspected': 'warn', 'download-blocked': 'download', stopped: 'stop' };

/**
 * The app refused a browser tool: which site and why, in the app's words, and nothing from the page. A refusal is the
 * host doing its job, so it reads as a note, not a failure; only a site that seems to have moved behind its name is a warning.
 */
export function BrowserBlockedRow({ row }: { readonly row: RowOf<'browser-blocked'> }): JSX.Element {
  const copy = useChatCopy().browser;
  const context = useChatContext();
  const title = copy.blocked.title[row.action ?? 'other'];
  const reason = copy.refusal[row.reason];
  const warning = row.reason === 'rebind-suspected';
  const open = row.reason === 'site-not-allowed' && context.onOpenBrowserPane;
  const clock = <time dateTime={row.createdAt}>{formatClock(row.createdAt, context.locale)}</time>;
  if (context.skin === 'cli') {
    return (
      <section className="chat-cli-line chat-cli-browser" aria-label={`${title} · ${row.origin} · ${reason}`} data-testid="chat-browser-blocked">
        <span className="chat-cli-glyph" data-tone={warning ? 'danger' : 'muted'} aria-hidden="true">⏺</span>
        <div className="chat-cli-line__body">
          <p className="chat-cli-action-card__head">
            <span className="chat-cli-tool__name">{copy.run.name}</span>
            <span className="chat-cli-tool__target">({hostOf(row.origin)})</span>
            {' '}<span className="chat-cli-dim">{title} · {clock}</span>
          </p>
          <div className="chat-cli-result" data-tone={warning ? 'danger' : 'muted'}>
            <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
            <div className="chat-cli-result__body">
              <span className="chat-cli-result__line">{reason}</span>
              {open && <button type="button" className="chat-link-button" onClick={open}>{copy.blocked.openPane}</button>}
            </div>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="chat-browser-blocked" data-tone={warning ? 'danger' : undefined} aria-label={`${title} · ${row.origin} · ${reason}`} data-testid="chat-browser-blocked">
      <Glyph name={REFUSAL_GLYPH[row.reason] ?? 'x'} />
      <div className="chat-browser-blocked__text">
        <p className="chat-browser-blocked__head"><strong>{title}</strong><code>{row.origin}</code></p>
        <p className="chat-browser-blocked__reason">{reason}</p>
      </div>
      {open && <button type="button" className="chat-link-button" onClick={open}>{copy.blocked.openPane}</button>}
      {clock}
    </section>
  );
}

/**
 * The one automatic check, read from the app's log. The app says what it asked and what the log holds; what the AI
 * concluded stays quoted as the AI's. A turn with no browser call says so, whatever the AI wrote: a model's "done" is
 * not evidence.
 */
export function BrowserCheckCard({ row }: { readonly row: RowOf<'browser-check'> }): JSX.Element {
  const copy = useChatCopy().browser;
  const context = useChatContext();
  const { check } = row;
  const provider = providerName(check.providerId);
  const clock = formatClock(row.createdAt, context.locale);
  const looked = check.calls.screenshots + check.calls.reads > 0;
  const noCalls = check.state === 'done' && !looked;
  const state: ActionCardState = check.state === 'running' ? 'running' : check.state === 'failed' ? 'failed' : noCalls ? 'stopped' : 'done';
  const stateText = noCalls ? copy.check.state.noCalls : copy.check.state[check.state];
  const notes = [
    ...(looked ? [{ id: 'calls', text: copy.check.calls(check.calls.screenshots, check.calls.reads) }] : []),
    ...(check.state === 'running' ? [] : [{ id: 'once', text: copy.check.once }]),
  ];
  const actions: ActionCardAction[] = context.onOpenBrowserPane
    ? [{ id: 'open', label: copy.check.openPane, onSelect: context.onOpenBrowserPane, testId: 'chat-browser-check-open' }] : [];
  const lines = aiLines(check.summary ?? '');
  const cli = context.skin === 'cli';
  return (
    <ActionCard
      kind="browser-check"
      testId="chat-browser-check"
      cliNeutral
      // The turn ended; that says nothing about the page, so a finished check has no green lamp.
      {...(check.state === 'running' ? {} : { glyph: 'image' as const })}
      label={`${copy.check.card} · ${stateText} · ${check.origin}`}
      title={copy.check.card}
      cliName={copy.check.card}
      cliTarget={hostOf(check.origin)}
      state={state}
      stateText={stateText}
      meta={<><span className="chat-wrap-up-meta__who">{copy.check.by}</span><span className="chat-wrap-up-meta__time"><time dateTime={row.createdAt}>{clock}</time></span></>}
      cliMeta={`${copy.check.by} · ${clock}`}
      {...(noCalls ? { message: { text: copy.check.noCalls } } : {})}
      notes={notes}
      actions={actions}
    >
      {lines.length > 0 && (cli ? (
        <ul className="chat-cli-recap" aria-label={copy.check.aiSaid(provider)}>
          <li className="chat-cli-result">
            <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
            <div className="chat-cli-result__body"><span className="chat-cli-result__line chat-cli-dim">{copy.check.aiSaid(provider)}</span></div>
          </li>
          {lines.map((line, index) => (
            // Index keys: the lines of one summary, written once.
            <li key={index} className="chat-cli-result">
              <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
              <div className="chat-cli-result__body"><span className="chat-cli-result__line"><InlineCode text={line} /></span></div>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className="chat-browser-check__who">{copy.check.aiSaid(provider)}</p>
          <blockquote className="chat-recap__text" data-testid="chat-browser-check-text">
            {lines.map((line, index) => <p key={index}><InlineCode text={line} /></p>)}
          </blockquote>
        </>
      ))}
    </ActionCard>
  );
}

/**
 * The phone's line for a browser action only the desktop can answer: it waits on a person, so it is amber, and it has no
 * buttons. A page this phone has not seen is never approved from here; the call times out instead.
 */
export function BrowserWaitingRow({ row }: { readonly row: RowOf<'browser-waiting'> }): JSX.Element {
  const copy = useChatCopy().browser.waiting;
  const { locale } = useChatContext();
  return (
    <section className="chat-browser-waiting" aria-label={copy.title} data-testid="chat-browser-waiting">
      <p className="chat-browser-waiting__head"><Led tone="amber" /><strong>{copy.title}</strong></p>
      <p className="chat-browser-waiting__what">{copy.what[row.action](row.origin)}</p>
      <p className="chat-browser-waiting__note">{copy.note(formatClock(row.expiresAt, locale))}</p>
    </section>
  );
}
