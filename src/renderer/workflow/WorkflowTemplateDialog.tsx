import { useId } from 'react';
import { Button, Dialog, Field, Input } from '../ui';
import { Glyph } from '../ui/Glyph';
import type { WorkflowCopy } from './workflow-copy';
import './workflow-agents.css';

/** One step of a template's chain as the picker shows it. */
export interface WorkflowTemplateStep { readonly label: string; readonly kind?: 'agent' | 'person' | 'check' }
export interface WorkflowTemplateChoice {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly origin: 'builtin' | 'user';
  readonly steps: readonly WorkflowTemplateStep[];
  /** What it needs before it runs, e.g. "에이전트 3개(계획·구현·검토) · 확인 명령 1개". */
  readonly needs?: string;
}

export interface WorkflowTemplatePickerProps {
  readonly text: WorkflowCopy;
  readonly open: boolean;
  readonly templates: readonly WorkflowTemplateChoice[];
  readonly selected: string;
  readonly name: string;
  readonly onSelect: (id: string) => void;
  readonly onNameChange: (name: string) => void;
  readonly onCreate: () => void;
  readonly onClose: () => void;
}

/** 새 워크플로: start from a template — the two built-ins or one saved here — with its stage chain shown. */
export function WorkflowTemplatePicker({ text, open, templates, selected, name, onSelect, onNameChange, onCreate, onClose }: WorkflowTemplatePickerProps): JSX.Element {
  const group = useId();
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title={text('새 워크플로', 'New workflow')} closeLabel={text('닫기', 'Close')}
    description={text('템플릿에서 시작합니다. 단계 지시·완료 조건·확인 명령이 채워져 있습니다. 만든 뒤 단계마다 에이전트를 놓고, 확인 명령과 바꿀 수 있는 경로가 이 프로젝트에 맞는지 확인합니다(명령은 이 PC에서 한 번 허용).', 'Start from a template: stage instructions, acceptance and checks are filled in. Then place an agent on each stage and check that the commands and editable paths fit this project (commands are allowed once on this PC).')}
    footer={<><Button onClick={onClose}>{text('취소', 'Cancel')}</Button><Button variant="primary" disabled={!name.trim()} onClick={onCreate}>{text('이 템플릿으로 만들기', 'Create from this template')}</Button></>}>
    <Field label={text('이름', 'Name')}><Input value={name} onChange={event => onNameChange(event.target.value)} /></Field>
    <div className="workflow-templates" role="radiogroup" aria-label={text('템플릿', 'Templates')}>
      {templates.map(template => <div key={template.id} className="workflow-template">
        <label data-checked={template.id === selected || undefined}>
          <input type="radio" name={group} value={template.id} checked={template.id === selected} onChange={() => onSelect(template.id)} />
          <span className="workflow-template__title"><Glyph name={template.origin === 'builtin' ? 'flow' : 'star'} /><span>{template.title}</span>
            <span className="workflow-template__origin">{template.origin === 'builtin' ? text('기본', 'Built-in') : text('내 템플릿', 'Mine')}</span>
            {template.id === selected && <span className="workflow-template__selected"><Glyph name="check" />{text('선택됨', 'Selected')}</span>}</span>
          <span className="workflow-template__desc">{template.description}</span>
          <span className="workflow-template__chain" aria-label={text('단계', 'Stages')}>{template.steps.map((step, index) => <span key={`${step.label}-${index}`} data-kind={step.kind}>{step.kind === 'person' ? text(`사람: ${step.label}`, `Person: ${step.label}`) : step.kind === 'check' ? text(`명령: ${step.label}`, `Check: ${step.label}`) : step.label}</span>)}</span>
          {template.needs && <span className="workflow-template__needs">{template.needs}</span>}
        </label>
      </div>)}
    </div>
  </Dialog>;
}

export interface WorkflowTemplateSaveProps {
  readonly text: WorkflowCopy;
  readonly open: boolean;
  readonly name: string;
  readonly description: string;
  readonly keepAgents: boolean;
  readonly onNameChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onKeepAgentsChange: (value: boolean) => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
}

/** ⋯ › 템플릿으로 저장: this flow's stages, instructions and checks become a template every project can use. */
export function WorkflowTemplateSave({ text, open, name, description, keepAgents, onNameChange, onDescriptionChange, onKeepAgentsChange, onSave, onClose }: WorkflowTemplateSaveProps): JSX.Element {
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title={text('템플릿으로 저장', 'Save as template')} closeLabel={text('닫기', 'Close')}
    description={text('단계·지시·완료 조건·확인 명령을 저장합니다. 실행 기록과 대화는 저장하지 않습니다. 모든 프로젝트에서 새 워크플로를 만들 때 고를 수 있습니다.', 'Saves the stages, instructions, acceptance and checks — not runs or conversations. Any project can start a workflow from it.')}
    footer={<><Button onClick={onClose}>{text('취소', 'Cancel')}</Button><Button variant="primary" disabled={!name.trim()} onClick={onSave}>{text('저장', 'Save')}</Button></>}>
    <Field label={text('이름', 'Name')}><Input value={name} onChange={event => onNameChange(event.target.value)} /></Field>
    <Field label={text('설명', 'Description')}><Input value={description} onChange={event => onDescriptionChange(event.target.value)} /></Field>
    <label className="workflow-field workflow-field--check"><input type="checkbox" checked={keepAgents} onChange={event => onKeepAgentsChange(event.target.checked)} />
      {text('단계에 놓은 에이전트도 함께 저장. 다른 PC에서는 이름이 같은 에이전트를 후보로만 보여 주고, AI·모델이 맞는지 확인한 뒤 연결합니다(맞는 것이 없으면 "에이전트 없음").', 'Keep the agents placed on stages. Another PC only suggests agents with the same name and connects them once you confirm the AI and model match (otherwise “agent missing”).')}</label>
  </Dialog>;
}
