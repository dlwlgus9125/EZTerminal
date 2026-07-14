import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mobileTerminalPanelId, mobileTerminalTabId, TabStrip } from './TabStrip';
import type { Tab } from './tabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TABS: readonly Tab[] = [
  { sessionId: 'session-1', cwd: '/work/one' },
  { sessionId: 'session-2', cwd: '/work/two' },
];

function Harness(): JSX.Element {
  const [active, setActive] = useState(TABS[0]!.sessionId);
  return (
    <>
      <TabStrip tabs={TABS} activeSessionId={active} onActivate={setActive} onClose={vi.fn()} />
      {TABS.map((tab) => (
        <div
          key={tab.sessionId}
          id={mobileTerminalPanelId(tab.sessionId)}
          role="tabpanel"
          aria-labelledby={mobileTerminalTabId(tab.sessionId)}
          hidden={tab.sessionId !== active}
        />
      ))}
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('TabStrip accessibility', () => {
  it('links tabs to terminal panels and exposes one selected tab stop', () => {
    const tablist = host.querySelector('[role="tablist"]');
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    expect(tablist?.getAttribute('aria-label')).toBe('Sessions');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.tabIndex).toBe(0);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
    expect(tabs[1]?.tabIndex).toBe(-1);
    expect(document.getElementById(tabs[0]!.getAttribute('aria-controls')!)).not.toBeNull();
  });

  it('moves and activates tabs with Arrow keys and Home/End', () => {
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0]!.focus();

    act(() => tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');

    act(() => tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  });
});
