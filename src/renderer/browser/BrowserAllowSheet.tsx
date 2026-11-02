import { useRef } from 'react';

import { useChatCopy } from '../chat/copy';
import { Button, Dialog } from '../ui';
import { Glyph } from '../ui/Glyph';
import './browser-pane.css';

export type BrowserAllowPreset = 'plan' | 'standard' | 'full-access';

export interface BrowserAllowSheetProps {
  readonly origin: string;
  readonly projectName: string;
  /** The access of the conversation it opened from. The allow itself is the project's. */
  readonly preset: BrowserAllowPreset;
  readonly onCancel: () => void;
  readonly onAllow: (origin: string) => void;
}

/**
 * The person allows one exact origin for one project (D7). It is a choice the app can only partly back up, so the sheet
 * says what it does not do: allowing a site makes nothing on it safe, and a page can try to steer the AI. Cancel takes the
 * first focus.
 */
export function BrowserAllowSheet({ origin, projectName, preset, onCancel, onAllow }: BrowserAllowSheetProps): JSX.Element {
  const copy = useChatCopy().browser.allow;
  const cancel = useRef<HTMLButtonElement>(null);
  const full = preset === 'full-access';
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }} title={copy.title} tone={full ? 'danger' : 'warning'} initialFocusRef={cancel} testId="browser-allow-sheet"
      footer={(
        <>
          <Button ref={cancel} variant="secondary" onClick={onCancel} data-testid="browser-allow-cancel">{copy.cancel}</Button>
          <Button variant="primary" onClick={() => onAllow(origin)} data-testid="browser-allow-confirm">{copy.confirm}</Button>
        </>
      )}>
      <div className="browser-allow">
        <p className="browser-allow__site"><span>{copy.site}</span><code>{origin}</code></p>
        <p>{copy.scope(projectName)}</p>
        <p>{copy.does[preset]}{full ? '' : ` ${copy.projectWide}`}</p>
        <section className="browser-allow__warn" data-level={full ? 'full' : 'plain'} data-testid="browser-allow-warning">
          <Glyph name="warn" size={16} />
          <div>
            <p><strong>{copy.warnTitle}</strong></p>
            <p>{copy.warn}</p>
            {full && <p>{copy.warnFull}</p>}
          </div>
        </section>
        <p className="browser-allow__hint">{copy.login}</p>
      </div>
    </Dialog>
  );
}
