import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { AppI18nProvider } from '../../i18n';
import { Badge, Button } from '../../ui';
import { projectRunOverlay } from '../workflow-canvas-model';
import { workflowCanvasFixture, type WorkflowCanvasScenario } from '../workflow-fixtures';
import { workflowRunStatusPresentation } from '../WorkflowNodeCard';
import { useWorkflowCopy, workflowOperationLabel, workflowOutcomeLabel } from '../workflow-copy';
import { InHouseFlowCanvas } from './InHouseFlowCanvas';
import { ReactFlowCanvas } from './ReactFlowCanvas';
import type { CanvasSelection, WorkflowCanvasRendererProps } from './spike-types';
import '../../index.css';

/**
 * A/B comparison for the one-canvas flow view (plan Phase 1a). Not a product story:
 * excluded from story tests and visual baselines, deleted once the user picks a renderer.
 */
const RENDERERS: Record<'a' | 'b', { title: [string, string]; Canvas: ComponentType<WorkflowCanvasRendererProps> }> = {
  a: { title: ['A · React Flow', 'A · React Flow'], Canvas: ReactFlowCanvas },
  b: { title: ['B · 자체 캔버스', 'B · In-house canvas'], Canvas: InHouseFlowCanvas },
};
const SCENARIOS: Array<[WorkflowCanvasScenario, string, string]> = [['edit', '편집 중', 'Editing'], ['retry-running', '재시도 진행 중', 'Retry running'], ['awaiting-approval', '승인 대기', 'Awaiting approval']];

