import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppI18nProvider } from './i18n';
import { PlanningDeviceEvidenceForm } from './PlanningDeviceEvidenceForm';
import { Dialog } from './ui';
import './index.css';
import './planning-workspace.css';

const meta: Meta<typeof PlanningDeviceEvidenceForm> = {
  title: 'Production/Planning/Device evidence',
  component: PlanningDeviceEvidenceForm,
  parameters: { layout: 'padded' },
  args: { target: { scope: 'integration', runId: 'run-device', taskId: 'task-chat', validationId: 'android-smoke', baselineFingerprint: 'a'.repeat(64), candidateCommit: 'b'.repeat(40), environment: 'Android 15 / 실제 기기', command: 'maestro test smoke.yaml' }, disabled: false, onSubmit: fn(async () => true), onCancel: fn() },
  decorators: [(Story) => <AppI18nProvider locale="ko" languages={['ko']}><Dialog open size="lg" onOpenChange={() => undefined} title="실기기 검증 증빙"><div className="planning-workspace__result"><Story /></div></Dialog></AppI18nProvider>],
};
export default meta;
type Story = StoryObj<typeof meta>;
export const ManualEvidence: Story = {};
