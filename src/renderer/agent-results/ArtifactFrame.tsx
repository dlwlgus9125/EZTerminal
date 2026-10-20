import { useEffect, useRef, useState } from 'react';

import type { ArtifactGrantResult, ArtifactPreviewKind } from '../../shared/artifact-preview';
import { Button, LoadingState, Status } from '../ui';
import { useResultsCopy } from './copy';

type FrameState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly url: string }
  | { readonly phase: 'error'; readonly error: Extract<ArtifactGrantResult, { ok: false }>['error'] | 'unavailable' };

export interface ArtifactPreviewAccess {
  readonly grant: (path: string, kind: ArtifactPreviewKind) => Promise<ArtifactGrantResult>;
  readonly revoke: (token: string) => Promise<void>;
}

/**
 * One AI-made HTML page or PDF, shown isolated: main serves it from a one-off
 * `ezartifact:` URL whose own policy sandboxes it (scripts only, no app, no
 * network, no navigation). The grant is returned as soon as the view closes.
 */
export function ArtifactFrame({ path, kind, title, access, reload = 0 }: {
  readonly path: string;
  readonly kind: ArtifactPreviewKind;
  readonly title: string;
  readonly access: ArtifactPreviewAccess;
  readonly reload?: number;
}): JSX.Element {
  const copy = useResultsCopy();
  const [state, setState] = useState<FrameState>({ phase: 'loading' });
  // A page that leaves its first document (a link, a script) cannot leave the preview, but it may
  // end on an error page: offer the way back. The frame's own location is not readable from here.
  const loads = useRef(0);
  const [navigated, setNavigated] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const backToPage = (): void => { loads.current = 0; setNavigated(false); setFrameKey((value) => value + 1); };
  const onLoad = (): void => { loads.current += 1; if (loads.current > 1) setNavigated(true); };
  useEffect(() => {
    let alive = true;
    let token: string | undefined;
    loads.current = 0;
    setNavigated(false);
    setState({ phase: 'loading' });
    void access.grant(path, kind).then((result) => {
      if (!alive) { if (result.ok) void access.revoke(result.token); return; }
      if (result.ok) { token = result.token; setState({ phase: 'ready', url: result.url }); }
      else setState({ phase: 'error', error: result.error });
    }).catch(() => { if (alive) setState({ phase: 'error', error: 'unavailable' }); });
    return () => {
      alive = false;
      if (token) void access.revoke(token);
    };
  }, [access, kind, path, reload]);

  if (state.phase === 'loading') return <LoadingState label={copy.fileLoading} />;
  if (state.phase === 'error') {
    const message = state.error === 'not-found' ? copy.fileGone : state.error === 'too-large' ? copy.previewTooLarge : copy.fileUnavailable;
    return <Status variant={state.error === 'not-found' ? 'warning' : 'neutral'}>{message}</Status>;
  }
  return (
    <div className="results-frame-wrap" data-kind={kind}>
      {kind === 'html' && <p className="results-note">{copy.isolatedNote}</p>}
      {kind === 'html' && navigated && (
        <div className="results-banner" role="status">
          <span>{copy.navigatedAway}</span>
          <Button variant="secondary" size="sm" onClick={backToPage} data-testid="results-artifact-back">{copy.backToPage}</Button>
        </div>
      )}
      {kind === 'html'
        ? <iframe key={frameKey} className="results-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" src={state.url} title={title} onLoad={onLoad} data-testid="results-artifact-frame" />
        : <iframe className="results-frame results-frame--pdf" referrerPolicy="no-referrer" src={state.url} title={title} data-testid="results-artifact-frame" />}
    </div>
  );
}
