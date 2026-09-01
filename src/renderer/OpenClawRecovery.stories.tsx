import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';

import { MobileOpenClawView } from '../../mobile/src/MobileOpenClawView';
import type { WsEzTerminalTransport } from '../../mobile/src/transport/ws-ezterminal';
import type { OpenClawControlSnapshot } from '../shared/openclaw';
import type { CapabilityAccess, OpenClawAccess } from './capability-access';
import { AppI18nProvider } from './i18n';
import { OpenClawPanel } from './OpenClawPanel';
import './index.css';
import './mobile-shared.css';
import '../../mobile/src/mobile.css';
import '../../mobile/src/workbench.css';
import './workbench/mobile-shell-story.css';

interface OpenClawRecoveryStoryProps {
  readonly surface: 'desktop' | 'mobile';
  readonly phase: 'repairing' | 'blocked';
  readonly locale: 'en' | 'ko';
}

const REQUESTED_AT = '2026-09-01T06:00:00.000Z';

function recoverySnapshot(phase: OpenClawRecoveryStoryProps['phase']): OpenClawControlSnapshot {
  const blocked = phase === 'blocked';
  return {
    schemaVersion: 1,
    intentId: 'story-recovery-intent',
    generation: 12,
    status: { state: 'stopped', port: 18_789 },
    desiredState: 'running',
    supervisorState: blocked ? 'error' : 'ready',
    operation: {
      intentId: 'story-recovery-intent',
      generation: 12,
      action: 'start',
      phase,
      attempt: blocked ? 3 : 2,
      maxAttempts: 3,
      requestedAt: REQUESTED_AT,
    },
    issue: blocked
      ? {
          code: 'repair-exhausted',
          detail: 'OpenClaw did not become RPC-ready after three safe recovery attempts.',
          remediation: 'Review the diagnostic ID and press Start to begin a new recovery request.',
          diagnosticId: 'story-diag-7d3e2a',
        }
      : null,
    updatedAt: '2026-09-01T06:02:00.000Z',
  };
}

function desktopCapabilities(control: OpenClawControlSnapshot): CapabilityAccess {
  const openClaw: OpenClawAccess = {
    observeDrawer: (observer) => {
      queueMicrotask(() => {
        observer.onStatus(control.status);
        observer.onControl?.(control);
      });
      return () => undefined;
    },
    observeChat: () => () => undefined,
    observeVisibility: () => () => undefined,
    getStatus: async () => control.status,
    getControl: async () => control,
    runLifecycle: async () => ({ accepted: true, intentId: control.intentId ?? undefined }),
    runAutostart: async () => ({ ok: true }),
    listSessions: async () => [],
    getConfig: async () => ({
      'agents.defaults.model': 'openai/gpt-5',
      'gateway.port': '18789',
    }),
    setConfig: async () => ({ ok: true, restartRequired: false }),
    getMode: async () => 'on',
    setMode: async () => true,
    setChatSurface: () => true,
    openChat: () => true,
    reloadChat: () => true,
    openChatExternal: async () => true,
  };
  return {
    snapshot: () => ({ core: 'unavailable', desktop: 'available' }),
    openClaw,
  } as unknown as CapabilityAccess;
}

function mobileTransport(control: OpenClawControlSnapshot): WsEzTerminalTransport {
  return {
    onOpenClawStatus: (listener: (status: OpenClawControlSnapshot['status']) => void) => {
      queueMicrotask(() => listener(control.status));
      return () => undefined;
    },
    onOpenClawControl: (listener: (snapshot: OpenClawControlSnapshot) => void) => {
      queueMicrotask(() => listener(control));
      return () => undefined;
    },
    setOpenClawStatusSubscribed: () => undefined,
    onOpenClawLogLines: () => () => undefined,
    setOpenClawLogsSubscribed: () => undefined,
    runOpenClawLifecycle: async () => ({ accepted: true }),
    getOpenClawConfig: async () => ({
      'agents.defaults.model': 'openai/gpt-5',
      'gateway.port': '18789',
    }),
    setOpenClawConfig: async () => ({ ok: true, restartRequired: false }),
    getOpenClawChatTicket: async () => ({ ok: false, reason: 'gateway-stopped' }),
  } as unknown as WsEzTerminalTransport;
}

function OpenClawRecoveryStory({ surface, phase, locale }: OpenClawRecoveryStoryProps): JSX.Element {
  const control = useMemo(() => recoverySnapshot(phase), [phase]);
  const capabilities = useMemo(() => desktopCapabilities(control), [control]);
  const transport = useMemo(() => mobileTransport(control), [control]);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      {surface === 'desktop' ? (
        <div style={{ width: 380, minHeight: 760, position: 'relative' }}>
          <OpenClawPanel
            capabilities={capabilities}
            onOpenChat={() => undefined}
          />
        </div>
      ) : (
        <div className="mobile-active-story">
          <MobileOpenClawView
            transport={transport}
            onClose={() => undefined}
            openclawAvailable
          />
        </div>
      )}
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Production/OpenClaw/Recovery',
  component: OpenClawRecoveryStory,
  parameters: { layout: 'centered' },
  argTypes: {
    surface: { control: 'inline-radio', options: ['desktop', 'mobile'] },
    phase: { control: 'inline-radio', options: ['repairing', 'blocked'] },
    locale: { control: 'inline-radio', options: ['en', 'ko'] },
  },
} satisfies Meta<typeof OpenClawRecoveryStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopRepairing: Story = { args: { surface: 'desktop', phase: 'repairing', locale: 'ko' } };
export const DesktopBlocked: Story = { args: { surface: 'desktop', phase: 'blocked', locale: 'ko' } };
export const MobileRepairing: Story = { args: { surface: 'mobile', phase: 'repairing', locale: 'ko' } };
export const MobileBlocked: Story = { args: { surface: 'mobile', phase: 'blocked', locale: 'ko' } };
