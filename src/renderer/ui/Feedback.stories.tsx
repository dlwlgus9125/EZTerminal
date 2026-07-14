import { Bell, RefreshCw, Settings } from 'lucide-react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Status,
  Toast,
  ToastProvider,
  useToast,
  VisuallyHidden,
} from './index';

const meta = {
  title: 'Primitives/Feedback',
  component: Badge,
  parameters: {
    a11y: { test: 'error' },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Badges: Story = {
  render: () => (
    <div className="ez-story-row">
      <Badge>Neutral</Badge>
      <Badge variant="accent">Matrix</Badge>
      <Badge variant="info">Info</Badge>
      <Badge variant="success">Connected</Badge>
      <Badge variant="warning">Degraded</Badge>
      <Badge variant="danger">Failed</Badge>
      <Badge size="sm">Compact</Badge>
    </div>
  ),
};

export const Statuses: Story = {
  render: () => (
    <div className="ez-story-stack">
      <Status>Idle</Status>
      <Status variant="accent">Active pane</Status>
      <Status variant="info">Update available</Status>
      <Status variant="success">Connected</Status>
      <Status variant="warning">High memory usage</Status>
      <Status variant="danger" live="assertive">Connection failed</Status>
      <Status variant="loading" live="polite">Connecting</Status>
    </div>
  ),
};

export const StateViews: Story = {
  render: () => (
    <div className="ez-story-grid">
      <section className="ez-story-section">
        <EmptyState
          title="No saved commands"
          description="Save a command to run it from any terminal pane."
          action={<Button variant="primary">Create command</Button>}
        />
      </section>
      <section className="ez-story-section">
        <LoadingState label="Loading sessions" description="Restoring the previous workspace." />
      </section>
      <section className="ez-story-section">
        <ErrorState
          title="Could not connect"
          description="Check the address and try again."
          action={<Button leadingIcon={<RefreshCw />}>Retry</Button>}
        />
      </section>
    </div>
  ),
};

export const ToastVariants: Story = {
  render: () => (
    <div className="ez-story-stack">
      <Toast title="Connection ready" description="Remote bridge is listening." variant="info" duration={0} />
      <Toast title="Preset saved" description="Workspace layout updated." variant="success" duration={0} />
      <Toast title="Disk almost full" description="Only 8% free space remains." variant="warning" duration={0} />
      <Toast title="Command failed" description="Process exited with code 1." variant="danger" duration={0} />
    </div>
  ),
};

function ToastLauncher(): JSX.Element {
  const { pushToast } = useToast();
  return (
    <Button
      leadingIcon={<Bell />}
      onClick={() => pushToast({
        title: 'Preset saved',
        description: 'Workspace layout updated.',
        variant: 'success',
        duration: 0,
      })}
    >
      Show notification
    </Button>
  );
}

export const ToastInteraction: Story = {
  render: () => (
    <ToastProvider viewportLabel="Story notifications">
      <ToastLauncher />
    </ToastProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show notification' }));
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByRole('status')).toHaveTextContent('Workspace layout updated.');
    await userEvent.click(page.getByRole('button', { name: 'Dismiss notification' }));
    await expect(page.queryByText('Workspace layout updated.')).not.toBeInTheDocument();
  },
};

export const VisuallyHiddenLabel: Story = {
  render: () => (
    <button type="button" className="ez-ui-icon-button" data-size="md" data-variant="secondary">
      <Settings aria-hidden="true" />
      <VisuallyHidden>Open settings</VisuallyHidden>
    </button>
  ),
};
