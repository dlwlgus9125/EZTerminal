// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentUsage } from '../shared/agent-usage';
import { StructuredAgentSessionPanel } from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60_000;
// Half a minute of slack so the 30-second clock never crosses a displayed minute.
const in2h10m = (): number => Date.now() + (2 * 60 + 10) * MINUTE + 30_000;
const in2d5h = (): number => Date.now() + ((2 * 24 + 5) * 60) * MINUTE + 30_000;

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode, locale: 'en' | 'ko' = 'en'): void {
  act(() => root.render(
    <AppI18nProvider locale={locale} languages={[locale]}>
      {node}
    </AppI18nProvider>,
  ));
}

function panel(usage: AgentUsage | undefined, overrides: { readonly state?: 'idle' | 'done'; readonly variant?: 'desktop' | 'mobile' } = {}): JSX.Element {
  return (
    <StructuredAgentSessionPanel
      sessionId="usage-session" title="Usage" providerId="claude" providerLabel="Claude"
      workspace={{ id: 'main', label: 'Main', kind: 'local' }} permissionPreset="standard" state={overrides.state ?? 'idle'}
      items={[]} onSend={async () => ({ ok: true })} onChangeSettings={async () => ({ ok: true })}
      usage={usage} variant={overrides.variant ?? 'desktop'}
    />
  );
}

const query = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('usage pill in the message box', () => {
  it('shows each limit and the context as a gauge beside the settings and opens the details', () => {
    render(panel({
      fiveHour: { usedPercent: 12, resetsAt: in2h10m() },
      weekly: { usedPercent: 74, resetsAt: in2d5h() },
      limitsObservedAt: Date.now() - 3 * MINUTE,
      contextPercent: 91,
    }));

    const pill = query('structured-agent-usage')!;
    expect(pill.closest('.structured-agent-session-settings')).not.toBeNull();
    expect(pill.getAttribute('aria-label')).toBe(
      'Claude usage: 5-hour limit 12% used (resets in 2h10m), weekly limit 74% used (resets in 2d5h), context 91% used',
    );
    expect(query('structured-agent-usage-fiveHour')?.dataset.level).toBe('normal');
    expect(query('structured-agent-usage-weekly')?.dataset.level).toBe('warning');
    expect(query('structured-agent-usage-context')?.dataset.level).toBe('danger');
    expect(query('structured-agent-usage-weekly')?.style.getPropertyValue('--chat-usage-percent')).toBe('74%');

    act(() => pill.click());
    const details = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Claude usage"]')!;
    const rows = [...details.querySelectorAll('.chat-usage__row')].map((row) => row.textContent);
    expect(rows).toEqual(['5-hour12%Resets in 2h10m', 'Weekly74%Resets in 2d5h', 'Context91%']);
    expect(details.querySelector('.chat-usage__updated')?.textContent).toBe('Updated 3m ago');
  });

  it('says it in Korean', () => {
    render(panel({ weekly: { usedPercent: 26, resetsAt: in2d5h() }, limitsObservedAt: Date.now(), contextPercent: 3 }), 'ko');
    expect(query('structured-agent-usage')?.getAttribute('aria-label')).toBe('Claude 사용량: 주간 한도 26% 사용(2d5h 후 초기화), 컨텍스트 3% 사용');
    act(() => query('structured-agent-usage')!.click());
    const rows = [...document.querySelectorAll('.chat-usage__row')].map((row) => row.textContent);
    expect(rows).toEqual(['주간26%2d5h 후 초기화', '컨텍스트3%']);
  });

  it('leaves out a window whose reset has passed, and the pill when nothing is left', () => {
    render(panel({
      fiveHour: { usedPercent: 99, resetsAt: Date.now() - MINUTE },
      weekly: { usedPercent: 26, resetsAt: in2d5h() },
      limitsObservedAt: 1,
    }));
    expect(query('structured-agent-usage-fiveHour')).toBeNull();
    expect(query('structured-agent-usage-weekly')).not.toBeNull();

    render(panel({ fiveHour: { usedPercent: 99, resetsAt: Date.now() - MINUTE }, limitsObservedAt: 1 }));
    expect(query('structured-agent-usage')).toBeNull();
  });

  it('shows nothing without a reading, and none in a read-only conversation', () => {
    render(panel(undefined));
    expect(query('structured-agent-usage')).toBeNull();
    render(panel({ contextPercent: 3 }, { state: 'done' }));
    expect(query('structured-agent-usage')).toBeNull();
  });

  it('shows the pill on the phone too', () => {
    render(panel({ contextPercent: 12, contextObservedAt: 1 }, { variant: 'mobile' }));
    expect(query('structured-agent-usage-context')).not.toBeNull();
  });
});
