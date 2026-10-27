import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState, type ReactNode } from 'react';

import { MobileFeedView } from '../../../mobile/src/feed/MobileFeedView';
import { feedConversations, feedFlows, feedProjects, feedWaiting, type FeedScope } from '../../../mobile/src/feed/feed-model';
import { MobileNavigationHistoryProvider } from '../../../mobile/src/MobileNavigationHistory';
import { MobileToastProvider } from '../../../mobile/src/MobileToast';
import type { AgentActivity } from '../../shared/agent';
import type { HostAttention } from '../../shared/host-attention';
import { AppI18nProvider } from '../i18n';
import { shellSnapshot, shellWorkflow } from '../shell/shell-fixtures';
import { Glyph } from '../ui';
import '../mobile-shared.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import './phone-i4-mockup.css';

/**
 * I4 Android mockup review (plan i4-wobbly-truffle, I4-6): the phone's screens built from the real phone
 * components at 412×915, to choose the tab layout (A: no tab bar, as the approved prototype b180f95;
 * B: feed · projects · terminal · more) and to see the screens the prototype did not draw.
 */
const meta = {
  title: 'Production/Phone/I4 mockup',
  parameters: { layout: 'centered', a11y: { test: 'error' } },

} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const attention: HostAttention = {
  version: 1, digest: 'mockup',
  items: [
    { id: 'flow-1', kind: 'flow-approval', projectId: 'p-ez', title: '승인', since: '2026-10-24T09:25:00.000Z', subprojectId: 'login', nodeId: 'login:approval', runId: 'run-4' },
  ],
};

const terminalAgents: readonly AgentActivity[] = [];

function Phone({ children, locale = 'ko' }: { readonly children: ReactNode; readonly locale?: 'ko' | 'en' }): JSX.Element {
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileNavigationHistoryProvider>
        <MobileToastProvider>
          <div className="phone-i4-frame mobile-workbench-coordinator" data-testid="phone-i4-frame">{children}</div>
        </MobileToastProvider>
      </MobileNavigationHistoryProvider>
    </AppI18nProvider>
  );
}

/** Variant A's header buttons: the prototype's terminal and PC-control buttons, plus ⋯ for the rest. */
function HeaderIconsA(): JSX.Element {
  return (
    <span className="phone-i4-icons">
      <button type="button" className="mob-icon-btn mob-icon-btn--plate" aria-label="터미널"><Glyph name="term" size={20} /></button>
      <button type="button" className="mob-icon-btn mob-icon-btn--plate" aria-label="PC 화면 제어"><Glyph name="pc" size={20} /></button>
      <button type="button" className="mob-icon-btn mob-icon-btn--plate" aria-label="더보기"><Glyph name="more" size={20} /></button>
    </span>
  );
}

function Feed({ initialScope = null, headerActions, locale }: { readonly initialScope?: FeedScope; readonly headerActions?: ReactNode; readonly locale?: 'ko' | 'en' }): JSX.Element {
  const [scope, setScope] = useState<FeedScope>(initialScope);
  const daemon = useMemo(() => ({ ...shellSnapshot(), attention, providerUsage: { claude: { fiveHour: { usedPercent: 24 }, weekly: { usedPercent: 21 } } } }), []);
  const projects = feedProjects(daemon);
  const workflows = new Map([['p-ez', shellWorkflow()]]);
  const waiting = feedWaiting(daemon, terminalAgents, workflows);
  const waitingSessions = new Set(waiting.flatMap((item) => item.sessionId ? [item.sessionId] : []));
  return (
    <Phone locale={locale}>
      <MobileFeedView
        projects={projects}
        scope={scope}
        onScopeChange={setScope}
        host={{ tone: 'on', label: '작업 PC · 18ms' }}
        headerActions={headerActions}
        waiting={waiting}
        flows={feedFlows(workflows, scope, projects)}
        conversations={feedConversations(daemon, scope, { waitingSessions, limit: 5 })}
        usage={daemon.providerUsage.claude}
        onDecide={async () => ({ ok: true })}
        onOpenWaiting={() => undefined}
        onOpenConversation={() => undefined}
        onOpenFlow={() => undefined}
        onSeeAllConversations={() => undefined}
        onNewConversation={() => undefined}
      />
    </Phone>
  );
}

/** A: no tab bar. The feed is the only first screen; terminal, PC control and ⋯ sit in its header. */
export const FeedA: Story = { render: () => <Feed headerActions={<HeaderIconsA />} /> };

/** The same feed narrowed to one project from the header ▾. */
export const FeedOneProject: Story = { render: () => <Feed initialScope="p-ez" headerActions={<HeaderIconsA />} /> };

export const FeedEnglish: Story = { render: () => <Feed headerActions={<HeaderIconsA />} locale="en" /> };
