import { Glyph, glyphIcon, type GlyphIcon } from '../ui/Glyph';
import type { ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowCommand, WorkflowNode } from '../../shared/workflow';
import { Badge, Button, IconButton, Menu, MenuItem } from '../ui';
import type { WorkflowCanvasMode } from './workflow-canvas-model';
import { workflowOperationLabel, type WorkflowCopy } from './workflow-copy';

type RunCommand = Extract<WorkflowCommand, { type: 'run.start' | 'run.pause' | 'run.resume' | 'run.approve' | 'run.cancel' | 'run.integrate' }>;
export type WorkflowRunCommandInput<C = RunCommand> = C extends RunCommand ? Pick<C, 'type' | 'payload'> : never;
const OPERATIONS: Array<[WorkflowNode['operation'], GlyphIcon]> = [['agent', glyphIcon('bot')], ['approval', glyphIcon('req')], ['condition', glyphIcon('flow')], ['parallel', glyphIcon('flow')], ['join', glyphIcon('merge')], ['complete', glyphIcon('flag')]];

export interface WorkflowCanvasHeaderProps {
  readonly text: WorkflowCopy;
  readonly mode: WorkflowCanvasMode;
  readonly revision: number;
  readonly hasLocalDraft: boolean;
  /** A run exists but its frozen flow is not what is being edited: offer its read-only view. */
  readonly diverged: boolean;
  readonly run: ExecutionRun | null;
  readonly editLocked: boolean;
  readonly commandsDisabled: boolean;
  /** "단계 편집": stages and connections can be added, moved and joined. */
  readonly structure: boolean;
  readonly onStructureChange: (open: boolean) => void;
  /** Stored positions overlap at the current card size: offer a one-click tidy. */
  readonly overlapping: boolean;
  readonly layout: 'graph' | 'list';
  readonly onLayoutChange: (layout: 'graph' | 'list') => void;
  readonly onRunView: (open: boolean) => void;
  readonly onAddStage: (operation: WorkflowNode['operation']) => void;
  readonly onSaveDraft: () => void;
  readonly onDiscardDraft: () => void;
  readonly onAutoLayout: () => void;
  /** The stage panel beside the canvas can be hidden for a wider canvas (absent on Android). */
  readonly panelToggle?: { readonly open: boolean; readonly controls: string; readonly onToggle: () => void };
}

/**
 * Above the canvas, the editing tools: the draft and its save, "단계 편집" (add, move and connect
 * stages), the graph/list switch and the panel. The run's own line is WorkflowRunBar.
 */
export function WorkflowCanvasHeader(props: WorkflowCanvasHeaderProps): JSX.Element {
  const { text, mode, run, editLocked, commandsDisabled } = props;
  const ended = run ? run.state === 'completed' || run.state === 'cancelled' : true;
  const version = run?.preparation.workflow?.revision ?? '?';
  return <div className="workflow-canvas-header" data-mode={mode}>
    {mode === 'run-view' && run && <div className="workflow-canvas-header__banner" role="status">
      <Glyph name="eye" /><span>{text(`실행 v${version}이 시작할 때 고정된 워크플로입니다. 여기서는 편집할 수 없습니다.`, `The workflow frozen when run v${version} started. It cannot be edited here.`)}</span>
      <Button size="sm" leadingIcon={<Glyph name="back" />} onClick={() => props.onRunView(false)}>{text('편집으로 돌아가기', 'Back to editing')}</Button>
    </div>}
    <div className="workflow-canvas-header__row">
      {mode === 'run-view' ? <Badge>{text(`실행 v${version} · 읽기 전용`, `Run v${version} · read-only`)}</Badge>
        : <div className="workflow-canvas-header__group" role="group" aria-label={text('초안', 'Draft')}>
          {props.hasLocalDraft ? <Badge variant="warning">{text('미저장 변경', 'Unsaved changes')}</Badge> : <Badge>{`${text('워크플로', 'Workflow')} v${props.revision}`}</Badge>}
          {props.hasLocalDraft && <>
            <Button size="sm" variant="primary" leadingIcon={<Glyph name="save" />} disabled={editLocked || commandsDisabled} onClick={props.onSaveDraft}>{text('초안 저장', 'Save draft')}</Button>
            <Button size="sm" leadingIcon={<Glyph name="undo" />} disabled={editLocked} onClick={props.onDiscardDraft}>{text('변경 취소', 'Discard changes')}</Button>
          </>}
          <Button size="sm" variant="ghost" leadingIcon={<Glyph name="edit" />} aria-pressed={props.structure} disabled={editLocked} onClick={() => props.onStructureChange(!props.structure)} data-testid="workflow-structure-toggle">
            {props.structure ? text('단계 편집 끝', 'Done editing stages') : text('단계 편집', 'Edit stages')}
          </Button>
          {props.structure && <Menu label={text('추가할 단계 종류', 'New stage type')} trigger={<Button size="sm" leadingIcon={<Glyph name="plus" />} disabled={editLocked}>{text('단계 추가', 'Add stage')}</Button>}>
            {OPERATIONS.map(([operation, icon]) => <MenuItem key={operation} icon={icon} onSelect={() => props.onAddStage(operation)}>{workflowOperationLabel(operation, text)}</MenuItem>)}
          </Menu>}
          {props.diverged && <Button size="sm" leadingIcon={<Glyph name="wt" />} onClick={() => props.onRunView(true)}>{ended ? text('최근 실행 보기', 'View last run') : text('진행 중인 실행 보기', 'View running run')}</Button>}
        </div>}
      <div className="workflow-canvas-header__view" role="group" aria-label={text('워크플로 보기', 'Workflow view')}>
        <IconButton icon={glyphIcon('flow')} aria-pressed={props.layout === 'graph'} aria-label={text('그래프', 'Graph')} onClick={() => props.onLayoutChange('graph')} />
        <IconButton icon={glyphIcon('list')} aria-pressed={props.layout === 'list'} aria-label={text('목록', 'List')} onClick={() => props.onLayoutChange('list')} />
        {props.panelToggle && <IconButton icon={props.panelToggle.open ? glyphIcon('panelClose') : glyphIcon('panelOpen')} aria-expanded={props.panelToggle.open} aria-controls={props.panelToggle.controls}
          aria-label={props.panelToggle.open ? text('단계 패널 접기', 'Hide stage panel') : text('단계 패널 펼치기', 'Show stage panel')} onClick={props.panelToggle.onToggle} />}
      </div>
    </div>
    {props.overlapping && props.structure && mode !== 'run-view' && props.layout === 'graph' && <p className="workflow-canvas-header__overlap" role="status"><span>{text('겹쳐 있는 단계가 있습니다.', 'Some stages overlap.')}</span><Button size="sm" leadingIcon={<Glyph name="grid" />} disabled={editLocked} onClick={props.onAutoLayout}>{text('자동 정렬', 'Tidy layout')}</Button></p>}
  </div>;
}
