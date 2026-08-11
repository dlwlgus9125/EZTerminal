import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { applyEffects, type EffectId } from '../effects';
import { AppI18nProvider } from '../i18n';
import { AppHeader } from './AppHeader';
import '../index.css';
import './workbench.css';

interface AppHeaderStoryProps {
  readonly activeThemeEffects: readonly string[];
  readonly initialIntensity: number;
  readonly locale: 'en' | 'ko';
}

const MATRIX_EFFECTS = ['scanlines', 'phosphor-glow', 'crt-rollbar', 'flicker'] as const;

function AppHeaderStory({
  activeThemeEffects,
  initialIntensity,
  locale,
}: AppHeaderStoryProps): JSX.Element {
  const [intensity] = useState(initialIntensity);
  const matrixTheme = document.documentElement.dataset.theme === 'matrix';
  useEffect(() => {
    if (!matrixTheme) {
      applyEffects(new Set());
      return;
    }
    applyEffects(
      new Set(
        activeThemeEffects.map((id) => id as EffectId),
      ),
    );
    return () => applyEffects(new Set());
  }, [activeThemeEffects, matrixTheme]);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <main lang={locale} style={{ minWidth: 0, width: '100vw' }}>
        <AppHeader
          // Pinned rather than read from the runtime so the version chip cannot
          // make a screenshot depend on which build produced it.
          appVersion="1.0.33"
          attentionCount={3}
          commandCenterOpen={false}
          effectIntensity={intensity}
          onNewTerminal={() => undefined}
          onOpenAttention={() => undefined}
          onOpenCommandCenter={() => undefined}
          onOpenEffectSettings={() => undefined}
          onWorkspaceOpenChange={() => undefined}
          workspaceOpen={false}
        />
      </main>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/App header',
  component: AppHeaderStory,
  parameters: {
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
  args: {
    activeThemeEffects: MATRIX_EFFECTS,
    initialIntensity: 7,
    locale: 'en',
  },
} satisfies Meta<typeof AppHeaderStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CrtSignature: Story = {};

export const Korean: Story = {
  args: { locale: 'ko' },
  globals: { locale: 'ko' },
};

export const EffectsOff: Story = {
  args: { initialIntensity: 0 },
};

export const EffectsUnavailable: Story = {
  args: {
    activeThemeEffects: [],
    initialIntensity: 0,
  },
  globals: { theme: 'dark' },
};

export const ProfileMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByTestId('btn-effect-profile');
    await expect(button).toHaveAttribute('data-effect-intensity', '7');
    await userEvent.click(button);
  },
};
