import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Button, Field, Input, Select, Switch } from './index';

const meta = {
  title: 'Primitives/Forms',
  component: Field,
  parameters: {
    a11y: { test: 'error' },
  },
  args: {
    label: 'Field',
  },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="ez-story-stack">
      <Field label="Host" description="Hostname or IP address" required>
        <Input placeholder="terminal.example.com" />
      </Field>
      <Field label="Shell profile">
        <Select defaultValue="powershell">
          <option value="powershell">PowerShell</option>
          <option value="cmd">Command Prompt</option>
          <option value="wsl">WSL</option>
        </Select>
      </Field>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="ez-story-stack">
      <Field label="Small input"><Input uiSize="sm" defaultValue="32 px" /></Field>
      <Field label="Medium input"><Input uiSize="md" defaultValue="32 px" /></Field>
      <Field label="Large input"><Input uiSize="lg" defaultValue="40 px" /></Field>
    </div>
  ),
};

export const ValidationAndDisabled: Story = {
  render: () => (
    <div className="ez-story-stack">
      <Field label="Port" error="Enter a port from 1 to 65535" required>
        <Input inputMode="numeric" defaultValue="70000" />
      </Field>
      <Field label="Managed endpoint" description="This value is controlled by your administrator" disabled>
        <Input defaultValue="127.0.0.1" />
      </Field>
      <Field label="Unavailable renderer" disabled>
        <Select defaultValue="webgl">
          <option value="webgl">WebGL</option>
        </Select>
      </Field>
    </div>
  ),
};

function SwitchExamples(): JSX.Element {
  const [scanlines, setScanlines] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  return (
    <div className="ez-story-stack">
      <Switch
        label="CRT scanlines"
        description="Adds a static phosphor-line texture"
        checked={scanlines}
        onChange={(event) => setScanlines(event.currentTarget.checked)}
      />
      <Switch
        label="Confirm risky pane close"
        checked={confirmClose}
        onChange={(event) => setConfirmClose(event.currentTarget.checked)}
      />
      <Switch label="Managed setting" description="Unavailable for this workspace" disabled />
    </div>
  );
}

export const SwitchStates: Story = {
  render: () => <SwitchExamples />,
};

export const KeyboardPath: Story = {
  render: () => (
    <form className="ez-story-stack" onSubmit={(event) => event.preventDefault()}>
      <Field label="Command name"><Input placeholder="Build client" /></Field>
      <Field label="Category">
        <Select defaultValue="build">
          <option value="build">Build</option>
          <option value="test">Test</option>
        </Select>
      </Field>
      <Switch label="Pin command" />
      <Button type="submit" variant="primary">Save</Button>
    </form>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByLabelText('Command name')).toHaveFocus();
    await userEvent.keyboard('pnpm build');
    await userEvent.tab();
    await expect(canvas.getByLabelText('Category')).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('switch', { name: 'Pin command' })).toHaveFocus();
  },
};
