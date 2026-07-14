import { RefreshCw, Settings } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ActionSheet, Badge, Button, Dialog, PanelShell, Status, Switch } from './index';

const meta = {
  title: 'Primitives/Dialogs and panels',
  component: Dialog,
  parameters: {
    a11y: { test: 'error' },
  },
  args: {
    open: false,
    onOpenChange: () => undefined,
    title: 'Dialog',
    children: null,
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function DialogLauncher(): JSX.Element {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>Delete preset</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        role="alertdialog"
        title="Delete preset?"
        description="The preset will be removed from this device."
        initialFocusRef={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setOpen(false)}>Delete</Button>
          </>
        }
      >
        <Status variant="warning">This action cannot be undone.</Status>
      </Dialog>
    </>
  );
}

export const DialogInteraction: Story = {
  render: () => <DialogLauncher />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete preset' }));
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await waitFor(() => expect(page.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await expect(page.queryByRole('alertdialog')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Delete preset' })).toHaveFocus();
  },
};

function OpenDialog(): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Terminal settings"
      description="Changes apply to new and existing panes."
      footer={<Button variant="primary" onClick={() => setOpen(false)}>Done</Button>}
    >
      <div className="ez-story-stack" style={{ inlineSize: 'auto' }}>
        <Switch label="Confirm risky pane close" defaultChecked />
        <Switch label="Allow OSC 52 clipboard" />
      </div>
    </Dialog>
  );
}

export const DialogOpen: Story = {
  render: () => <OpenDialog />,
};

function OpenActionSheet(): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <ActionSheet
      open={open}
      onOpenChange={setOpen}
      title="Session actions"
      description="Choose an action for PowerShell 1."
      footer={<Button fullWidth onClick={() => setOpen(false)}>Cancel</Button>}
    >
      <div className="ez-story-stack" style={{ inlineSize: 'auto' }}>
        <Button fullWidth variant="secondary">Rename session</Button>
        <Button fullWidth variant="secondary">Duplicate session</Button>
        <Button fullWidth variant="danger">Close session</Button>
      </div>
    </ActionSheet>
  );
}

export const ActionSheetOpen: Story = {
  render: () => <OpenActionSheet />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};

export const PanelDefault: Story = {
  render: () => (
    <div style={{ blockSize: '28rem', inlineSize: '22rem' }}>
      <PanelShell
        title="System status"
        description="Updated a few seconds ago"
        actions={<Badge variant="success">Live</Badge>}
        footer={<Button leadingIcon={<RefreshCw />}>Refresh</Button>}
        onClose={() => undefined}
      >
        <div className="ez-story-stack" style={{ inlineSize: 'auto' }}>
          <Status variant="success">CPU nominal</Status>
          <Status variant="info">Memory 48%</Status>
          <Status variant="warning">Disk 82%</Status>
        </div>
      </PanelShell>
    </div>
  ),
};

export const PanelBusy: Story = {
  render: () => (
    <div style={{ blockSize: '18rem', inlineSize: '22rem' }}>
      <PanelShell
        title="OpenClaw"
        description="Refreshing gateway state"
        actions={<Button size="sm" loading loadingLabel="Refreshing">Refresh</Button>}
        busy
      >
        <Status variant="loading" live="polite">Checking gateway</Status>
      </PanelShell>
    </div>
  ),
};

export const PanelWithIconAction: Story = {
  render: () => (
    <div style={{ blockSize: '14rem', inlineSize: '22rem' }}>
      <PanelShell
        title="Settings"
        actions={<Button size="sm" variant="ghost" leadingIcon={<Settings />}>Advanced</Button>}
      >
        <p className="ez-story-note">PanelShell keeps headings, actions, body scrolling, and footer placement consistent.</p>
      </PanelShell>
    </div>
  ),
};
