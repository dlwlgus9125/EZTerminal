import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { AgentCapabilitiesClient } from '../shared/agent-capabilities';
import { StructuredAgentComposer, StructuredAgentSessionPanel } from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';
import './index.css';
import './structured-agent.css';

const client: AgentCapabilitiesClient = {
  list: fn(async () => ({ ok: true as const, value: {
    providerId: 'codex' as const, workspaceId: 'autocomplete-project', workspaceRoot: 'C:\\Projects\\Example',
    hostId: 'Development PC', revision: 'a'.repeat(64), observedAt: '2026-10-14T00:00:00Z',
    canManage: false, application: 'new-session' as const, models: [], actions: [], issues: [],
    items: [{ id: 'review-skill', kind: 'skill' as const, name: 'review', description: 'Review changes', enabled: true, invocation: '$review', actions: [] }],
  } })),
  manage: fn(),
};
const send = fn(async () => ({ ok: true as const }));
const meta = {
  title: 'Agents/Autocomplete', component: StructuredAgentSessionPanel,
  beforeEach: () => { clearSessionViewStates(); },
  parameters: { layout: 'centered', a11y: { test: 'error' } },
  decorators: [(Story, context) => <AppI18nProvider locale={context.globals.locale === 'ko' ? 'ko' : 'en'} languages={['en', 'ko']}><div style={{ width: 'min(900px, 92vw)', height: '85vh' }}><Story /></div></AppI18nProvider>],
  args: { sessionId: 'autocomplete-session', title: 'New conversation', providerId: 'codex', providerLabel: 'Codex',
    workspace: { id: 'autocomplete-project', label: 'Example', kind: 'local' }, permissionPreset: 'standard', state: 'idle', items: [],
    capabilityClient: client, onSend: send, onResolveApproval: fn(async () => ({ ok: true as const })) },
} satisfies Meta<typeof StructuredAgentSessionPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FirstMessageSkill: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByTestId('structured-agent-composer-input'), '$rev');
    const menu = await canvas.findByRole('listbox');
    await expect(within(menu).getByRole('option', { name: /\$review/ })).toBeVisible();
    await expect(send).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByTestId('structured-agent-composer-input')).toHaveValue('$review ');
    await expect(send).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByTestId('structured-agent-send'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('$review', { skills: [{ providerId: 'codex', id: 'review-skill', name: 'review', invocation: '$review' }] }));
  },
};

export const KeyboardAcrossManySkills: Story = {
  args: { capabilityClient: { ...client, list: async request => {
    const result = await client.list(request);
    if (!result.ok) return result;
    return { ...result, value: { ...result.value, items: Array.from({ length: 25 }, (_, index) => ({
      id: `skill-${index}`, name: `skill-${index}`, kind: 'skill' as const, enabled: true, invocation: `$skill-${index}`, actions: [],
    })) } };
  } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByTestId('structured-agent-composer-input'), '$');
    const list = await canvas.findByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(25));
    await userEvent.keyboard('{ArrowDown>16/}');
    const selected = list.querySelector('[aria-selected="true"]')!;
    await expect(selected).toHaveTextContent('$skill-16');
    await waitFor(() => {
      expect(selected.getBoundingClientRect().top).toBeGreaterThanOrEqual(list.getBoundingClientRect().top);
      expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom);
    });
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByTestId('structured-agent-composer-input')).toHaveValue('$skill-16 ');
    await expect(send).not.toHaveBeenCalled();
  },
};

