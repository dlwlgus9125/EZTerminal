// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from './i18n';
import {
  addProjectQuestionReference,
  ProjectQuestionComposer,
} from './ProjectQuestionComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let ezterminalDescriptor: PropertyDescriptor | undefined;
let desktopDescriptor: PropertyDescriptor | undefined;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  ezterminalDescriptor = Object.getOwnPropertyDescriptor(window, 'ezterminal');
  desktopDescriptor = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (ezterminalDescriptor) Object.defineProperty(window, 'ezterminal', ezterminalDescriptor);
  else Reflect.deleteProperty(window, 'ezterminal');
  if (desktopDescriptor) Object.defineProperty(window, 'ezterminalDesktop', desktopDescriptor);
  else Reflect.deleteProperty(window, 'ezterminalDesktop');
  vi.restoreAllMocks();
});

describe('ProjectQuestionComposer', () => {
  it('keeps a reference local until an explicit, freshly validated send to a waiting session', async () => {
    const sendAgentFollowup = vi.fn(async () => ({ ok: true as const }));
    const validateProjectText = vi.fn(async () => ({
      ok: true as const,
      currentVersion: 'a'.repeat(64),
      lineCount: 4,
      sensitive: false,
    }));
    const activity = {
      id: 'activity-1',
      sessionId: 'session-1',
      provider: 'codex' as const,
      cwd: 'C:\\Project',
      status: 'waiting' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        onAgentActivitySnapshot: (listener: (value: unknown) => void) => {
          listener({ revision: 1, items: [activity] });
          return vi.fn();
        },
        getAgentActivitySnapshot: vi.fn(async () => ({ revision: 1, items: [activity] })),
        sendAgentFollowup,
      } as unknown as typeof window.ezterminal,
    });
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        describeProjectWorkspace: vi.fn(async () => ({
          ok: true as const,
          project: {
            projectId: 'project-1',
            name: 'Project',
            roots: [{ rootId: 'root-1', name: 'Project', displayPath: 'C:\\Project', primary: true }],
          },
        })),
        validateProjectText,
      } as unknown as typeof window.ezterminalDesktop,
    });

    expect(addProjectQuestionReference({
      projectId: 'project-1',
      rootId: 'root-1',
      relativePath: 'src/app.ts',
      version: 'a'.repeat(64),
      startLine: 2,
      endLine: 3,
      snippet: 'const one = 1;\nconst two = 2;',
      sensitive: false,
    })).toBe(true);

    act(() => {
      root.render(<AppI18nProvider><ProjectQuestionComposer /></AppI18nProvider>);
    });
    await flush();
    expect(sendAgentFollowup).not.toHaveBeenCalled();

    const destination = container.querySelector<HTMLSelectElement>('select')!;
    act(() => {
      destination.value = activity.id;
      destination.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const question = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const setTextAreaValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setTextAreaValue.call(question, 'Why did this change?');
      question.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Send when waiting');
    expect(send).toBeDefined();
    act(() => send!.click());
    await flush();
    await flush();

    expect(validateProjectText).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: 'src/app.ts',
      version: 'a'.repeat(64),
      startLine: 2,
      endLine: 3,
    }));
    expect(sendAgentFollowup).toHaveBeenCalledOnce();
    expect(sendAgentFollowup).toHaveBeenCalledWith(
      activity.id,
      'Why did this change? @./src/app.ts:L2-L3 snippet="const one = 1;\\nconst two = 2;"',
    );
    expect(container.querySelector('[data-testid="project-question-composer"]')).toBeNull();
  });
});
