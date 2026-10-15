import { ChevronDown, ChevronUp, FileDiff, MessageCircleQuestion, NotebookPen, ShieldAlert, ShieldQuestion, SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { ApprovalQuestion, ApprovalResponse } from '../../../shared/approval-request';
import { Button } from '../../ui';
import { useChatCopy } from '../copy';
import { useChatContext } from '../ChatContext';
import type { PendingInteraction } from '../model/types';
import { DiffView } from '../parts/DiffView';
import { OutputBlock } from '../parts/ToolDetail';
import { Prose } from '../parts/Prose';

export interface ApprovalResult {
  readonly ok: boolean;
  readonly message?: string;
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
        <textarea ref={ref} rows={2} value={message} onChange={(event) => setMessage(event.target.value)} />
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

/**
 * The pending approval, docked where the composer sits. It can be collapsed to
 * a strip to keep typing without answering.
 */
export function ApprovalDock({ pending, pendingCount, canRespond, disabled = false, onResolve, collapsed, onCollapsedChange }: ApprovalDockProps): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const { approval, request, tool } = pending;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState(false);
  const Icon = riskIcon(request?.kind);
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
    ? request.files.filter((file) => file.diff).map((file) => ({ path: file.path, patch: file.diff!, coverage: 'fragment' as const }))
    : tool?.changes ?? []), [request, tool]);

  if (collapsed) {
    return (
      <div className="chat-dock chat-dock--collapsed" data-risk={approval.risk}>
        <Icon aria-hidden="true" />
        <span className="chat-dock__title">{approval.title}</span>
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
    if (request?.kind === 'plan') {
      return (
        <div className="chat-dock__plan">
          {request.markdown && <div className="chat-dock__scroll"><Prose markdown={request.markdown} variant={context.skin === 'cli' ? 'cli' : 'prose'} /></div>}
          {request.filePath && <p className="chat-dock__meta">{copy.planFile}: {request.filePath.replace(/^.*[\\/]/u, '')}</p>}
        </div>
      );
    }
    return (
      <div className="chat-dock__detail">
        {command && <pre className="chat-output__command"><code>{`$ ${command}`}</code></pre>}
        {request?.kind === 'command' && request.cwd && <p className="chat-dock__meta">{copy.approval.cwd} {request.cwd}</p>}
        {changes.length > 0 && <div className="chat-dock__scroll">{changes.map((change, index) => <DiffView key={index} change={change} />)}</div>}
        {request?.kind === 'tool' && request.input && <OutputBlock text={request.input} label={copy.input} />}
        {request && 'reason' in request && request.reason && <p className="chat-dock__meta">{copy.approval.reason}: {request.reason}</p>}
        {!request && approval.detail && <p className="chat-dock__meta">{approval.detail}</p>}
      </div>
    );
  })();

  const plan = request?.kind === 'plan';
  const question = request?.kind === 'question';
  return (
    <section className="chat-dock" data-risk={approval.risk} aria-label={approval.title} role="region">
      <header className="chat-dock__header">
        <Icon aria-hidden="true" />
        <div className="chat-dock__heading">
          <p className="chat-dock__title">{plan ? copy.approval.planTitle : approval.title}</p>
          <p className="chat-dock__risk">{copy.approval.risk[approval.risk]}</p>
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
      ) : !question || !canRespond ? (
        <div className="chat-dock__actions">
          {canRespond && <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => setFeedback(true)}>
            {plan ? copy.approval.keepPlanning : copy.approval.denyWithFeedback}
          </Button>}
          {!plan && <Button variant="secondary" size="sm" disabled={disabled || busy} onClick={() => void resolve('deny')}>{copy.approval.deny}</Button>}
          {plan && canRespond && <Button variant="secondary" size="sm" disabled={disabled || busy} onClick={() => void resolve('allow', { kind: 'plan', mode: 'full-access' })}>{copy.approval.approvePlanFull}</Button>}
          <Button variant="primary" size="sm" disabled={disabled} loading={busy}
            onClick={() => void resolve('allow', plan ? { kind: 'plan', mode: 'standard' } : undefined)}>
            {plan ? copy.approval.approvePlan : copy.approval.allow}
          </Button>
        </div>
      ) : null}
      {error && <p className="chat-dock__error" role="alert">{error}</p>}
    </section>
  );
}
