import { useState, type ReactNode } from 'react';

import type { AgentUsage } from '../../../src/shared/agent-usage';
import { StageChain } from '../../../src/renderer/shell/StageChain';
import {
  conversationStateText,
  flowPhaseText,
  providerName,
  useShellText,
  waitingKindText,
  type ShellText,
} from '../../../src/renderer/shell/shell-text';
import { Button, Glyph, Led, Menu, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, type LedTone } from '../../../src/renderer/ui';
import type { FeedConversation, FeedFlow, FeedProject, FeedScope, FeedWaitingItem } from './feed-model';
import './mobile-feed.css';

export type FeedDecisionResult = { readonly ok: true } | { readonly ok: false; readonly message?: string };

export interface MobileFeedViewProps {
  readonly projects: readonly FeedProject[];
  readonly scope: FeedScope;
  readonly onScopeChange: (scope: FeedScope) => void;
  /** The PC this phone is connected to: a lamp and a short line ("작업 PC · 18ms"). */
  readonly host: { readonly tone: LedTone; readonly label: string };
  /** The header's own buttons, which depend on the chosen layout (terminal, PC control, ⋯). */
  readonly headerActions?: ReactNode;
  readonly waiting: readonly FeedWaitingItem[];
  readonly flows: readonly FeedFlow[];
  /** False when the PC cannot report flows (older than flow reads). */
  readonly flowsAvailable?: boolean;
  readonly conversations: { readonly items: readonly FeedConversation[]; readonly total: number };
  readonly usage?: AgentUsage | null;
  readonly onDecide: (item: FeedWaitingItem, decision: 'allow' | 'deny') => Promise<FeedDecisionResult>;
  readonly onOpenWaiting: (item: FeedWaitingItem) => void;
  readonly onOpenConversation: (sessionId: string) => void;
  readonly onOpenFlow: (flow: FeedFlow) => void;
  readonly onSeeAllConversations: () => void;
  readonly onNewConversation: () => void;
  /** Where the project screens (flows, tasks, files, worktrees) open from the ▾ menu, when the layout has no tab for them. */
  readonly onOpenProjectScreen?: (projectId: string | null) => void;
}

const GLYPH: Record<FeedWaitingItem['kind'], 'ok' | 'q' | 'flow' | 'term'> = {
  approval: 'ok', question: 'q', plan: 'ok', 'flow-approval': 'flow', 'terminal-agent': 'term',
};

function waitingKicker(item: FeedWaitingItem, text: ShellText): string {
  const kind = item.kind === 'approval' ? waitingKindText(item.requestKind ?? 'other', text)
    : item.kind === 'question' ? waitingKindText('question', text)
      : item.kind === 'plan' ? waitingKindText('plan', text)
        : waitingKindText(item.kind, text);
  return item.providerId ? `${kind} · ${providerName(item.providerId)}` : kind;
}

function openLabel(item: FeedWaitingItem, text: ShellText): string {
  switch (item.kind) {
    case 'question': return text('답하기', 'Answer');
    case 'flow-approval': return text('승인 보기', 'Review approval');
    case 'terminal-agent': return text('에이전트 보기', 'Open agent');
    default: return text('대화 열기', 'Open conversation');
  }
}

