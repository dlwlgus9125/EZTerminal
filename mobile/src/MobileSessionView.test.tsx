import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FilePreviewResult } from '../../src/shared/file-preview';
import type { TerminalFileLocationResult } from '../../src/shared/terminal-file-location';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import { MobileTerminalPathOverlay } from './MobileSessionView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/block-controller', () => ({ BlockController: class BlockController {} }));
vi.mock('../../src/renderer/Block', () => ({ Block: () => null }));

const ACTION: Extract<TerminalFileLocationResult, { ok: true }> = {
  ok: true,
  path: '/work/report.txt',
  capability: 'preview-capability',
  line: 2,
  column: 1,
};

const RESULT: FilePreviewResult = {
  ok: true,
  kind: 'text',
  name: 'report.txt',
  mime: 'text/plain',
  content: 'first line\nsecond line',
  truncated: false,
  fileSize: 22,
};

function Harness(): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [action, setAction] = useState<typeof ACTION | null>(null);
  const [preview, setPreview] = useState<{
    readonly path: string;
    readonly result: FilePreviewResult;
    readonly line?: number;
    readonly column?: number;
  } | null>(null);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setAction(ACTION)} data-testid="path-trigger">
        report.txt
      </button>
      <MobileTerminalPathOverlay
        action={action}
        preview={preview}
        returnFocusRef={triggerRef}
        onCloseAction={() => setAction(null)}
        onPreview={() => {
          setAction(null);
          setPreview({ path: ACTION.path, result: RESULT, line: ACTION.line, column: ACTION.column });
        }}
        onCopyError={vi.fn()}
        onClosePreview={() => setPreview(null)}
      />
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState({}, '');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(
    <MobileNavigationHistoryProvider>
      <Harness />
    </MobileNavigationHistoryProvider>,
  ));
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="path-trigger"]')!.click());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState({}, '');
});

describe('MobileSessionView terminal path overlays', () => {
  it('dismisses the path action sheet with Android Back and restores its invoker', async () => {
    const actionSheet = host.querySelector<HTMLElement>('[data-testid="terminal-path-action-sheet"]');
    expect(actionSheet?.getAttribute('role')).toBe('dialog');
    expect(actionSheet?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(host.querySelector('[data-testid="terminal-path-preview-action"]'));

    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(host.querySelector('[data-testid="terminal-path-action-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="path-trigger"]'));
  });

  it('reuses the sheet history marker for full-screen preview and closes preview first', async () => {
    const historyMarker = window.history.state?.ezterminalNavigation?.layerId;
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="terminal-path-preview-action"]')!.click());

    const preview = host.querySelector<HTMLElement>('[data-testid="terminal-path-preview"]');
    expect(preview?.classList.contains('mobile-action-sheet--fullscreen')).toBe(true);
    expect(preview?.textContent).toContain('second line');
    expect(window.history.state?.ezterminalNavigation?.layerId).toBe(historyMarker);
    expect(document.activeElement).toBe(host.querySelector('[data-testid="terminal-path-preview-back"]'));

    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(host.querySelector('[data-testid="terminal-path-preview"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="path-trigger"]'));
  });
});
