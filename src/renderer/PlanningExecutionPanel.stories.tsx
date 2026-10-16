import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppI18nProvider } from './i18n';
import { PlanningExecutionPanel } from './PlanningExecutionPanel';
import { planningExecutionFixture } from './planning-execution-fixtures';
import './index.css';
import './planning-workspace.css';
const fixture = planningExecutionFixture();
const meta: Meta<typeof PlanningExecutionPanel> = {
  title: 'Production/Planning/Execution', component: PlanningExecutionPanel, parameters: { layout: 'fullscreen' },
  args: { planning: fixture.planning, disabled: false, pendingRequest: null, persistPendingRequest: fn(async () => undefined), onOpenConversation: fn(),
    access: { getPlanningExecutionSnapshot: async () => ({ ok: true, snapshot: fixture.execution }), executePlanningRun: async () => ({ ok: false, error: 'unavailable', message: 'Story preview does not execute tasks.' }), getDaemonSnapshot: async () => null, listDaemonProviderModels: async () => ({ ok: true, value: [] }) } },
  decorators: [(Story) => <AppI18nProvider locale="ko" languages={['ko']}><div className="planning-workspace" style={{ height: '100vh' }}><Story /></div></AppI18nProvider>],
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Prepared: Story = {};
export const UncertainRequest: Story = { args: { pendingRequest: { type: 'start', commandId: 'command-uncertain', projectId: fixture.planning.projectId, expectedRevision: 1, payload: { runId: 'run-example' } } } };
export const Mobile: Story = { decorators: [(Story) => <div style={{ width: 'min(100vw, 390px)' }}><Story /></div>] };
