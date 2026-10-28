import { Button, Dialog } from '../ui';
import { Glyph } from '../ui/Glyph';
import type { WorkflowCopy } from './workflow-copy';
import './workflow-agents.css';

export interface WorkflowCheckConsentProps {
  readonly text: WorkflowCopy;
  readonly open: boolean;
  /** The command exactly as it will run. */
  readonly command: string;
  /** Where it runs: the stage's isolated result folder (never the project folder itself). */
  readonly location: string;
  /** What the command really calls (e.g. the package.json script `pnpm test` runs). */
  readonly resolved?: { readonly label: string; readonly value: string };
  /**
   * Why a person is asked: a new command, a changed command, or the stage's result changed the script the
   * command calls since it was allowed (then the earlier allow no longer counts).
   */
  readonly reason: 'new' | 'changed' | 'script-changed';
  readonly before?: string;
  readonly onAllow?: () => void;
  readonly onClose: () => void;
}

/**
 * 확인하고 허용: a check command runs the stage's result, so a person reads exactly what will run, where,
 * and what changed before allowing it once. Allowing runs nothing now; the result shows when the stage runs it.
 */
export function WorkflowCheckConsent({ text, open, command, location, resolved, reason, before, onAllow, onClose }: WorkflowCheckConsentProps): JSX.Element {
  const why = reason === 'new' ? text('이 워크플로에 새로 생긴 명령입니다.', 'A new command in this workflow.')
    : reason === 'changed' ? text('허용한 뒤 명령이 바뀌었습니다.', 'The command changed after it was allowed.')
      : text('이 단계의 결과가 명령이 부르는 스크립트를 바꿨습니다. 앞서 한 허용은 더 이상 쓰지 않습니다.', 'This stage’s result changed the script the command calls; the earlier allow no longer counts.');
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }} title={text('확인 명령 허용', 'Allow a check command')} closeLabel={text('닫기', 'Close')}
    description={text('허용하면 이 명령을 이 단계 결과에서 실행할 수 있습니다. 지금 실행하지는 않고, 결과(통과·실패)는 단계를 실행할 때 보입니다.', 'Allowing lets this command run on this stage’s result. Nothing runs now; pass or fail shows when the stage runs.')}
    footer={<><Button onClick={onClose}>{text('취소', 'Cancel')}</Button><Button variant="primary" onClick={onAllow} leadingIcon={<Glyph name="key" />}>{text('이 명령 허용', 'Allow this command')}</Button></>}>
    <p className="workflow-consent__why" data-reason={reason}><Glyph name="warn" />{why}</p>
    <dl className="workflow-consent__facts">
      <dt>{text('명령', 'Command')}</dt><dd><code>{command}</code></dd>
      <dt>{text('실행 위치', 'Runs in')}</dt><dd><code>{location}</code></dd>
      {resolved && <><dt>{resolved.label}</dt><dd><code>{resolved.value}</code></dd></>}
      {before && <><dt>{text('이전', 'Before')}</dt><dd><code className="workflow-consent__before">{before}</code></dd></>}
    </dl>
    <p className="workflow-consent__note">{text('받은 저장소에 들어 있던 명령도 같습니다: 이 PC에서 사람이 한 번 허용해야 실행됩니다. 10분이 넘으면 멈추고, 성능 측정 명령은 따로 허락해야 합니다.', 'Commands that came with a cloned repository too: a person on this PC allows them once. It stops after 10 minutes; performance measurements need separate permission.')}</p>
  </Dialog>;
}