function WaitingCard({ item, showProject, onDecide, onOpen }: {
  readonly item: FeedWaitingItem;
  readonly showProject: boolean;
  readonly onDecide: MobileFeedViewProps['onDecide'];
  readonly onOpen: () => void;
}): JSX.Element {
  const { text } = useShellText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = (decision: 'allow' | 'deny'): void => {
    setBusy(true);
    setError(undefined);
    void onDecide(item, decision).then((result) => {
      setBusy(false);
      if (!result.ok) setError(result.message ?? text('결정을 보내지 못했습니다.', 'The decision was not sent.'));
    }, () => {
      setBusy(false);
      setError(text('결정을 보내지 못했습니다.', 'The decision was not sent.'));
    });
  };
  const kicker = (
    <span className="mob-feed__k mob-feed__k--amber">
      <Glyph name={GLYPH[item.kind]} size={15} />
      <span className="mob-feed__k-text">{waitingKicker(item, text)}</span>
      {showProject && item.projectName && <span className="mob-feed__project">{item.projectName}</span>}
    </span>
  );
  if (!item.decide) {
    return (
      <button type="button" className="mob-feed__card mob-feed__card--need" onClick={onOpen} aria-label={`${waitingKicker(item, text)}: ${item.title} · ${openLabel(item, text)}`}
        data-testid="mobile-feed-waiting" data-kind={item.kind}>
        {kicker}
        <span className="mob-feed__t">{item.title}</span>
        {item.detail && <span className="mob-feed__m">{item.detail}</span>}
      </button>
    );
  }
  return (
    <article className="mob-feed__card mob-feed__card--need" aria-label={`${waitingKicker(item, text)}: ${item.title}`} data-testid="mobile-feed-waiting" data-kind={item.kind}>
      {kicker}
      <button type="button" className="mob-feed__t mob-feed__link" onClick={onOpen} data-testid="mobile-feed-waiting-open">{item.title}</button>
      {item.detail && <pre className="mob-feed__cmd">{item.detail}</pre>}
      <div className="mob-feed__pair">
        <Button variant="primary" className="mob-feed__decide" data-tone="amber" disabled={busy}
          onClick={() => decide('allow')} data-testid="mobile-feed-allow">{text('허용', 'Allow')}</Button>
        <Button variant="secondary" className="mob-feed__decide" disabled={busy}
          onClick={() => decide('deny')} data-testid="mobile-feed-deny">{text('거부', 'Deny')}</Button>
      </div>
      {error && <p className="mob-feed__error" role="alert">{error}</p>}
    </article>
  );
}

function usageLine(usage: AgentUsage, text: ShellText): ReactNode {
  return (
    <span className="mob-feed__ask-usage">
      {usage.fiveHour && <>5h <b>{usage.fiveHour.usedPercent}%</b></>}
      {usage.fiveHour && usage.weekly && ' · '}
      {usage.weekly && <>{text('주간', 'week')} <b>{usage.weekly.usedPercent}%</b></>}
    </span>
  );
}

/**
 * The phone's first screen (I4, approved Board + Desk prototype b180f95): 나를 기다리는 것 across every project,
 * then the chosen project's flows and conversations, and an ask bar that opens a new conversation.
 */