function Comparison({ renderer, initialScenario, locale }: { renderer: 'a' | 'b'; initialScenario: WorkflowCanvasScenario; locale: 'ko' | 'en' }): JSX.Element {
  const text = useWorkflowCopy();
  const [scenario, setScenario] = useState(initialScenario);
  // Lay out with the card size at the current UI scale (cards are rem-sized; positions are px).
  const [rem, setRem] = useState(() => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  useEffect(() => {
    const update = () => setRem(parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    window.addEventListener('ez:ui-scale', update);
    return () => window.removeEventListener('ez:ui-scale', update);
  }, []);
  const fixture = useMemo(() => workflowCanvasFixture(scenario, locale, { width: 15.5 * rem, height: 8.5 * rem }), [scenario, locale, rem]);
  const [graphs, setGraphs] = useState<Partial<Record<WorkflowCanvasScenario, typeof fixture.graph>>>({});
  const graph = graphs[scenario] ?? fixture.graph;
  const overlay = useMemo(() => fixture.run ? projectRunOverlay(fixture.run) : null, [fixture]);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const { Canvas, title } = RENDERERS[renderer];
  const node = selection?.kind === 'node' ? graph.nodes.find(entry => entry.id === selection.id) : undefined;
  const edge = selection?.kind === 'edge' ? graph.edges.find(entry => entry.id === selection.id) : undefined;
  const run = node ? overlay?.nodes[node.id] : undefined;
  return <section className="wf-spike" aria-label={title[locale === 'ko' ? 0 : 1]}>
    <header className="wf-spike__header">
      <h2>{title[locale === 'ko' ? 0 : 1]}</h2>
      <div role="group" aria-label={text('장면', 'Scenario')} className="wf-spike__scenarios">
        {SCENARIOS.map(([id, ko, en]) => <Button key={id} size="sm" aria-pressed={scenario === id} onClick={() => { setScenario(id); setSelection(null); }}>{text(ko, en)}</Button>)}
      </div>
      {overlay && <Badge variant={overlay.awaitingApproval.length ? 'warning' : 'neutral'}>{overlay.awaitingApproval.length ? text(`승인 대기 ${overlay.awaitingApproval.length}`, `${overlay.awaitingApproval.length} awaiting approval`) : text('실행 v4 진행 중', 'Run v4 running')}</Badge>}
    </header>
    <div className="wf-spike__body">
      <div className="wf-spike__canvas"><Canvas graph={graph} overlay={overlay} editable selection={selection} onSelect={setSelection} onGraphChange={next => setGraphs(current => ({ ...current, [scenario]: next }))} text={text} /></div>
      <aside className="wf-spike__panel" aria-label={text('선택한 항목', 'Selection')}>
        {node ? <>
          <small>{workflowOperationLabel(node.operation, text)}</small>
          <h3>{node.title}</h3>
          {run && <p>{workflowRunStatusPresentation(run, text).label}{run.iteration > 0 ? ` · ${text(`회차 ${run.iteration + 1}`, `round ${run.iteration + 1}`)}` : ''}</p>}
          {run?.status === 'awaiting-approval' && <div className="wf-spike__actions"><Button variant="primary">{text('허용', 'Approve')}</Button><Button>{text('거절', 'Reject')}</Button></div>}
          {node.operation === 'agent' && <div className="wf-spike__actions"><Button>{text('작업 대화 열기', 'Open task conversation')}</Button><Button>{text('단계 문서', 'Stage document')}</Button></div>}
          <p className="wf-spike__hint">{text('시안 단계에서는 이 자리에 설정 · 단계 문서·대화 · 실행 상태 섹션이 들어갑니다.', 'In the mockup this panel holds Settings · Stage documents and chats · Run status.')}</p>
        </> : edge ? <>
          <small>{text('연결', 'Connection')}</small>
          <h3>{workflowOutcomeLabel(edge.outcome, text)}</h3>
          <p>{text('Delete 키로 지웁니다.', 'Press Delete to remove it.')}</p>
        </> : <p className="wf-spike__hint">{text('노드를 누르면 여기서 그 단계를 제어합니다. 출력 핸들(오른쪽 동그라미)에서 다른 노드로 끌면 연결됩니다.', 'Select a stage to control it here. Drag from an output handle (right circle) to another stage to connect.')}</p>}
      </aside>
    </div>
  </section>;
}

function SpikeStory({ renderer, scenario = 'retry-running', locale = 'ko' }: { renderer: 'a' | 'b' | 'both'; scenario?: WorkflowCanvasScenario; locale?: 'ko' | 'en' }): JSX.Element {
  return <AppI18nProvider locale={locale} languages={[locale]}>
    <style>{SPIKE_LAYOUT}</style>
    <div className="wf-spike-root" data-both={renderer === 'both' || undefined}>
      {renderer === 'both' ? <><Comparison renderer="a" initialScenario={scenario} locale={locale} /><Comparison renderer="b" initialScenario={scenario} locale={locale} /></>
        : <Comparison renderer={renderer} initialScenario={scenario} locale={locale} />}
    </div>
  </AppI18nProvider>;
}
// Spike-only page layout; tokens only.
const SPIKE_LAYOUT = `
.wf-spike-root { height: 100vh; display: grid; gap: var(--ui-space-3); padding: var(--ui-space-3); box-sizing: border-box; background: var(--ui-surface); color: var(--ui-text-primary); font-family: var(--ui-font-body); }
.wf-spike-root[data-both] { grid-template-rows: 1fr 1fr; }
.wf-spike { min-height: 0; display: grid; grid-template-rows: auto 1fr; gap: var(--ui-space-2); }
.wf-spike__header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--ui-space-3); }
.wf-spike__header h2 { margin: 0; font-size: var(--ui-font-size-lg); }
.wf-spike__scenarios { display: flex; gap: var(--ui-space-1); }
.wf-spike__scenarios [aria-pressed='true'] { border-color: var(--ui-accent); background: var(--ui-surface-selected); }
.wf-spike__body { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 17rem; gap: var(--ui-space-3); }
.wf-spike__canvas { min-height: 0; }
.wf-spike__panel { min-height: 0; overflow: auto; padding: var(--ui-space-3); border-radius: var(--ui-radius-lg); background: var(--ui-surface-inset); }
.wf-spike__panel h3 { margin: var(--ui-space-1) 0; }
.wf-spike__panel small, .wf-spike__hint { color: var(--ui-text-muted); }
.wf-spike__actions { display: flex; flex-wrap: wrap; gap: var(--ui-space-2); margin-block: var(--ui-space-2); }
`;

const meta = {
  title: 'Spike/Workflow canvas A-B',
  component: SpikeStory,
  tags: ['!test'],
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
} satisfies Meta<typeof SpikeStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SideBySide: Story = { name: 'A·B 나란히', args: { renderer: 'both' } };
export const ReactFlowA: Story = { name: 'A · React Flow', args: { renderer: 'a' } };
export const InHouseB: Story = { name: 'B · 자체 캔버스', args: { renderer: 'b' } };
export const ReactFlowAEnglish: Story = { name: 'A · English', args: { renderer: 'a', locale: 'en' } };
export const InHouseBEnglish: Story = { name: 'B · English', args: { renderer: 'b', locale: 'en' } };
