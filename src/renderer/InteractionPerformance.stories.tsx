import { useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { AgentResumeComposer } from './AgentResumeComposer';
import { AppI18nProvider } from './i18n';
import { ProgressiveSafeMarkdown } from './ProgressiveSafeMarkdown';
import '../../mobile/src/mobile.css';

const HEAVY_MARKDOWN = [
  '## Recorded work',
  '',
  ...Array.from({ length: 80 }, (_, index) => (
    `- item ${index}: \`src/renderer/interaction-${index}.tsx\` stayed ordered during resume.`
  )),
].join('\n');

function HeavyTranscript({ mobile }: { readonly mobile: boolean }): JSX.Element {
  const renders = useRef(0);
  renders.current += 1;
  return (
    <div
      className={mobile ? 'mob-agent-history-transcript' : 'agent-history-terminal__scroll'}
      data-testid="interaction-heavy-transcript"
      data-render-count={renders.current}
    >
      {Array.from({ length: 20 }, (_, index) => (
        <ProgressiveSafeMarkdown
          key={index}
          markdown={HEAVY_MARKDOWN}
          priority={index}
          className={mobile ? 'mob-agent-history-markdown' : 'agent-history-terminal__markdown'}
        />
      ))}
    </div>
  );
}

function InteractionFixture({ mobile }: { readonly mobile: boolean }): JSX.Element {
  return (
    <AppI18nProvider locale="en" languages={['en']}>
      <main
        className={mobile ? 'mob-agent-history-shell' : 'pane agent-history-terminal'}
        style={{ height: mobile ? 720 : 640, maxWidth: mobile ? 412 : 960 }}
      >
        <HeavyTranscript mobile={mobile} />
        <AgentResumeComposer
          variant={mobile ? 'mobile' : 'desktop'}
          preparing={false}
          onSubmit={() => undefined}
        />
      </main>
    </AppI18nProvider>
  );
}

async function verifyInteractionBudget(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const input = canvas.getByRole('textbox');
  const transcript = canvas.getByTestId('interaction-heavy-transcript');
  const initialRenders = transcript.getAttribute('data-render-count');
  const feedback: number[] = [];
  const longTasks: number[] = [];
  const observer = PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver((entries) => {
        longTasks.push(...entries.getEntries().map((entry) => entry.duration));
      })
    : null;
  observer?.observe({ type: 'longtask' });
  input.addEventListener('input', () => {
    const startedAt = performance.now();
    requestAnimationFrame(() => feedback.push(performance.now() - startedAt));
  });

  await userEvent.type(input, 'responsive-interaction-sample-01');
  await waitFor(() => expect(feedback.length).toBeGreaterThanOrEqual(30));
  observer?.disconnect();

  const sorted = [...feedback].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  expect(p95).toBeLessThanOrEqual(50);
  expect(longTasks.filter((duration) => duration > 50)).toHaveLength(0);
  expect(transcript.getAttribute('data-render-count')).toBe(initialRenders);
}

const meta = {
  title: 'Diagnostics/Interaction responsiveness',
  component: InteractionFixture,
  parameters: {
    layout: 'fullscreen',
    a11y: { test: 'error' },
  },
  args: { mobile: false },
} satisfies Meta<typeof InteractionFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopResumeTyping: Story = {
  play: ({ canvasElement }) => verifyInteractionBudget(canvasElement),
};

export const MobileResumeTyping: Story = {
  args: { mobile: true },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  play: ({ canvasElement }) => verifyInteractionBudget(canvasElement),
};
