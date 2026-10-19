import { ChevronDown, ChevronUp, FileDiff, MessageCircleQuestion, NotebookPen, ShieldAlert, ShieldCheck, ShieldQuestion, SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { ApprovalQuestion, ApprovalResponse } from '../../../shared/approval-request';
import { ACCESS_LEVELS, agentPermissionCopy, type AccessLevel } from '../../agent-permission-copy';
import { Button } from '../../ui';
import { SettingPill } from '../composer/SettingPill';
import { useChatCopy, useChatLocale, type ChatCopy } from '../copy';
import { useChatContext } from '../ChatContext';
import type { PendingInteraction } from '../model/types';
import { DiffView } from '../parts/DiffView';
import { OutputBlock } from '../parts/ToolDetail';
import { Prose } from '../parts/Prose';

export interface ApprovalResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** The access level an approved plan runs with; the composer's permission pill shares it. */
export interface PlanAccessChoice {
  readonly level: AccessLevel;
  readonly onChange: (level: AccessLevel) => void;
}

export interface ApprovalDockProps {
  readonly pending: PendingInteraction;
  readonly pendingCount: number;
  /** Host accepts answers / plan mode / feedback (`approval-response-v1`). */
  readonly canRespond: boolean;
  readonly disabled?: boolean;
  readonly onResolve: (approvalId: string, decision: 'allow' | 'deny', response?: ApprovalResponse) => Promise<ApprovalResult>;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly planAccess?: PlanAccessChoice;
}

/** Codex sends a new file's content and a deleted file's old content raw, not as a patch. */
function approvalPatch(kind: string | undefined, diff: string): string {
  // Real patches from either adapter start with a hunk header; raw content may itself begin with "- ".
  if ((kind !== 'add' && kind !== 'delete') || diff.startsWith('@@')) return diff;
  const prefix = kind === 'add' ? '+' : '-';
  return diff.replace(/\r?\n$/u, '').split(/\r?\n/u).map((line) => `${prefix}${line}`).join('\n');
}

/** Localized title from the structured request; hosts without one keep the provider's title. */
function dockTitle(pending: PendingInteraction, copy: ChatCopy): string {
  const { approval, request } = pending;
  switch (request?.kind) {
    case 'command': return copy.approval.commandTitle;
    case 'file-change': {
      const [file] = request.files;
      if (request.files.length !== 1 || !file) return copy.approval.editFilesTitle(request.files.length);
      const name = file.path.replace(/^.*[\\/]/u, '');
      return file.kind === 'add' ? copy.approval.createTitle(name) : file.kind === 'delete' ? copy.approval.deleteTitle(name) : copy.approval.editTitle(name);
    }
    case 'question': return copy.approval.questionTitle;
    case 'plan': return copy.approval.planTitle;
    case 'tool': return copy.approval.toolTitle(request.toolName);
    default: return approval.title;
  }
}

function riskIcon(kind: string | undefined): typeof ShieldAlert {
  switch (kind) {
    case 'command': return SquareTerminal;
    case 'file-change': return FileDiff;
    case 'question': return MessageCircleQuestion;
    case 'plan': return NotebookPen;
    default: return ShieldQuestion;
  }
}

function FeedbackForm({ label, submitLabel, busy, onSubmit, onCancel }: {
  readonly label: string;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (message: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const copy = useChatCopy();
  const [message, setMessage] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <form className="chat-dock__feedback" onSubmit={(event) => { event.preventDefault(); if (message.trim()) onSubmit(message.trim()); }}>
      <label className="chat-dock__label">
        <span>{label}</span>
        <textarea ref={ref} rows={2} value={message} onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }} />
      </label>
      <div className="chat-dock__actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>{copy.approval.cancel}</Button>
        <Button variant="primary" size="sm" type="submit" disabled={!message.trim()} loading={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}

function QuestionBody({ questions, busy, disabled, onSubmit }: {
  readonly questions: readonly ApprovalQuestion[];
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSubmit: (answers: Record<string, string>) => void;
}): JSX.Element {
  const copy = useChatCopy();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const question = questions[step]!;
  const selected = answers[question.question] ?? [];
  const last = step === questions.length - 1;
  const finalAnswers = (): Record<string, string> => Object.fromEntries(questions.map((entry) => {
    const chosen = (answers[entry.question] ?? []).map((label) => (label === '__other__' ? other[entry.question]?.trim() ?? '' : label)).filter(Boolean);
    return [entry.question, chosen.join(', ')];
  }));
  const choose = (label: string): void => {
    setAnswers((current) => {
      const existing = current[question.question] ?? [];
      const next = question.multiSelect
        ? existing.includes(label) ? existing.filter((value) => value !== label) : [...existing, label]
        : [label];
      return { ...current, [question.question]: next };
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < question.options.length) {
      event.preventDefault();
      choose(question.options[index]!.label);
    }
  };
  const answered = selected.length > 0 && (!selected.includes('__other__') || Boolean(other[question.question]?.trim()));
  return (
    <div className="chat-dock__question" onKeyDown={onKeyDown}>
      {questions.length > 1 && <p className="chat-dock__step">{copy.approval.step(step + 1, questions.length)}</p>}
      {question.header && <p className="chat-dock__eyebrow">{question.header}</p>}
      <p className="chat-dock__prompt">{question.question}</p>
      <div className="chat-dock__options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
        {question.options.map((option, index) => (
          <button key={option.label} type="button" className="chat-dock__option" role={question.multiSelect ? 'checkbox' : 'radio'}
            aria-checked={selected.includes(option.label)} disabled={disabled} onClick={() => choose(option.label)}>
            <span className="chat-dock__option-key" aria-hidden="true">{index + 1}</span>
            <span className="chat-dock__option-text">
              <span className="chat-dock__option-label">{option.label}</span>
              {option.description && <span className="chat-dock__option-description">{option.description}</span>}
            </span>
          </button>
        ))}
        <button type="button" className="chat-dock__option" role={question.multiSelect ? 'checkbox' : 'radio'}
          aria-checked={selected.includes('__other__')} disabled={disabled} onClick={() => choose('__other__')}>
          <span className="chat-dock__option-key" aria-hidden="true">{question.options.length + 1}</span>
          <span className="chat-dock__option-text"><span className="chat-dock__option-label">{copy.approval.other}</span></span>
        </button>
      </div>
      {selected.includes('__other__') && (
        <input className="chat-dock__other" aria-label={copy.approval.otherPlaceholder} placeholder={copy.approval.otherPlaceholder}
          value={other[question.question] ?? ''} onChange={(event) => setOther((current) => ({ ...current, [question.question]: event.target.value }))} />
      )}
      <div className="chat-dock__actions">
        {!last && <Button variant="ghost" size="sm" onClick={() => setStep(step + 1)}>{copy.approval.skip}</Button>}
        {last
          ? <Button variant="primary" size="sm" disabled={disabled || !answered} loading={busy} onClick={() => onSubmit(finalAnswers())}>{copy.approval.submit}</Button>
          : <Button variant="primary" size="sm" disabled={!answered} onClick={() => setStep(step + 1)}>{copy.approval.next}</Button>}
      </div>
    </div>
  );
}

/** Esc in a dock (outside its text fields) folds it and returns to the message box. */
function foldOnEscape(event: KeyboardEvent<HTMLElement>, onCollapsedChange: (collapsed: boolean) => void): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if ((event.target as HTMLElement).closest('textarea, input')) return;
  event.preventDefault();
  const panel = event.currentTarget.closest('.structured-agent');
  onCollapsedChange(true);
  requestAnimationFrame(() => panel?.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')?.focus());
}

function PlanBody({ markdown, filePath }: { readonly markdown?: string; readonly filePath?: string }): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  return (
    <div className="chat-dock__plan">
      {markdown && <div className="chat-dock__scroll"><Prose markdown={markdown} variant={context.skin === 'cli' ? 'cli' : 'prose'} /></div>}
      {filePath && <p className="chat-dock__meta">{copy.planFile}: {filePath.replace(/^.*[\\/]/u, '')}</p>}
    </div>
  );
}

/**
 * Run the plan with the chosen access level, or keep planning. A host that
 * cannot take the level starts the plan asking before running, and says so.
 */
function PlanActions({ canRespond, access, busy, disabled, onApprove, onFeedback, onKeepPlanning }: {
  readonly canRespond: boolean;
  readonly access?: PlanAccessChoice;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onApprove: () => void;
  readonly onFeedback: () => void;
  readonly onKeepPlanning: () => void;
}): JSX.Element {
  const copy = useChatCopy();
  const levels = agentPermissionCopy(useChatLocale()).levels;
  return (
    <>
      {canRespond && access && (
        <div className="chat-dock__plan-access">
          <span>{copy.approval.planAccess}</span>
          <SettingPill label={copy.approval.planAccess} icon={access.level === 'full-access' ? ShieldAlert : ShieldCheck} value={access.level}
            options={ACCESS_LEVELS.map((level) => ({ value: level, label: levels[level].label, description: levels[level].hint }))}
            disabled={disabled || busy} onChange={access.onChange} testId="chat-dock-plan-access" />
        </div>
      )}
      {!canRespond && <p className="chat-dock__meta">{copy.approval.planAccessFixed}</p>}
      <div className="chat-dock__actions">
        {canRespond
          ? <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={onFeedback}>{copy.approval.keepPlanning}</Button>
          : <Button variant="secondary" size="sm" disabled={disabled || busy} onClick={onKeepPlanning}>{copy.approval.keepPlanningPlain}</Button>}
        <Button variant="primary" size="sm" disabled={disabled} loading={busy} onClick={onApprove} data-testid="chat-dock-approve-plan" data-dock-primary="">
          {copy.approval.approvePlan}
        </Button>
      </div>
    </>
  );
}

/**
 * The pending approval, docked where the composer sits. It can be collapsed to
 * a strip to keep typing without answering.
 */
export function ApprovalDock({ pending, pendingCount, canRespond, disabled = false, onResolve, collapsed, onCollapsedChange, planAccess }: ApprovalDockProps): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const { approval, request, tool } = pending;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState(false);
  const Icon = riskIcon(request?.kind);
  const title = dockTitle(pending, copy);
  const resolve = async (decision: 'allow' | 'deny', response?: ApprovalResponse): Promise<void> => {
    if (busy || disabled) return;
    setBusy(true);
    setError(undefined);
    const result = await onResolve(approval.id, decision, canRespond ? response : undefined)
      .catch((): ApprovalResult => ({ ok: false, message: 'The decision could not be delivered.' }));
    setBusy(false);
    if (!result.ok) setError(result.message);
  };
  const command = request?.kind === 'command' ? request.command : tool?.category === 'command' ? tool.command : undefined;
  const changes = useMemo(() => (request?.kind === 'file-change'
    ? request.files.filter((file) => file.diff).map((file) => ({ path: file.path, patch: approvalPatch(file.kind, file.diff!), coverage: 'fragment' as const }))
    : tool?.changes ?? []), [request, tool]);

  if (collapsed) {
    return (
      <div className="chat-dock chat-dock--collapsed" data-risk={approval.risk}>
        <Icon aria-hidden="true" />
        <span className="chat-dock__title">{request?.subagent ? `${request.subagent.title} · ${title}` : title}</span>
        {pendingCount > 1 && <span className="chat-dock__more">{copy.approval.pendingMore(pendingCount - 1)}</span>}
        <button type="button" className="chat-link-button" onClick={() => onCollapsedChange(false)}>
          <ChevronUp aria-hidden="true" />{copy.approval.expand}
        </button>
      </div>
    );
  }

  const body = (() => {
    if (request?.kind === 'question') {
      return <QuestionBody questions={request.questions} busy={busy} disabled={disabled || !canRespond}
        onSubmit={(answers) => void resolve('allow', { kind: 'answers', answers })} />;
    }
    if (request?.kind === 'plan') return <PlanBody markdown={request.markdown} filePath={request.filePath} />;
    return (
      <div className="chat-dock__detail">
        {command && <pre className="chat-output__command"><code>{`$ ${command}`}</code></pre>}
        {request?.kind === 'command' && request.cwd && <p className="chat-dock__meta">{copy.approval.cwd} {request.cwd}</p>}
        {changes.length > 0 && <div className="chat-dock__scroll">{changes.map((change, index) => <DiffView key={index} change={change} workspaceRoot={context.workspaceRoot} />)}</div>}
        {request?.kind === 'tool' && request.input && <OutputBlock text={request.input} label={copy.input} />}
        {request && 'reason' in request && request.reason && <p className="chat-dock__meta">{copy.approval.reason}: {request.reason}</p>}
        {!request && approval.detail && <p className="chat-dock__meta">{approval.detail}</p>}
      </div>
    );
  })();

  const plan = request?.kind === 'plan';
  const question = request?.kind === 'question';
  return (
    <section className="chat-dock" data-risk={approval.risk} aria-label={title} role="region" onKeyDown={(event) => foldOnEscape(event, onCollapsedChange)}>
      <header className="chat-dock__header">
        <Icon aria-hidden="true" />
        <div className="chat-dock__heading">
          {request?.subagent && (
            <p className="chat-dock__from">
              {copy.approval.fromSubagent(request.subagent.title)}
              {context.onOpenRelated && <button type="button" className="chat-link-button" onClick={() => context.onOpenRelated?.(request.subagent!.sessionId)}>{copy.openSubagent}</button>}
            </p>
          )}
          <p className="chat-dock__title">{title}</p>
          {/* A question or a plan is not an access request; its risk label would mislead. */}
          {!plan && !question && <p className="chat-dock__risk">{copy.approval.risk[approval.risk]}</p>}
        </div>
        {pendingCount > 1 && <span className="chat-dock__more">{copy.approval.pendingMore(pendingCount - 1)}</span>}
        <button type="button" className="chat-icon-action" aria-label={copy.approval.collapse} title={copy.approval.collapse} onClick={() => onCollapsedChange(true)}>
          <ChevronDown aria-hidden="true" />
        </button>
      </header>
      {body}
      {question && !canRespond && <p className="chat-dock__meta">{copy.approval.unsupportedAnswer}</p>}
      {feedback ? (
        <FeedbackForm
          label={plan ? copy.approval.keepPlanningLabel : copy.approval.feedbackLabel}
          submitLabel={copy.approval.sendFeedback}
          busy={busy}
          onCancel={() => setFeedback(false)}
          onSubmit={(message) => void resolve('deny', { kind: 'feedback', message })}
        />
      ) : plan ? (
        <PlanActions canRespond={canRespond} access={planAccess} busy={busy} disabled={disabled}
          onApprove={() => void resolve('allow', { kind: 'plan', mode: planAccess?.level ?? 'standard' })}
          onFeedback={() => setFeedback(true)}
          onKeepPlanning={() => void resolve('deny')} />
      ) : !question || !canRespond ? (
        <div className="chat-dock__actions">
          {canRespond && <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => setFeedback(true)}>
            {copy.approval.denyWithFeedback}
          </Button>}
          <Button variant="secondary" size="sm" disabled={disabled || busy} onClick={() => void resolve('deny')}>{copy.approval.deny}</Button>
          <Button variant="primary" size="sm" disabled={disabled} loading={busy} onClick={() => void resolve('allow')} data-dock-primary="">
            {copy.approval.allow}
          </Button>
        </div>
      ) : null}
      {error && <p className="chat-dock__error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * Codex plan mode ends its turn with a proposed plan and never asks about it.
 * This dock asks instead: run it with the chosen access level, or keep planning.
 */
export function ProposedPlanDock({ markdown, access, disabled = false, onApprove, onKeepPlanning, collapsed, onCollapsedChange }: {
  readonly markdown: string;
  readonly access: PlanAccessChoice;
  readonly disabled?: boolean;
  readonly onApprove: () => Promise<ApprovalResult>;
  readonly onKeepPlanning: (message: string) => Promise<ApprovalResult>;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}): JSX.Element {
  const copy = useChatCopy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState(false);
  const run = async (action: () => Promise<ApprovalResult>): Promise<void> => {
    if (busy || disabled) return;
    setBusy(true);
    setError(undefined);
    const result = await action().catch((): ApprovalResult => ({ ok: false, message: 'The decision could not be delivered.' }));
    setBusy(false);
    if (!result.ok) setError(result.message);
  };
  if (collapsed) {
    return (
      <div className="chat-dock chat-dock--collapsed" data-risk="read">
        <NotebookPen aria-hidden="true" />
        <span className="chat-dock__title">{copy.approval.planTitle}</span>
        <button type="button" className="chat-link-button" onClick={() => onCollapsedChange(false)}>
          <ChevronUp aria-hidden="true" />{copy.approval.expand}
        </button>
      </div>
    );
  }
  return (
    <section className="chat-dock" data-risk="read" aria-label={copy.approval.planTitle} role="region" data-testid="chat-dock-proposed-plan" onKeyDown={(event) => foldOnEscape(event, onCollapsedChange)}>
      <header className="chat-dock__header">
        <NotebookPen aria-hidden="true" />
        <div className="chat-dock__heading"><p className="chat-dock__title">{copy.approval.planTitle}</p></div>
        <button type="button" className="chat-icon-action" aria-label={copy.approval.collapse} title={copy.approval.collapse} onClick={() => onCollapsedChange(true)}>
          <ChevronDown aria-hidden="true" />
        </button>
      </header>
      <PlanBody markdown={markdown} />
      {feedback ? (
        <FeedbackForm label={copy.approval.keepPlanningLabel} submitLabel={copy.approval.sendFeedback} busy={busy}
          onCancel={() => setFeedback(false)} onSubmit={(message) => void run(() => onKeepPlanning(message))} />
      ) : (
        <PlanActions canRespond access={access} busy={busy} disabled={disabled}
          onApprove={() => void run(onApprove)} onFeedback={() => setFeedback(true)} onKeepPlanning={() => setFeedback(true)} />
      )}
      {error && <p className="chat-dock__error" role="alert">{error}</p>}
    </section>
  );
}
