import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from './i18n';
import { useNativeOverlayRegistration } from './native-overlay';
import { useReducedMotion } from './use-reduced-motion';

/** Milliseconds between init lines. */
const LINE_INTERVAL_MS = 320;
/** The first log line lands exactly as the beam finishes (`boot-beam 1s`
 * delayed 0.4s in index.css), so the two never overlap. */
const LOG_START_MS = 1400;
/** Last line to hand-off. Short: by then the sequence has said everything. */
const LOG_TAIL_MS = 200;

const LINE_KEYS = [
  'bootIntro.linePty',
  'bootIntro.lineTheme',
  'bootIntro.lineAgents',
  'bootIntro.lineGateway',
  'bootIntro.lineSessions',
] as const;

/** ~3.2s end to end, per the handoff's motion table. Defined after LINE_KEYS
 * so the count is the list, never a number that can drift from it. */
export const BOOT_INTRO_TOTAL_MS = LOG_START_MS + LINE_KEYS.length * LINE_INTERVAL_MS + LOG_TAIL_MS;

type Phase = 'unknown' | 'playing' | 'done';

/**
 * CRT power-on sequence layered over the workbench.
 *
 * It is purely additive: the app mounts, paints, and becomes interactive
 * underneath regardless of what this does. The overlay renders nothing until
 * the stored preference has been read, so a user who turned it off never sees
 * a flash of it, and reduced motion skips it outright rather than replaying it
 * at zero duration — a sequence whose whole content is timing has nothing left
 * to show once the timing is removed.
 */
export function BootIntroOverlay({ preview = false }: { readonly preview?: boolean } = {}): JSX.Element | null {
  const { t } = useAppTranslation();
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(preview ? 'playing' : 'unknown');
  const [visibleLines, setVisibleLines] = useState(preview ? LINE_KEYS.length : 0);
  useNativeOverlayRegistration(phase === 'playing');
  // Latched when the preference has actually been answered — not when a read
  // was merely started. Guarding on "started" instead would strand the overlay
  // under StrictMode, whose simulated remount cancels the first read's callback
  // and would then skip issuing a second one, leaving phase at 'unknown'
  // forever. Latching on the answer also means toggling the setting takes
  // effect next launch rather than starting an intro over a workbench in use.
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (preview) return;
    if (resolvedRef.current) return;
    const settle = (next: Phase): void => {
      resolvedRef.current = true;
      setPhase(next);
    };
    if (reducedMotion) {
      settle('done');
      return;
    }
    const desktop = window.ezterminalDesktop;
    if (!desktop?.getBootIntro) {
      settle('done');
      return;
    }
    let alive = true;
    void desktop.getBootIntro().then(
      (enabled) => {
        if (alive) settle(enabled ? 'playing' : 'done');
      },
      () => {
        if (alive) settle('done');
      },
    );
    return () => {
      alive = false;
    };
  }, [preview, reducedMotion]);

  useEffect(() => {
    if (preview) return;
    if (phase !== 'playing') return;
    const timers: number[] = [];
    for (let index = 0; index < LINE_KEYS.length; index += 1) {
      timers.push(
        window.setTimeout(() => setVisibleLines(index + 1), LOG_START_MS + index * LINE_INTERVAL_MS),
      );
    }
    timers.push(window.setTimeout(() => setPhase('done'), BOOT_INTRO_TOTAL_MS));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [phase, preview]);

  const skip = useCallback(() => setPhase('done'), []);

  useEffect(() => {
    if (preview) return;
    if (phase !== 'playing') return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      // The key is the user's explicit "skip" command. Consume it in capture
      // phase so it can never become a composer draft or PTY/readline input
      // while the workbench is still visually covered.
      event.preventDefault();
      event.stopImmediatePropagation();
      skip();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true, once: true });
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [phase, preview, skip]);

  if (phase !== 'playing') return null;

  return (
    <div
      className="boot-intro"
      data-testid="boot-intro"
      // aria-hidden with no focusable content: the workbench underneath is
      // already mounted and announced, and assistive technology should not be
      // made to sit through a decoration.
      aria-hidden="true"
      onClick={skip}
    >
      <div className="boot-intro-screen">
        <span className="boot-intro-beam" />
        <div className="boot-intro-brand">
          <span className="boot-intro-signal">
            <i />
            <i />
            <i />
          </span>
          <span className="boot-intro-wordmark">EZTerminal</span>
        </div>
        <ol className="boot-intro-log">
          {LINE_KEYS.slice(0, visibleLines).map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ol>
        <p className="boot-intro-skip">{t('bootIntro.skip')}</p>
      </div>
    </div>
  );
}
