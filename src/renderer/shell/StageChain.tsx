import { Led } from '../ui';
import type { LiveFlow, StageLamp } from './shell-model';
import { useShellText } from './shell-text';

const TONE: Record<StageLamp, 'on' | 'amber' | 'red' | 'ok' | 'idle'> = { done: 'on', run: 'on', wait: 'amber', fail: 'red', idle: 'idle' };

/** A run's stages as lamps on a wire. Compact: only a stage that works or waits keeps its name on screen. */
export function StageChain({ stages, compact = false, onOpenConversation }: {
  readonly stages: LiveFlow['stages'];
  readonly compact?: boolean;
  /** Opens a stage's conversation in this run (stages not started yet have none). */
  readonly onOpenConversation?: (sessionId: string) => void;
}): JSX.Element {
  const { text } = useShellText();
  const stateText = (state: StageLamp): string => state === 'done' ? text('끝남', 'done')
    : state === 'wait' ? text('기다림', 'waiting') : state === 'run' ? text('작업 중', 'working')
      : state === 'fail' ? text('실패', 'failed') : text('대기', 'not started');
  return (
    <span className="ez-shell-chain" data-compact={compact || undefined}>
      {stages.map((stage, index) => {
        const label = compact && stage.state !== 'wait' && stage.state !== 'run'
          ? <span className="ez-ui-visually-hidden">{stage.title}</span>
          : stage.title;
        const body = <><Led tone={TONE[stage.state]} />{label}<span className="ez-ui-visually-hidden">{` · ${stateText(stage.state)}`}</span></>;
        return (
          <span key={stage.id} style={{ display: 'contents' }}>
            {index > 0 && <span className="ez-shell-wire" data-on={stage.state !== 'idle' || undefined} aria-hidden="true" />}
            {onOpenConversation && stage.sessionId
              ? <button type="button" className="ez-shell-stage" data-state={stage.state} title={text(`${stage.title} 대화 열기`, `Open the ${stage.title} conversation`)}
                onClick={() => onOpenConversation(stage.sessionId!)} data-testid="shell-stage-chip">{body}</button>
              : <span className="ez-shell-stage" data-state={stage.state} title={stage.title}>{body}</span>}
          </span>
        );
      })}
    </span>
  );
}
