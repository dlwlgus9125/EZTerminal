import { useId, type DragEvent } from 'react';
import { Button } from '../ui';
import { Glyph } from '../ui/Glyph';
import type { WorkflowCopy } from './workflow-copy';
import './workflow-agents.css';

/** An agent from Settings › AI › 에이전트, as the flow lists it (who does the work; the stage says what). */
export interface WorkflowAgentListItem {
  readonly id: string;
  readonly name: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly effortLabel?: string;
  readonly permissionLabel: string;
  readonly whenToUse?: string;
  readonly tone: 'codex' | 'claude' | 'other';
  /** Stages of this flow it is placed on. */
  readonly usedOn?: number;
}

export interface WorkflowAgentListProps {
  readonly text: WorkflowCopy;
  readonly agents: readonly WorkflowAgentListItem[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The selected stage "배정" places an agent on; without one the button says what to pick first. */
  readonly targetStage?: string;
  /** The agent being dragged right now (it dims in the list while its chip follows the pointer). */
  readonly dragging?: string;
  readonly onAssign?: (agentId: string) => void;
  readonly onDragAgent?: (agentId: string | null) => void;
  readonly onManage?: () => void;
  /** `sheet`: the phone's picker (no dragging; every row assigns to the stage it opened from). */
  readonly variant?: 'panel' | 'sheet';
}

/** The data type a stage drop target accepts. */
export const WORKFLOW_AGENT_DRAG_TYPE = 'application/x-ezterminal-agent';

/**
 * The agents a flow can use, at the top of the canvas side panel: drag one onto a stage, or pick a
 * stage and press 배정 (keyboard and phone). Agents are defined in Settings; here they are only placed.
 */
export function WorkflowAgentList({ text, agents, open, onOpenChange, targetStage, dragging, onAssign, onDragAgent, onManage, variant = 'panel' }: WorkflowAgentListProps): JSX.Element {
  const listId = useId();
  const sheet = variant === 'sheet';
  const start = (event: DragEvent<HTMLLIElement>, id: string) => {
    event.dataTransfer.setData(WORKFLOW_AGENT_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'copy';
    onDragAgent?.(id);
  };
  return <section className="workflow-agents" data-variant={variant} data-open={open || undefined} aria-label={text('에이전트', 'Agents')} data-testid="workflow-agent-list">
    {!sheet && <header className="workflow-agents__head">
      <button type="button" className="workflow-agents__toggle" aria-expanded={open} aria-controls={listId} onClick={() => onOpenChange(!open)}>
        <Glyph name={open ? 'down' : 'next'} />
        <span className="workflow-agents__title">{text('에이전트', 'Agents')}</span>
        <span className="workflow-agents__count">{agents.length}</span>
      </button>
      {onManage && <Button size="sm" variant="ghost" leadingIcon={<Glyph name="set" />} onClick={onManage}>{text('설정에서 관리', 'Manage in Settings')}</Button>}
    </header>}
    {(open || sheet) && <>
      <p className="workflow-agents__hint">{sheet
        ? text(`'${targetStage ?? ''}' 단계에 놓을 에이전트를 고르세요. 노력·권한은 단계에서 바꿀 수 있습니다.`, `Pick the agent for '${targetStage ?? ''}'. The stage can change its effort and permission.`)
        : targetStage
          ? text(`단계로 끌어다 놓거나, '배정'으로 '${targetStage}'에 놓습니다.`, `Drag onto a stage, or press Assign to place it on '${targetStage}'.`)
          : text('단계로 끌어다 놓으세요. 단계를 고르면 \'배정\'으로도 놓을 수 있습니다.', 'Drag onto a stage. Select a stage to place one with Assign too.')}</p>
      <ul id={listId} className="workflow-agents__list">
        {agents.map(agent => <li key={agent.id} className="workflow-agent" data-tone={agent.tone} data-dragging={dragging === agent.id || undefined}
          draggable={!sheet} onDragStart={sheet ? undefined : event => start(event, agent.id)} onDragEnd={sheet ? undefined : () => onDragAgent?.(null)}>
          {!sheet && <Glyph name="grip" className="workflow-agent__grip" />}
          <span className="workflow-agent__lamp" aria-hidden="true" />
          <div className="workflow-agent__body">
            <strong className="workflow-agent__name">{agent.name}</strong>
            <span className="workflow-agent__detail">{[agent.providerLabel, agent.model, agent.effortLabel, agent.permissionLabel].filter(Boolean).join(' · ')}</span>
            {agent.whenToUse && <span className="workflow-agent__when">{agent.whenToUse}</span>}
          </div>
          {agent.usedOn ? <span className="workflow-agent__used">{text(`${agent.usedOn}곳`, `${agent.usedOn} stages`)}</span> : null}
          <Button size="sm" variant={sheet ? 'primary' : 'secondary'} disabled={!targetStage || !onAssign} onClick={() => onAssign?.(agent.id)}
            title={targetStage ? undefined : text('먼저 캔버스에서 단계를 고르세요', 'Select a stage on the canvas first')}
            aria-label={targetStage ? text(`${agent.name}을(를) '${targetStage}'에 배정`, `Assign ${agent.name} to '${targetStage}'`) : text(`${agent.name} 배정 · 단계를 먼저 고르세요`, `Assign ${agent.name} · select a stage first`)}>
            {text('배정', 'Assign')}
          </Button>
        </li>)}
      </ul>
      {!sheet && onManage && <Button size="sm" variant="ghost" leadingIcon={<Glyph name="plus" />} onClick={onManage} className="workflow-agents__new">{text('새 에이전트', 'New agent')}</Button>}
    </>}
  </section>;
}
