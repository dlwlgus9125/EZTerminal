import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from './i18n';
import { useReducedMotion } from './use-reduced-motion';

/** Milliseconds between init lines. Five lines plus the screen-open and beam
 * phases put the whole sequence just over three seconds. */
const LINE_INTERVAL_MS = 320;

const LINE_KEYS = [
  'bootIntro.linePty',
  'bootIntro.lineTheme',
  'bootIntro.lineAgents',
  'bootIntro.lineGateway',
  'bootIntro.lineSessions',
] as const;

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
export function BootIntroOverlay(): JSX.Element | null {
  const { t } = useAppTranslation();
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('unknown');
  const [visibleLines, setVisibleLines] = useState(0);
  // Latched when the preference has actually been answered — not when a read
  // was merely started. Guarding on "started" instead would strand the overlay
  // under StrictMode, whose simulated remount cancels the first read's callback
  // and would then skip issuing a second one, leaving phase at 'unknown'
  // forever. Latching on the answer also means toggling the setting takes
  // effect next launch rather than starting an intro over a workbench in use.
  const resolvedRef = useRef(false);

  useEffect(() => {
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
  }, [reducedMotion]);

  useEffect(() => {
    if (phase !== 'playing') return;
    const timers: number[] = [];
    for (let index = 0; index < LINE_KEYS.length; index += 1) {
      timers.push(
        window.setTimeout(() => setVisibleLines(index + 1), 1500 + index * LINE_INTERVAL_MS),
      );
    }
    timers.push(
      window.setTimeout(() => setPhase('done'), 1500 + LINE_KEYS.length * LINE_INTERVAL_MS + 400),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [phase]);

  const skip = useCallback(() => setPhase('done'), []);

  useEffect(() => {
    if (phase !== 'playing') return;
    const onKeyDown = (): void => skip();
    document.addEventListener('keydown', onKeyDown, { once: true });
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [phase, skip]);

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
