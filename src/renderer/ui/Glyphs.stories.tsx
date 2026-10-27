import type { Meta, StoryObj } from '@storybook/react-vite';

import { GLYPH_NAMES, Glyph, IconButton, Led, glyphIcon } from './index';

const meta = {
  title: 'Primitives/Glyphs',
  parameters: {
    a11y: { test: 'error' },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every stencil glyph at the two sizes the shell uses, with its name. */
export const Gallery: Story = {
  render: () => (
    <div className="ez-story-stack">
      <section className="ez-story-section">
        <h2 className="ez-story-heading">Glyphs</h2>
        <ul className="ez-story-glyphs" data-testid="glyph-gallery">
          {GLYPH_NAMES.map((name) => (
            <li key={name} className="ez-story-glyph" data-glyph={name}>
              <Glyph name={name} size={20} />
              <Glyph name={name} size={16} />
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </section>
      <section className="ez-story-section">
        <h2 className="ez-story-heading">In icon buttons</h2>
        <div className="ez-story-row">
          <IconButton icon={glyphIcon('back')} aria-label="Back" />
          <IconButton icon={glyphIcon('plus')} aria-label="New terminal" variant="primary" />
          <IconButton icon={glyphIcon('refresh')} aria-label="Refresh" variant="secondary" />
          <IconButton icon={glyphIcon('trash')} aria-label="Delete" variant="danger" />
          <IconButton icon={glyphIcon('more')} aria-label="More" />
        </div>
      </section>
      <section className="ez-story-section">
        <h2 className="ez-story-heading">Lamps</h2>
        <div className="ez-story-row">
          {(['on', 'amber', 'red', 'ok', 'idle'] as const).map((tone) => (
            <span key={tone} className="ez-story-glyph"><Led tone={tone} /><code>{tone}</code></span>
          ))}
        </div>
      </section>
    </div>
  ),
};
