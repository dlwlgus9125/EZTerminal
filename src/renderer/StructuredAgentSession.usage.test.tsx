// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentUsage } from '../shared/agent-usage';
import { StructuredAgentComposer } from './StructuredAgentSession';
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

function composer(usage: AgentUsage | undefined, variant: 'desktop' | 'mobile' = 'desktop'): JSX.Element {
  return <StructuredAgentComposer busy={false} usage={usage} variant={variant} onSend={async () => ({ ok: true })} />;
}

const query = (testId: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

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

describe('usage under the message box', () => {
  it('shows the plan windows and context like the CLI HUD, next to the unchanged hint', () => {
    render(composer({
      fiveHour: { usedPercent: 12, resetsAt: in2h10m() },
      weekly: { usedPercent: 26, resetsAt: in2d5h() },
      contextPercent: 34,
      observedAt: Date.now(),
    }));

    expect(query('structured-agent-composer-hint')?.textContent).toBe('Enter to send · Shift+Enter for a new line');
    expect(query('structured-agent-usage-fiveHour')?.textContent).toBe('5h 12% · 2h10m');
    expect(query('structured-agent-usage-weekly')?.textContent).toBe('wk 26% · 2d5h');
    expect(query('structured-agent-usage-context')?.textContent).toBe('ctx 34%');
    const readout = query('structured-agent-usage')!;
    const sentence = 'Usage: 5-hour limit 12% used (resets in 2h10m), weekly limit 26% used (resets in 2d5h), context 34% used';
    expect(readout.title).toBe(sentence);
    expect(readout.querySelector('.ez-ui-visually-hidden')?.textContent).toBe(sentence);
    // A countdown must not be announced and is not a stop on the keyboard path.
    expect(readout.closest('[aria-live]')).toBeNull();
    expect(readout.querySelector('[tabindex]')).toBeNull();
  });

  it('says it in Korean', () => {
    render(composer({ weekly: { usedPercent: 26, resetsAt: in2d5h() }, contextPercent: 3, observedAt: Date.now() }), 'ko');
    expect(query('structured-agent-usage-weekly')?.textContent).toBe('주간 26% · 2d5h');
    expect(query('structured-agent-usage')?.title).toBe('사용량: 주간 한도 26% 사용(2d5h 후 초기화), 컨텍스트 3% 사용');
  });

  it('warns from 70% and alarms from 90% like the CLI HUD', () => {
    render(composer({ fiveHour: { usedPercent: 69 }, weekly: { usedPercent: 70 }, contextPercent: 90, observedAt: 1 }));
    expect(query('structured-agent-usage-fiveHour')?.dataset.level).toBe('normal');
    expect(query('structured-agent-usage-weekly')?.dataset.level).toBe('warning');
    expect(query('structured-agent-usage-context')?.dataset.level).toBe('danger');
    render(composer({ contextPercent: 89, observedAt: 1 }));
    expect(query('structured-agent-usage-context')?.dataset.level).toBe('warning');
  });

  it('hides a window whose reset has passed, and the whole line when nothing is left', () => {
    render(composer({
      fiveHour: { usedPercent: 99, resetsAt: Date.now() - MINUTE },
      weekly: { usedPercent: 26, resetsAt: in2d5h() },
      observedAt: 1,
    }));
    expect(query('structured-agent-usage-fiveHour')).toBeNull();
    expect(query('structured-agent-usage-weekly')).not.toBeNull();

    render(composer({ fiveHour: { usedPercent: 99, resetsAt: Date.now() - MINUTE }, observedAt: 1 }, 'mobile'));
    expect(query('structured-agent-usage')).toBeNull();
    // An empty row takes no space (`:empty` in CSS).
    expect(container.querySelector('.structured-agent-composer__status')?.childNodes.length ?? 0).toBe(0);
  });

  it('shows usage alone on the phone, where the box has no shortcut hint', () => {
    render(composer({ contextPercent: 12, observedAt: 1 }, 'mobile'));
    expect(query('structured-agent-composer-hint')).toBeNull();
    expect(query('structured-agent-usage-context')?.textContent).toBe('ctx 12%');
  });

  it('shows nothing before the conversation has replied', () => {
    render(composer(undefined));
    expect(query('structured-agent-usage')).toBeNull();
    expect(query('structured-agent-composer-hint')).not.toBeNull();
  });
});
