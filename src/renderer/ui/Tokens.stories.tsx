import type { CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './index';

const meta = {
  title: 'Foundations/Tokens',
  parameters: {
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const THEMES = [
  { id: 'matrix', label: 'Matrix' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'high-contrast', label: 'High contrast' },
] as const;

const COLOUR_TOKENS = [
  '--ui-canvas',
  '--ui-surface',
  '--ui-surface-raised',
  '--ui-surface-inset',
  '--ui-text-primary',
  '--ui-text-secondary',
  '--ui-text-muted',
  '--ui-border-subtle',
  '--ui-border-strong',
  '--ui-accent',
  '--ui-focus',
  '--ui-info',
  '--ui-success',
  '--ui-warning',
  '--ui-danger',
] as const;

function ThemeCard({ id, label }: { readonly id: string; readonly label: string }): JSX.Element {
  return (
    <section className="ez-story-theme-card" data-theme={id} aria-labelledby={`theme-${id}`}>
      <h2 id={`theme-${id}`} className="ez-story-heading">{label}</h2>
      <div className="ez-story-swatches">
        {COLOUR_TOKENS.map((token) => (
          <div key={token} className="ez-story-swatch">
            <span
              className="ez-story-swatch__colour"
              style={{ backgroundColor: `var(${token})` }}
              aria-hidden="true"
            />
            <code>{token}</code>
          </div>
        ))}
      </div>
      <div className="ez-story-row">
        <Button variant="primary">Primary action</Button>
        <Button variant="secondary">Secondary action</Button>
        <Button variant="danger">Danger action</Button>
      </div>
    </section>
  );
}

export const ThemeGallery: Story = {
  render: () => (
    <main className="ez-story-token-page">
      <div className="ez-story-stack" style={{ inlineSize: 'auto' }}>
        <header>
          <h1 className="ez-story-heading">Semantic theme gallery</h1>
          <p className="ez-story-note">Every primitive consumes these roles rather than palette-specific colours.</p>
        </header>
        <div className="ez-story-grid ez-story-theme-gallery">
          {THEMES.map((theme) => <ThemeCard key={theme.id} {...theme} />)}
        </div>
      </div>
    </main>
  ),
};

const TYPE_SCALE = [
  ['12 / xs', '--ui-font-size-xs'],
  ['13 / sm', '--ui-font-size-sm'],
  ['14 / md', '--ui-font-size-md'],
  ['16 / lg', '--ui-font-size-lg'],
  ['20 / xl', '--ui-font-size-xl'],
] as const;

const SPACE_SCALE = [
  ['4', '--ui-space-1'],
  ['8', '--ui-space-2'],
  ['12', '--ui-space-3'],
  ['16', '--ui-space-4'],
  ['24', '--ui-space-6'],
  ['32', '--ui-space-8'],
] as const;

export const Scales: Story = {
  render: () => (
    <main className="ez-story-token-page">
      <div className="ez-story-grid">
        <section className="ez-story-section">
          <h2 className="ez-story-heading">Typography</h2>
          {TYPE_SCALE.map(([label, token]) => (
            <div key={token} className="ez-story-scale-row">
              <code>{label}</code>
              <span style={{ fontSize: `var(${token})` }}>Readable terminal UI / 읽기 쉬운 터미널 UI</span>
            </div>
          ))}
        </section>
        <section className="ez-story-section">
          <h2 className="ez-story-heading">Spacing</h2>
          {SPACE_SCALE.map(([label, token]) => (
            <div key={token} className="ez-story-scale-row">
              <code>{label} px</code>
              <span
                className="ez-story-space-sample"
                style={{ inlineSize: `var(${token})` } as CSSProperties}
                aria-hidden="true"
              />
            </div>
          ))}
        </section>
        <section className="ez-story-section">
          <h2 className="ez-story-heading">Radius</h2>
          <div className="ez-story-row">
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <span
                key={size}
                style={{
                  background: 'var(--ui-accent-muted)',
                  border: '1px solid var(--ui-accent)',
                  borderRadius: `var(--ui-radius-${size})`,
                  padding: 'var(--ui-space-4)',
                }}
              >
                {size}
              </span>
            ))}
          </div>
        </section>
        <section className="ez-story-section">
          <h2 className="ez-story-heading">Control density</h2>
          <div className="ez-story-row">
            <Button size="sm">32 px</Button>
            <Button size="md">32 px</Button>
            <Button size="lg">40 px</Button>
          </div>
          <p className="ez-story-note">Coarse pointers raise every control to a 44 px touch target.</p>
        </section>
      </div>
    </main>
  ),
};
