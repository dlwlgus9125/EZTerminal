import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { PlanningAiRequest } from '../../shared/planning-ai';
import { planningProfilePresets } from '../../shared/planning-profile-presets';
import { PlanningAiPanel, type PlanningAiPanelProps } from './PlanningAiPanel';
import { planningAiFixture } from './planning-ai-fixtures';
import { sceneSnapshot } from './scene-fixtures';
import { AppI18nProvider } from '../i18n';
import '../index.css';

function Controlled(args: PlanningAiPanelProps): JSX.Element {
  const [pending, setPending] = useState<PlanningAiRequest | null>(args.pendingRequest);
  return <PlanningAiPanel {...args} pendingRequest={pending} persistPendingRequest={async value => setPending(value)} />;
}
const meta: Meta<typeof PlanningAiPanel> = {
  title: 'Production/Planning/AI proposal review', component: PlanningAiPanel, parameters: { layout: 'fullscreen' },
  args: { snapshot: { ...sceneSnapshot, draft: { ...sceneSnapshot.draft, profiles: [...planningProfilePresets('ko')] } }, target: planningAiFixture().request.target, pendingRequest: null, persistPendingRequest: fn(), onApplied: fn(),
    access: { planningAiRequest: async () => ({ ok: true, jobs: [planningAiFixture()] }), getDaemonSnapshot: async () => null, listDaemonProviderModels: async () => ({ ok: true, value: [] }) } },
  decorators: [(Story) => <AppI18nProvider locale="ko" languages={['ko']}><div style={{ height: '100vh', overflow: 'auto' }}><Story /></div></AppI18nProvider>],
  render: args => <Controlled {...args} />,
};
export default meta;
type Story = StoryObj<typeof PlanningAiPanel>;
export const ReviewChanges: Story = {};
export const ReconcileRequest: Story = { args: { pendingRequest: { type: 'apply', projectId: sceneSnapshot.projectId, requestId: 'proposal-story' } } };
export const StaleSource: Story = { args: { snapshot: { ...sceneSnapshot, revision: 3 } } };
