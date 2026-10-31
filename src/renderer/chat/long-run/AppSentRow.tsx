import { Glyph } from '../../ui/Glyph';
import { useChatContext } from '../ChatContext';
import { formatClock, useChatCopy } from '../copy';
import type { ChatRow } from '../model/types';
import { useLongRunDecisions } from './long-run-decisions';
import './long-run.css';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;

/**
 * 시안: what the app sent when a limit lifted. The transcript keeps it as what it is: not the person's words, shown as
 * sent (D3), and never with the person's actions (reuse, reply).
 */
export function AppSentRow({ row }: { readonly row: RowOf<'user'> }): JSX.Element {
  const copy = useChatCopy().longRun.appSent;
  const context = useChatContext();
  const { appRow } = useLongRunDecisions();
  const clock = formatClock(row.createdAt, context.locale);
  const reason = row.appSent ?? 'limit-lifted';
  const text = appRow === 'exact' ? row.text : copy.described[reason];
  const why = copy.why[reason];
  if (context.skin === 'cli') {
    return (
      <article className="chat-cli-line chat-cli-app-sent" aria-label={copy.label} data-message-id={row.anchorId} data-testid="chat-app-sent">
        <span className="chat-cli-glyph" data-tone="muted" aria-hidden="true">↻</span>
        <div className="chat-cli-line__body">
          <span className="chat-cli-dim">{why} · <time dateTime={row.createdAt}>{clock}</time></span>
          <p className="chat-cli-user__text">{text}</p>
        </div>
      </article>
    );
  }
  return (
    <article className="chat-app-sent" aria-label={copy.label} data-message-id={row.anchorId} data-testid="chat-app-sent">
      <p className="chat-app-sent__who"><Glyph name="repeat" /><span>{why}</span><time dateTime={row.createdAt}>{clock}</time></p>
      <p className="chat-app-sent__text" data-exact={appRow === 'exact' || undefined}>{text}</p>
    </article>
  );
}
