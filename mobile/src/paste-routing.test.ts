import { describe, expect, it } from 'vitest';

import { appendToComposer, resolvePasteTarget } from './paste-routing';

describe('resolvePasteTarget', () => {
  it('routes to the composer when there is no active controller', () => {
    expect(resolvePasteTarget(null)).toBe('composer');
  });

  it('routes to the pty for a running pty-shape block', () => {
    expect(resolvePasteTarget({ status: 'running', shape: 'pty' })).toBe('pty');
  });

  it('routes to the composer for a running non-pty block', () => {
    expect(resolvePasteTarget({ status: 'running', shape: 'text' })).toBe('composer');
  });

  it('routes to the composer once the block is no longer running', () => {
    expect(resolvePasteTarget({ status: 'done', shape: 'pty' })).toBe('composer');
  });
});

describe('appendToComposer', () => {
  it('appends verbatim to an empty draft', () => {
    expect(appendToComposer('', 'hello')).toBe('hello');
  });

  it('space-separates when the draft has no trailing whitespace', () => {
    expect(appendToComposer('echo', 'hello')).toBe('echo hello');
  });

  it('appends verbatim when the draft already ends in whitespace', () => {
    expect(appendToComposer('echo ', 'hello')).toBe('echo hello');
  });
});
