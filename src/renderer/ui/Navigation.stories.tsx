import { Copy, MoreHorizontal, Pin, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import {
  Button,
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuRadioItem,
  MenuSeparator,
  Popover,
  Status,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
} from './index';

const meta = {
  title: 'Primitives/Navigation and overlays',
  component: Tabs,
  parameters: {
    a11y: { test: 'error' },
  },
  args: {
    value: 'general',
    onValueChange: () => undefined,
  },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

function TabsExample({ vertical = false }: { readonly vertical?: boolean }): JSX.Element {
  const [value, setValue] = useState('general');
  return (
    <Tabs value={value} onValueChange={setValue} orientation={vertical ? 'vertical' : 'horizontal'}>
      <TabList label="Settings sections">
        <Tab value="general">General</Tab>
        <Tab value="terminal">Terminal</Tab>
        <Tab value="remote">Remote</Tab>
        <Tab value="managed" disabled>Managed</Tab>
      </TabList>
      <TabPanel value="general"><p>Startup and workspace preferences.</p></TabPanel>
      <TabPanel value="terminal"><p>Renderer, scrollback, and terminal font.</p></TabPanel>
      <TabPanel value="remote"><p>Remote bridge and pairing controls.</p></TabPanel>
    </Tabs>
  );
}

export const HorizontalTabs: Story = {
  render: () => <div className="ez-story-stack"><TabsExample /></div>,
};

export const VerticalTabs: Story = {
  render: () => <div className="ez-story-stack"><TabsExample vertical /></div>,
};

export const KeyboardTabs: Story = {
  render: () => <div className="ez-story-stack"><TabsExample /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const general = canvas.getByRole('tab', { name: 'General' });
    general.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    await expect(canvas.getByRole('tab', { name: 'Remote' })).toHaveFocus();
  },
};

function MenuExample(): JSX.Element {
  const [selected, setSelected] = useState('No action selected');
  const [pinned, setPinned] = useState(false);
  const [profile, setProfile] = useState<'static' | 'crt'>('crt');
  return (
    <div className="ez-story-stack">
      <Menu
        label="Pane actions"
        trigger={<Button trailingIcon={<MoreHorizontal />}>Pane actions</Button>}
      >
        <MenuLabel>Pane</MenuLabel>
        <MenuItem icon={Copy} onSelect={() => setSelected('Duplicated pane')}>Duplicate</MenuItem>
        <MenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>Pin pane</MenuCheckboxItem>
        <MenuSeparator />
        <MenuLabel>Effect profile</MenuLabel>
        <MenuRadioItem checked={profile === 'static'} onSelect={() => setProfile('static')}>Static</MenuRadioItem>
        <MenuRadioItem checked={profile === 'crt'} onSelect={() => setProfile('crt')}>CRT Signature</MenuRadioItem>
        <MenuSeparator />
        <MenuItem icon={Settings} onSelect={() => setSelected('Opened settings')}>Settings</MenuItem>
        <MenuItem icon={Trash2} destructive onSelect={() => setSelected('Closed pane')}>Close pane</MenuItem>
        <MenuItem icon={Pin} disabled onSelect={() => undefined}>Managed action</MenuItem>
      </Menu>
      <Status variant="info" live="polite">{selected}</Status>
    </div>
  );
}

export const MenuStates: Story = {
  render: () => <MenuExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Pane actions/ }));
    await expect(canvas.getByRole('menu')).toBeVisible();
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    await expect(canvas.getByText('Duplicated pane')).toBeVisible();
  },
};

export const PopoverContent: Story = {
  render: () => (
    <Popover trigger={<Button>Connection details</Button>} ariaLabel="Connection details" initialFocus>
      <div className="ez-story-stack" style={{ inlineSize: '18rem' }}>
        <Status variant="success">Connected</Status>
        <p className="ez-story-note">127.0.0.1:7420 · encrypted tunnel</p>
        <Button size="sm" leadingIcon={<Copy />}>Copy address</Button>
      </div>
    </Popover>
  ),
};

export const TooltipOnFocus: Story = {
  render: () => (
    <Tooltip content="Open terminal settings" side="bottom" delay={0}>
      <IconButton icon={Settings} aria-label="Settings" />
    </Tooltip>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('tooltip')).toHaveTextContent('Open terminal settings');
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument();
  },
};