const openHistory = fn();
export const SkillSuggestions: Story = { args: { draftState: { text: '$rev', selectionStart: 4, selectionEnd: 4 } } };
export const CommandSuggestions: Story = { args: { onOpenHistory: openHistory, draftState: { text: '/', selectionStart: 1, selectionEnd: 1 } } };
export const AndroidSuggestions: Story = { args: { variant: 'mobile', draftState: { text: '$rev', selectionStart: 4, selectionEnd: 4 } } };
export const ResumeIsAnAppAction: Story = {
  args: { onOpenHistory: openHistory, supportsMessageContext: true,
    draftState: { text: '/resume keep this draft', replyTo: { messageId: 'previous', text: 'Earlier message' },
      attachments: [{ id: 'notes', name: 'notes.txt', kind: 'text', mimeType: 'text/plain', data: 'notes' }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('structured-agent-send'));
    await expect(openHistory).toHaveBeenCalledTimes(1);
    await expect(send).not.toHaveBeenCalled();
    await expect(canvas.getByTestId('structured-agent-composer-input')).toHaveValue('keep this draft');
    await expect(canvas.getByText('notes.txt')).toBeVisible();
    await expect(canvas.getByText('Earlier message')).toBeVisible();
  },
};

export const MiddleOfDraft: Story = {
  args: { draftState: { text: 'Before $revxxx after', selectionStart: 11, selectionEnd: 11 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('option', { name: /\$review/ }));
    await expect(canvas.getByTestId('structured-agent-composer-input')).toHaveValue('Before $review after');
    await expect(send).not.toHaveBeenCalled();
    const input = canvas.getByTestId('structured-agent-composer-input') as HTMLTextAreaElement;
    await expect(input.selectionStart).toBe(14);
  },
};

export const KoreanComposition: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByTestId('structured-agent-composer-input');
    await userEvent.type(input, '$rev');
    await canvas.findByRole('listbox');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '한' }));
    const confirm = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(confirm);
    await expect(confirm.defaultPrevented).toBe(false);
    await expect(send).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));
    await canvas.findByRole('listbox');
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('listbox')).not.toBeInTheDocument();
    await expect(input).toHaveValue('$rev');
    await userEvent.click(canvas.getByRole('button', { name: 'Add' }));
    await userEvent.click(await canvas.findByRole('menuitem', { name: 'Skills' }));
    await canvas.findByRole('listbox');
    // The menu restores focus a frame after closing; the input must keep it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await expect(input).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect(input).toHaveValue('$rev');
    await expect(send).not.toHaveBeenCalled();
  },
};

export const AndroidTouch: Story = {
  args: { variant: 'mobile', skin: 'cli' },
  parameters: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByTestId('structured-agent-composer-input');
    await userEvent.type(input, '$rev');
    await canvas.findByRole('listbox');
    await userEvent.keyboard('{Enter}');
    await expect(input).toHaveValue('$rev\n');
    await expect(send).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '$rev');
    await userEvent.click(await canvas.findByRole('option', { name: /\$review/ }));
    await expect(input).toHaveValue('$review ');
    await expect(send).not.toHaveBeenCalled();
  },
};

const claudeClient: AgentCapabilitiesClient = {
  list: fn(async () => {
    const result = await client.list({ providerId: 'codex', workspaceId: 'autocomplete-project' });
    if (!result.ok) return result;
    return { ok: true as const, value: { ...result.value, providerId: 'claude' as const, items: [
      { id: 'review-command', kind: 'skill' as const, name: 'review', description: 'Review changes', enabled: true, invocation: '/review', actions: [] },
      { id: 'legacy-command', kind: 'skill' as const, name: 'legacy', description: 'Old skill', enabled: false, invocation: '/legacy', actions: [] },
    ] } };
  }), manage: fn(),
};
export const ClaudeNativeSyntax: Story = {
  args: { providerId: 'claude', providerLabel: 'Claude', capabilityClient: claudeClient },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByTestId('structured-agent-composer-input');
    await userEvent.type(input, '/leg');
    const disabled = await canvas.findByRole('option', { name: /\/legacy/ });
    await expect(disabled).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(disabled);
    await expect(input).toHaveValue('/leg');
    await userEvent.clear(input);
    await userEvent.type(input, '/rev');
    await canvas.findByRole('option', { name: /\/review/ });
    await userEvent.keyboard('{Enter}');
    await expect(input).toHaveValue('/review ');
    await expect(send).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByTestId('structured-agent-send'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('/review', { skills: [{ providerId: 'claude', id: 'review-command', name: 'review', invocation: '/review' }] }));
  },
};

export const MinimalCommand: Story = {
  render: () => <StructuredAgentComposer busy={false} onSend={send} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByTestId('structured-agent-composer-input'), '/');
    await expect(await canvas.findByRole('listbox')).toBeVisible();
    await expect(send).not.toHaveBeenCalled();
  },
};
