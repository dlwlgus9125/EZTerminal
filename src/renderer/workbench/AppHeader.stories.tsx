import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { mergeEffectProfileToggles, type EffectProfileId, type ResolvedEffectProfileId } from '../effect-profiles';
import { applyEffects, type EffectId } from '../effects';
import { AppI18nProvider } from '../i18n';
import { AppHeader } from './AppHeader';
import '../index.css';
import './workbench.css';

interface AppHeaderStoryProps {
  readonly activeThemeEffects: readonly string[];
  readonly initialProfile: ResolvedEffectProfileId;
  readonly locale: 'en' | 'ko';
  readonly motionEffectsRequested: boolean;
}

const MATRIX_EFFECTS = ['scanlines', 'phosphor-glow', 'crt-rollbar', 'flicker'] as const;

function AppHeaderStory({
  activeThemeEffects,
  initialProfile,
  locale,
  motionEffectsRequested,
}: AppHeaderStoryProps): JSX.Element {
  const [profile, setProfile] = useState<ResolvedEffectProfileId>(initialProfile);
  const matrixTheme = document.documentElement.dataset.theme === 'matrix';
  useEffect(() => {
    if (!matrixTheme) {
      applyEffects(new Set());
      return;
    }
    const toggles =
      profile === 'custom'
        ? { scanlines: true }
        : mergeEffectProfileToggles({ effects: activeThemeEffects }, {}, profile);
    applyEffects(
      new Set(
        Object.entries(toggles)
          .filter(([, enabled]) => enabled)
          .map(([id]) => id as EffectId),
      ),
    );
    return () => applyEffects(new Set());
  }, [activeThemeEffects, matrixTheme, profile]);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <main lang={locale} style={{ minWidth: 0, width: '100vw' }}>
        <AppHeader
          activeThemeEffects={activeThemeEffects}
          attentionCount={3}
          commandCenterOpen={false}
          effectProfile={profile}
          motionEffectsRequested={motionEffectsRequested}
          onNewTerminal={() => undefined}
          onOpenAttention={() => undefined}
          onOpenCommandCenter={() => undefined}
          onOpenEffectSettings={() => undefined}
          onSelectEffectProfile={(next: EffectProfileId) => setProfile(next)}
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
    initialProfile: 'crt-signature',
    locale: 'en',
    motionEffectsRequested: true,
  },
} satisfies Meta<typeof AppHeaderStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CrtSignature: Story = {};

export const Korean: Story = {
  args: { locale: 'ko' },
  globals: { locale: 'ko' },
};

export const CustomProfile: Story = {
  args: { initialProfile: 'custom' },
};

export const EffectsUnavailable: Story = {
  args: {
    activeThemeEffects: [],
    initialProfile: 'clean',
    motionEffectsRequested: false,
  },
  globals: { theme: 'dark' },
};

export const ProfileMenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('btn-effect-profile'));
    await expect(canvas.getByRole('menu', { name: 'CRT effect profile' })).toBeVisible();
    await expect(canvas.getAllByRole('menuitemradio')).toHaveLength(4);
  },
};
