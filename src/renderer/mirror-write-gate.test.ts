import { describe, expect, it } from 'vitest';

import { MirrorWriteGate } from './mirror-write-gate';

describe('MirrorWriteGate (mirror auto-reply gate reconciliation)', () => {
  it('blocks while an armed write is in flight and unblocks on release', () => {
    const gate = new MirrorWriteGate();
    expect(gate.blocked).toBe(false);

    const release = gate.arm();
    expect(gate.blocked).toBe(true);

    release();
    expect(gate.blocked).toBe(false);
  });

  it('release is idempotent — a double flush cannot drive the count negative', () => {
    const gate = new MirrorWriteGate();
    const release = gate.arm();
    release();
    release();

    gate.arm();
    expect(gate.blocked).toBe(true); // a negative count would report false here
  });

  it('reset() unblocks a gate whose write callback never arrives (stranded flush)', () => {
    const gate = new MirrorWriteGate();
    gate.arm(); // release intentionally lost — xterm chain died mid-write

    expect(gate.blocked).toBe(true);
    gate.reset(); // pty replay reset: new stream generation
    expect(gate.blocked).toBe(false);
  });

  it('a pre-reset release is inert after reset() — it cannot disarm the new generation', () => {
    const gate = new MirrorWriteGate();
    const staleRelease = gate.arm();
    gate.reset();

    const releaseNext = gate.arm(); // new generation's own in-flight write
    staleRelease(); // late flush from the PRE-reset write finally lands
    expect(gate.blocked).toBe(true); // stale release must not have decremented

    releaseNext();
    expect(gate.blocked).toBe(false);
  });
});
