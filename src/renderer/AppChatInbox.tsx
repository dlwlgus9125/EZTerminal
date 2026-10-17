import { AlertTriangle, CheckCircle2, ShieldQuestion, Users } from 'lucide-react';

import { useAppTranslation } from './i18n';
import { Button } from './ui';
import './app-chat-inbox.css';

export interface AppChatInboxItem {
  readonly id: string;
  readonly sessionId: string;
  /** approval: waiting on the person · finished/failed: a turn ended while unseen. */
  readonly kind: 'approval' | 'finished' | 'failed';
  readonly conversationTitle: string;
  readonly providerLabel: string;
  /** What is asked (approval title) or how it ended (bounded summary). */
  readonly detail: string;
  /** The approval was raised inside this provider-native subagent. */
  readonly subagentTitle?: string;
  readonly at: string;
}

export interface AppChatInboxProps {
  readonly items: readonly AppChatInboxItem[];
  readonly onOpen: (item: AppChatInboxItem) => void;
  readonly onMarkSeen?: (item: AppChatInboxItem) => void;
}

/** App conversations in the inbox: approvals first, then turns that ended while you were away. */
export function AppChatInbox({ items, onOpen, onMarkSeen }: AppChatInboxProps): JSX.Element | null {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => ko ? korean : english;
  const approvals = items.filter((item) => item.kind === 'approval');
  const ended = items.filter((item) => item.kind !== 'approval');
  if (!items.length) return null;
  const time = (value: string): string => new Intl.DateTimeFormat(ko ? 'ko' : 'en', { hour: 'numeric', minute: '2-digit' }).format(Date.parse(value));
  const row = (item: AppChatInboxItem): JSX.Element => {
    const Icon = item.kind === 'approval' ? ShieldQuestion : item.kind === 'failed' ? AlertTriangle : CheckCircle2;
    return (
      <article key={item.id} className="agent-row app-chat-inbox__row" data-kind={item.kind} data-testid="app-chat-inbox-item">
        <div className="agent-row-main">
          <Icon aria-hidden="true" size={15} className="app-chat-inbox__icon" />
          <span className="app-chat-inbox__title" title={item.conversationTitle}>{item.conversationTitle}</span>
          <span className="agent-status">{item.providerLabel} · {time(item.at)}</span>
        </div>
        <p className="app-chat-inbox__detail">
          {item.subagentTitle && <span className="app-chat-inbox__subagent"><Users aria-hidden="true" />{item.subagentTitle}</span>}
          {item.detail}
        </p>
        <div className="app-chat-inbox__actions">
          {item.kind !== 'approval' && onMarkSeen && <Button size="sm" variant="ghost" onClick={() => onMarkSeen(item)}>{text('읽음', 'Mark read')}</Button>}
          <Button size="sm" variant={item.kind === 'approval' ? 'primary' : 'secondary'} onClick={() => onOpen(item)}>
            {item.kind === 'approval' ? text('확인하기', 'Review') : text('열기', 'Open')}
          </Button>
        </div>
      </article>
    );
  };
  return (
    <>
      {approvals.length > 0 && (
        <section className="agent-group app-chat-inbox" data-testid="app-chat-inbox-approvals">
          <h2 className="status-section-title agent-group-title agent-group-title--attention">{text(`대화 승인 대기 ${approvals.length}`, `Conversations waiting for approval · ${approvals.length}`)}</h2>
          <div className="agent-list">{approvals.map(row)}</div>
        </section>
      )}
      {ended.length > 0 && (
        <section className="agent-group app-chat-inbox" data-testid="app-chat-inbox-ended">
          <h2 className="status-section-title agent-group-title">{text(`끝난 대화 ${ended.length}`, `Finished while away · ${ended.length}`)}</h2>
          <div className="agent-list">{ended.map(row)}</div>
        </section>
      )}
    </>
  );
}
