import { useId } from 'react';
import { Button } from '../ui';
import { Glyph, Led } from '../ui/Glyph';
import type { WorkflowCopy } from './workflow-copy';
import './workflow-agents.css';

export interface WorkflowAnswerBoxProps {
  readonly text: WorkflowCopy;
  /** What the stage asks, written by the flow (or the previous stage's questions). */
  readonly question: string;
  /** The stage whose result the question is about. */
  readonly from?: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange?: (value: string) => void;
  readonly onSend?: () => void;
  readonly onOpenResult?: () => void;
}

/**
 * A stage that waits for the person's answer (a requirements interview, feedback on a mockup).
 * No model runs while it waits; the answer is saved with the run and goes to the next stage.
 */
export function WorkflowAnswerBox({ text, question, from, value, disabled = false, onChange, onSend, onOpenResult }: WorkflowAnswerBoxProps): JSX.Element {
  const id = useId();
  return <section className="workflow-answer" aria-labelledby={`${id}-head`} data-testid="workflow-stage-answer">
    <p id={`${id}-head`} className="workflow-answer__head"><Led tone="amber" /><span>{text('내 답을 기다림', 'Waiting for your answer')}</span></p>
    <p className="workflow-answer__question">{question}</p>
    {from && <p className="workflow-answer__from">{text(`'${from}' 단계 결과를 바탕으로 묻습니다. 기다리는 동안 AI는 돌지 않습니다.`, `Asked from the '${from}' result. No AI runs while it waits.`)}</p>}
    <label className="ez-ui-visually-hidden" htmlFor={`${id}-answer`}>{text('답', 'Answer')}</label>
    <textarea id={`${id}-answer`} value={value} disabled={disabled} onChange={event => onChange?.(event.target.value)} placeholder={text('답을 쓰세요. 다음 단계가 이 답을 받아 이어갑니다.', 'Write your answer. The next stage picks it up.')} />
    <div className="workflow-answer__actions">
      <Button variant="primary" disabled={disabled || !value.trim()} onClick={onSend} leadingIcon={<Glyph name="send" />}>{text('답 보내기', 'Send answer')}</Button>
      {onOpenResult && <Button variant="ghost" onClick={onOpenResult} leadingIcon={<Glyph name="eye" />}>{text('앞 단계 결과 보기', 'See the previous result')}</Button>}
    </div>
  </section>;
}
