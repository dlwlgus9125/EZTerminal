import { Bot, CircleDot, FileDiff, FileText, ListChecks, LoaderCircle, MessageSquareWarning, Route } from 'lucide-react';
import { useMemo } from 'react';

import { useChatCopy, useChatLocale } from '../chat/copy';
import { useNow } from '../chat/ChatContext';
import { ChatMarkdown, type ChatMarkdownLabels } from '../chat/markdown/ChatMarkdown';
import { TodoList } from '../chat/rows/BubbleRows';
import { formatDuration, workspacePath } from '../chat/model/summary';
import { useAgentStateLabel } from '../agent-state-label';
import { Button, EmptyState } from '../ui';
import type { DerivedResults } from './derive-results';
import { useResultsCopy } from './copy';
import type { ResultsChild } from './results-source-store';

const FILES_SHOWN = 12;

function firstLine(text: string): string {
  const newline = text.search(/\r?\n/u);
  return newline < 0 ? text : text.slice(0, newline);
}

export function ResultsSummary({ derived, subagents, workspaceRoot, onOpenSubagent, onFocusDecision, onOpenChanges, onOpenFile, onOpenLink }: {
  readonly derived: DerivedResults;
  readonly subagents: readonly ResultsChild[];
  readonly workspaceRoot?: string;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly onFocusDecision?: () => void;
  readonly onOpenChanges?: (path: string) => void;
  readonly onOpenFile?: (path: string) => void;
  readonly onOpenLink?: (url: string) => void;
}): JSX.Element {
  const copy = useResultsCopy();
  const chatCopy = useChatCopy();
  const locale = useChatLocale();
  const stateLabel = useAgentStateLabel();
  const now = useNow(derived.running.length > 0);
  const labels = useMemo<Partial<ChatMarkdownLabels>>(() => ({
    copyCode: chatCopy.copyCode, copied: chatCopy.copied, copyFailed: chatCopy.copyFailed,
    wrapLines: chatCopy.wrapLines, task: chatCopy.task, blockedImage: chatCopy.blockedImage,
  }), [chatCopy]);
  const todo = derived.todo;
  const done = todo?.filter((item) => item.status === 'completed').length ?? 0;
  const empty = !derived.plan && !todo?.length && !derived.running.length && !subagents.length && !derived.files.length && !derived.pendingDecisions;
  if (empty) return <div className="results-summary" data-testid="results-summary"><EmptyState title={copy.summaryEmpty} description={copy.summaryEmptyHint} /></div>;
  return (
    <div className="results-summary" data-testid="results-summary">
      {derived.pendingDecisions > 0 && (
        <div className="results-banner" role="status">
          <MessageSquareWarning aria-hidden="true" />
          <span>{copy.decisions(derived.pendingDecisions)}</span>
          {onFocusDecision && <Button variant="secondary" size="sm" onClick={onFocusDecision}>{copy.decide}</Button>}
        </div>
      )}
      {derived.running.length > 0 && (
        <section className="results-block" aria-label={copy.running}>
          <h3 className="results-block__title"><LoaderCircle className="results-spin" aria-hidden="true" />{copy.running}</h3>
          <ul className="results-rows">
            {derived.running.map((tool) => {
              const started = Date.parse(tool.createdAt);
              return (
                <li key={tool.id} className="results-row">
                  <span className="results-row__main" title={tool.command ?? tool.target ?? tool.name}>
                    {workspacePath(firstLine(tool.command ?? tool.target ?? tool.name), workspaceRoot)}
                  </span>
                  <span className="results-row__meta">
                    {tool.awaitingApproval ? copy.waitingApproval : Number.isFinite(started) ? formatDuration(Math.max(0, now - started), locale) : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {derived.plan && (
        <section className="results-block" aria-label={copy.plan}>
          <h3 className="results-block__title"><Route aria-hidden="true" />{copy.plan}</h3>
          {derived.plan.filePath && (
            <p className="results-note">
              {copy.planFile}: {onOpenFile
                ? <button type="button" className="results-link" onClick={() => onOpenFile(derived.plan!.filePath!)}>{workspacePath(derived.plan.filePath, workspaceRoot)}</button>
                : workspacePath(derived.plan.filePath, workspaceRoot)}
            </p>
          )}
          <div className="results-markdown"><ChatMarkdown markdown={derived.plan.markdown} variant="prose" labels={labels} {...(onOpenLink ? { onOpenLink } : {})} /></div>
        </section>
      )}
      {todo && todo.length > 0 && (
        <section className="results-block" aria-label={copy.tasks}>
          <h3 className="results-block__title"><ListChecks aria-hidden="true" />{copy.tasks}<span className="results-block__meta">{copy.tasksProgress(done, todo.length)}</span></h3>
          <TodoList items={todo} />
        </section>
      )}
      {subagents.length > 0 && (
        <section className="results-block" aria-label={copy.subagents}>
          <h3 className="results-block__title"><Bot aria-hidden="true" />{copy.subagents}</h3>
          <ul className="results-rows">
            {subagents.map((child) => (
              <li key={child.sessionId} className="results-row" data-state={child.state}>
                <CircleDot className="results-row__dot" aria-hidden="true" />
                <span className="results-row__main" title={child.title}>{child.title}</span>
                <span className="results-row__meta">{child.providerLabel} · {stateLabel(child.state)}</span>
                {onOpenSubagent && <Button variant="ghost" size="sm" onClick={() => onOpenSubagent(child.sessionId)}>{copy.openSubagent}</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {derived.files.length > 0 && (
        <section className="results-block" aria-label={copy.filesTouched}>
          <h3 className="results-block__title"><FileDiff aria-hidden="true" />{copy.filesTouched}<span className="results-block__meta">{derived.files.length}</span></h3>
          <ul className="results-rows">
            {derived.files.slice(0, FILES_SHOWN).map((file) => (
              <li key={file.path} className="results-row">
                <span className="results-row__main" title={workspacePath(file.path, workspaceRoot)}>
                  {onOpenChanges
                    ? <button type="button" className="results-link" onClick={() => onOpenChanges(file.path)}>{workspacePath(file.path, workspaceRoot)}</button>
                    : workspacePath(file.path, workspaceRoot)}
                </span>
                <span className="results-row__meta">
                  {file.kind === 'add' ? copy.created : file.kind === 'delete' ? copy.deleted : copy.modified}
                  {file.added > 0 && <span className="results-added"> +{file.added}</span>}
                  {file.removed > 0 && <span className="results-removed"> −{file.removed}</span>}
                </span>
                {onOpenFile && file.kind !== 'delete' && (
                  <button type="button" className="results-icon-link" aria-label={`${copy.viewFile}: ${workspacePath(file.path, workspaceRoot)}`} onClick={() => onOpenFile(file.path)}>
                    <FileText aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
