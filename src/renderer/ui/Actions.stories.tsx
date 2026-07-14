import { Copy, Play, Plus, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button, IconButton, SplitButton } from './index';

const meta = {
  title: 'Primitives/Actions',
  component: Button,
  parameters: {
    a11y: { test: 'error' },
  },
  args: {
    children: 'Run command',
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="ez-story-stack">
      <section className="ez-story-section">
        <h2 className="ez-story-heading">Variants</h2>
        <div className="ez-story-row">
          <Button variant="primary" leadingIcon={<Play />}>Primary</Button>
          <Button variant="secondary" leadingIcon={<Plus />}>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" leadingIcon={<Trash2 />}>Danger</Button>
        </div>
      </section>
      <section className="ez-story-section">
        <h2 className="ez-story-heading">Sizes</h2>
        <div className="ez-story-row">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </div>
      </section>
    </div>
  ),
};

export const DisabledAndLoading: Story = {
  render: () => (
    <div className="ez-story-row">
      <Button variant="primary" disabled>Disabled</Button>
      <Button variant="secondary" loading loadingLabel="Saving command">Save command</Button>
      <IconButton icon={Settings} aria-label="Settings unavailable" disabled />
      <IconButton icon={Copy} aria-label="Copying output" loading loadingLabel="Copying" />
    </div>
  ),
};

export const IconButtons: Story = {
  render: () => (
    <div className="ez-story-row">
      <IconButton icon={Plus} aria-label="New terminal" variant="primary" />
      <IconButton icon={Copy} aria-label="Copy output" variant="secondary" />
      <IconButton icon={Settings} aria-label="Open settings" variant="ghost" />
      <IconButton icon={Trash2} aria-label="Delete preset" variant="danger" />
    </div>
  ),
};

function SplitButtonExample(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="ez-story-split-anchor">
      <SplitButton
        variant="primary"
        menuOpen={open}
        onMenuOpenChange={setOpen}
        menuLabel="Choose run mode"
        menuControls="run-mode-menu"
        onClick={() => undefined}
        leadingIcon={<Play />}
      >
        Run
      </SplitButton>
      {open && (
        <div id="run-mode-menu" className="ez-story-split-menu" role="menu" aria-label="Run mode">
          <button type="button" role="menuitem" onClick={() => setOpen(false)}>Run in terminal</button>
          <button type="button" role="menuitem" onClick={() => setOpen(false)}>Run in new pane</button>
        </div>
      )}
    </div>
  );
}

export const SplitAction: Story = {
  render: () => <SplitButtonExample />,
};
