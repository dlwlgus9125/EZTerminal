import { useSyncExternalStore } from 'react';

import type { BlockController } from '../../src/renderer/block-controller';

const KEYS: ReadonlyArray<{ readonly label: string; readonly bytes: string }> = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: 'Ctrl+C', bytes: '\x03' },
  { label: 'Ctrl+D', bytes: '\x04' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
  { label: '←', bytes: '\x1b[D' },
  { label: '→', bytes: '\x1b[C' },
];

// Stable fallbacks (module-level, not recreated per render) for when there is
// no active controller — keeps useSyncExternalStore's subscribe reference
// stable across renders instead of resubscribing every time.
const noopSubscribe = (): (() => void) => () => undefined;
const nullSnapshot = (): null => null;

// TouchInputBar — special keys a touch/software keyboard can't send directly
// (Esc/Tab/Ctrl-C/Ctrl-D/arrows), forwarded to the active block's PTY child.
// Mobile-only (no desktop analogue — a physical keyboard sends these
// natively). Only meaningful for a RUNNING `pty`-shape block; renders nothing
// otherwise so it never occupies space above an idle prompt.
export function TouchInputBar({
  controller,
}: {
  controller: BlockController | null;
}): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? nullSnapshot,
  );

  if (!controller || !snapshot || snapshot.shape !== 'pty' || snapshot.status !== 'running') {
    return null;
  }

  return (
    <div className="touch-input-bar" data-testid="touch-input-bar">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          className="btn touch-key"
          onClick={() => controller.sendPtyInput(k.bytes)}
          data-testid={`touch-key-${k.label}`}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