export function MobileFeedView(props: MobileFeedViewProps): JSX.Element {
  const { text } = useShellText();
  const allProjects = props.scope === null;
  const scopeName = allProjects ? text('모든 프로젝트', 'All projects') : props.projects.find((project) => project.id === props.scope)?.name ?? text('프로젝트', 'Project');
  return (
    <main className="mob-feed" data-testid="mobile-feed" aria-label={text('피드', 'Feed')}>
      <header className="mob-feed__top">
        <Menu
          label={text('프로젝트 고르기', 'Choose a project')}
          placement="bottom-start"
          trigger={(
            <button type="button" className="mob-feed__scope" data-testid="mobile-feed-scope">
              <Glyph name="proj" size={20} />
              <span className="mob-feed__scope-name">{scopeName}</span>
              <Glyph name="down" size={14} className="mob-feed__caret" />
            </button>
          )}
        >
          <MenuLabel>{text('워크플로·대화를 볼 프로젝트', 'Show workflows and conversations of')}</MenuLabel>
          <MenuRadioItem checked={allProjects} onSelect={() => props.onScopeChange(null)} data-testid="mobile-feed-scope-all">{text('모든 프로젝트', 'All projects')}</MenuRadioItem>
          {props.projects.map((project) => (
            <MenuRadioItem key={project.id} checked={props.scope === project.id} onSelect={() => props.onScopeChange(project.id)} data-testid="mobile-feed-scope-project">{project.name}</MenuRadioItem>
          ))}
          {props.onOpenProjectScreen && <MenuSeparator />}
          {props.onOpenProjectScreen && (
            <MenuItem onSelect={() => props.onOpenProjectScreen?.(props.scope)} data-testid="mobile-feed-open-project">
              {allProjects ? text('프로젝트 목록 열기', 'Open the projects') : text('프로젝트 화면 열기', 'Open the project')}
            </MenuItem>
          )}
        </Menu>
        <span className="mob-feed__host" data-testid="mobile-feed-host"><Led tone={props.host.tone} /><span>{props.host.label}</span></span>
        {props.headerActions}
      </header>
      <div className="mob-feed__body">
        <section aria-labelledby="mob-feed-waiting" data-testid="mobile-feed-waiting-section">
          <h2 id="mob-feed-waiting" className="mob-feed__h"><Glyph name="req" size={16} />{text('나를 기다리는 것', 'Waiting for me')}<span className="mob-feed__n">{props.waiting.length}</span></h2>
          {props.waiting.length === 0 && <p className="mob-feed__none">{text('지금 기다리는 것이 없습니다.', 'Nothing is waiting for you.')}</p>}
          {props.waiting.map((item) => (
            <WaitingCard key={item.key} item={item} showProject={props.projects.length > 1} onDecide={props.onDecide} onOpen={() => props.onOpenWaiting(item)} />
          ))}
        </section>
        {props.flowsAvailable !== false && (props.flows.length > 0 || !allProjects) && (
          <section aria-labelledby="mob-feed-flows" data-testid="mobile-feed-flows">
            <h2 id="mob-feed-flows" className="mob-feed__h"><Glyph name="flow" size={16} />{text('워크플로', 'Workflows')}</h2>
            {props.flows.length === 0 && <p className="mob-feed__none">{text('워크플로가 없습니다.', 'No workflows yet.')}</p>}
            {props.flows.map((flow) => (
              <button key={`${flow.projectId}:${flow.subprojectId}`} type="button" className="mob-feed__card" data-need={flow.lamp === 'amber' || undefined}
                onClick={() => props.onOpenFlow(flow)} data-testid="mobile-feed-flow">
                <span className="mob-feed__k">
                  <Led tone={flow.lamp} />
                  <span className="mob-feed__k-text">{flow.runNumber > 0 ? text(`실행 #${flow.runNumber} · `, `Run #${flow.runNumber} · `) : ''}{flowPhaseText(flow.phase, text)}</span>
                  {allProjects && <span className="mob-feed__project">{flow.projectName}</span>}
                </span>
                <span className="mob-feed__t">{flow.title}</span>
                {flow.stages.length > 0 && <span className="mob-feed__chain"><StageChain stages={flow.stages} compact /></span>}
              </button>
            ))}
          </section>
        )}
        <section aria-labelledby="mob-feed-conversations" data-testid="mobile-feed-conversations">
          <h2 id="mob-feed-conversations" className="mob-feed__h">
            <Glyph name="new" size={16} />{text('대화', 'Conversations')}<span className="mob-feed__n">{props.conversations.total}</span>
          </h2>
          {props.conversations.total === 0 && <p className="mob-feed__none">{text('아래 막대에 할 일을 적으면 새 대화가 시작됩니다.', 'Tap the bar below to start a conversation.')}</p>}
          {props.conversations.items.map((item) => (
            <button key={item.sessionId} type="button" className="mob-feed__card" onClick={() => props.onOpenConversation(item.sessionId)}
              data-testid="mobile-feed-conversation" data-session={item.sessionId}>
              <span className="mob-feed__k">
                <Led tone={item.lamp} />
                <span className="mob-feed__k-text">{providerName(item.providerId)} · {conversationStateText(item.state, text)}</span>
                {allProjects && <span className="mob-feed__project">{item.projectName}</span>}
              </span>
              <span className="mob-feed__t">{item.title}</span>
              {item.children.length > 0 && <span className="mob-feed__m">{text(`하위 에이전트 ${item.children.length}`, `${item.children.length} subagents`)}</span>}
            </button>
          ))}
          <button type="button" className="mob-feed__more" onClick={props.onSeeAllConversations} data-testid="mobile-feed-all-conversations">
            {props.conversations.total > props.conversations.items.length
              ? text(`대화 모두 보기 (${props.conversations.total})`, `See all ${props.conversations.total} conversations`)
              : text('대화 목록 · 이전 대화', 'Conversation list · history')}
            <Glyph name="next" size={14} />
          </button>
        </section>
      </div>
      <div className="mob-feed__start">
        <button type="button" className="mob-feed__ask" onClick={props.onNewConversation} data-testid="mobile-feed-new">
          <span className="mob-feed__ask-text">{allProjects ? text('할 일 · 새 대화', 'Something to do · new conversation') : text(`${scopeName}에서 할 일 · 새 대화`, `Something to do in ${scopeName} · new conversation`)}</span>
          {props.usage && usageLine(props.usage, text)}
        </button>
      </div>
    </main>
  );
}
