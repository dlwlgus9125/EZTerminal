import { ArrowDown, ArrowUp, GitBranch, List, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../../shared/workflow';
import { useAppTranslation } from '../i18n';
import { Badge, Button, Dialog, Field, IconButton, Input, Select } from '../ui';

export interface WorkflowEditorProps {
  readonly graph: WorkflowGraph;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (id: string) => void;
  readonly onChange: (graph: WorkflowGraph) => void;
  readonly readOnly?: boolean;
  readonly mobile?: boolean;
  readonly onOpenStage?: (id: string) => void;
  readonly providers?: readonly StructuredAgentProviderOption[];
}

const operations: WorkflowNode['operation'][] = ['agent', 'condition', 'parallel', 'join', 'approval', 'complete'];
const roles: WorkflowNode['role'][] = ['planning', 'design', 'implementation', 'review', 'integration'];
const outcomes: WorkflowEdge['outcome'][] = ['next', 'passed', 'failed', 'approved', 'rejected'];
export function useWorkflowCopy(): (ko: string, en: string) => string {
  const { i18n } = useAppTranslation();
  const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  return (ko, en) => korean ? ko : en;
}
export function workflowOperationLabel(operation: WorkflowNode['operation'], text: (ko: string, en: string) => string): string {
  const labels = { agent: text('AI 작업', 'AI task'), condition: text('조건 분기', 'Condition'), parallel: text('병렬 시작', 'Parallel'), join: text('결과 합류', 'Join'), approval: text('사용자 승인', 'Approval'), complete: text('완료', 'Complete') };
  return labels[operation];
}
export function workflowOutcomeLabel(outcome: string, text: (ko: string, en: string) => string): string {
  return ({ next: text('다음', 'Next'), passed: text('통과', 'Passed'), failed: text('실패', 'Failed'), approved: text('허용', 'Approved'), rejected: text('거절', 'Rejected') } as Record<string, string>)[outcome] ?? outcome;
}
export function workflowStateLabel(state: string, text: (ko: string, en: string) => string): string {
  return ({ prepared: text('준비됨', 'Prepared'), running: text('실행 중', 'Running'), paused: text('일시정지', 'Paused'), reconciling: text('결과 확인 중', 'Reconciling'), 'awaiting-review': text('검토 대기', 'Awaiting review'), waiting: text('대기', 'Waiting'), active: text('진행 중', 'Active'), 'awaiting-approval': text('승인 대기', 'Awaiting approval'), completed: text('완료', 'Completed'), cancelled: text('취소됨', 'Cancelled'), rejected: text('거절됨', 'Rejected'), 'retry-exhausted': text('재시도 한도 도달', 'Retry limit reached') } as Record<string, string>)[state] ?? state;
}

/** Graph and keyboard/touch list edit the same ID-addressed draft. Coordinates never imply execution order. */
export function WorkflowEditor({ graph, selectedNodeId, onSelectNode, onChange, readOnly = false, mobile = false, onOpenStage, providers = [] }: WorkflowEditorProps): JSX.Element {
  const text = useWorkflowCopy();
  const arrowId = `workflow-arrow-${useId().replace(/:/gu, '')}`;
  const [view, setView] = useState<'graph' | 'list'>(mobile ? 'list' : 'graph');
  const [newOperation, setNewOperation] = useState<WorkflowNode['operation']>('agent');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const selected = graph.nodes.find(node => node.id === selectedNodeId);
  const updateNode = (patch: Partial<WorkflowNode>): void => {
    if (selected && !readOnly) onChange({ ...graph, nodes: graph.nodes.map(node => node.id === selected.id ? { ...node, ...patch } : node) });
  };
  const addNode = (): void => {
    const id = `node-${crypto.randomUUID()}`;
    const value: WorkflowNode = { id, title: workflowOperationLabel(newOperation, text), operation: newOperation, role: 'implementation', instructions: '', document: '', acceptance: [], allowedPaths: [], inputs: [], retryLimit: 2, permissionPreset: 'plan', position: { x: 40 + graph.nodes.length % 3 * 260, y: 40 + Math.floor(graph.nodes.length / 3) * 140 }, ...(newOperation === 'join' ? { joinPolicy: 'all' as const } : {}) };
    onChange({ ...graph, entryNodeId: graph.entryNodeId || id, nodes: [...graph.nodes, value] });
    onSelectNode(id);
  };
  const updateEdge = (id: string, patch: Partial<WorkflowEdge>): void => onChange({ ...graph, edges: graph.edges.map(edge => edge.id === id ? { ...edge, ...patch } : edge) });
  const label = (id: string): string => graph.nodes.find(node => node.id === id)?.title ?? id;
  const extent = { width: Math.max(820, ...graph.nodes.map(node => node.position.x + 250)), height: Math.max(350, ...graph.nodes.map(node => node.position.y + 130)) };
  return <div className="workflow-editor" data-testid="workflow-editor">
    <div className="workflow-toolbar">
      <div role="group" aria-label={text('흐름 보기', 'Workflow view')}>
        <Button aria-pressed={view === 'graph'} onClick={() => setView('graph')} leadingIcon={<GitBranch />}>{text('그래프', 'Graph')}</Button>
        <Button aria-pressed={view === 'list'} onClick={() => setView('list')} leadingIcon={<List />}>{text('목록', 'List')}</Button>
      </div>
      {!readOnly && <div className="workflow-inline"><Select aria-label={text('추가할 단계 종류', 'New node type')} value={newOperation} onChange={event => setNewOperation(event.target.value as WorkflowNode['operation'])}>{operations.map(operation => <option key={operation} value={operation}>{workflowOperationLabel(operation, text)}</option>)}</Select><Button leadingIcon={<Plus />} onClick={addNode}>{text('단계 추가', 'Add stage')}</Button></div>}
    </div>
    <p className="workflow-hint">{text('연결선이 실행 순서를 결정합니다. 목록에서도 모든 단계와 연결을 편집할 수 있습니다.', 'Connections determine execution order. Every stage and connection can also be edited in the list.')}</p>
    <div className="workflow-editor__body">
      {view === 'graph' ? <div className="workflow-canvas" tabIndex={0} role="region" aria-label={text('흐름 그래프 · 내부 스크롤', 'Workflow graph · scrollable canvas')}><div className="workflow-canvas__content" style={extent}>
        <svg width={extent.width} height={extent.height} className="workflow-edges" aria-hidden="true"><defs><marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" /></marker></defs>{graph.edges.map(edge => {
          const from = graph.nodes.find(node => node.id === edge.from); const to = graph.nodes.find(node => node.id === edge.to);
          if (!from || !to) return null;
          const x1 = from.position.x + 210; const y1 = from.position.y + 40; const x2 = to.position.x; const y2 = to.position.y + 40;
          return <g key={edge.id}><path d={`M ${x1} ${y1} C ${x1 + 45} ${y1}, ${x2 - 45} ${y2}, ${x2} ${y2}`} markerEnd={`url(#${arrowId})`} /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>{workflowOutcomeLabel(edge.outcome, text)}</text></g>;
        })}</svg>
        {graph.nodes.map(node => <button type="button" className="workflow-node" key={node.id} data-selected={node.id === selectedNodeId || undefined} style={{ left: node.position.x, top: node.position.y }} onClick={() => onSelectNode(node.id)} aria-pressed={node.id === selectedNodeId}><small>{workflowOperationLabel(node.operation, text)}{graph.entryNodeId === node.id ? text(' · 시작', ' · Entry') : ''}</small><strong>{node.title || text('이름 없는 단계', 'Untitled stage')}</strong><span>{node.providerId ?? text('AI 설정 확인', 'Check AI settings')}</span></button>)}
      </div></div> : <ol className="workflow-node-list">{graph.nodes.map(node => <li key={node.id}><button type="button" className="workflow-item" aria-pressed={node.id === selectedNodeId} onClick={() => onSelectNode(node.id)}><strong>{node.title || text('이름 없는 단계', 'Untitled stage')}</strong><span>{workflowOperationLabel(node.operation, text)}{graph.entryNodeId === node.id ? text(' · 시작', ' · Entry') : ''}</span><small>{graph.edges.filter(edge => edge.from === node.id).map(edge => `${workflowOutcomeLabel(edge.outcome, text)} → ${label(edge.to)}`).join(' · ') || text('다음 연결 없음', 'No outgoing connection')}</small></button></li>)}</ol>}
      {selected ? <div className="workflow-inspector" aria-label={text('단계 편집', 'Stage editor')}>
        <div className="workflow-toolbar"><h3>{text('단계', 'Stage')}</h3><Badge>{selected.id === graph.entryNodeId ? text('시작점', 'Entry') : workflowOperationLabel(selected.operation, text)}</Badge>{onOpenStage && <Button onClick={() => onOpenStage(selected.id)}>{text('문서와 대화', 'Document and chats')}</Button>}</div>
        <Field label={text('단계 이름', 'Stage title')}><Input value={selected.title} maxLength={300} readOnly={readOnly} onChange={event => updateNode({ title: event.target.value })} /></Field>
        <Field label={text('동작', 'Operation')}><Select value={selected.operation} disabled={readOnly} onChange={event => updateNode({ operation: event.target.value as WorkflowNode['operation'] })}>{operations.map(operation => <option key={operation} value={operation}>{workflowOperationLabel(operation, text)}</option>)}</Select></Field>
        <Field label={text('역할', 'Role')}><Select value={selected.role} disabled={readOnly} onChange={event => updateNode({ role: event.target.value as WorkflowNode['role'] })}>{roles.map(role => <option key={role} value={role}>{({ planning: text('기획', 'Planning'), design: text('설계', 'Design'), implementation: text('구현', 'Implementation'), review: text('검토', 'Review'), integration: text('통합', 'Integration') })[role]}</option>)}</Select></Field>
        {selected.operation === 'agent' && <><Field label={text('AI 제공자', 'AI provider')}><Select value={selected.providerId ?? ''} disabled={readOnly} onChange={event => updateNode({ providerId: event.target.value || undefined, model: undefined })}><option value="">{text('선택하세요', 'Choose a provider')}</option>{selected.providerId && !providers.some(provider => provider.id === selected.providerId) && <option value={selected.providerId}>{selected.providerId} · {text('사용 불가', 'Unavailable')}</option>}{providers.map(provider => <option value={provider.id} key={provider.id} disabled={provider.disabled}>{provider.label}{provider.disabled ? text(' · 사용 불가', ' · Unavailable') : ''}</option>)}</Select></Field><Field label={text('모델', 'Model')} description={text('실행할 모델을 명시적으로 선택하세요.', 'Select the model that will execute this stage.')}><Select value={selected.model ?? ''} disabled={readOnly} onChange={event => updateNode({ model: event.target.value || undefined })}><option value="">{text('모델 선택', 'Choose a model')}</option>{selected.model && !providers.find(provider => provider.id === selected.providerId)?.models.some(model => model.id === selected.model) && <option value={selected.model}>{selected.model} · {text('재확인 필요', 'Recheck required')}</option>}{providers.find(provider => provider.id === selected.providerId)?.models.map(model => <option value={model.id} key={model.id}>{model.label}</option>)}</Select></Field><Field label={text('권한', 'Permissions')} description={text('관리형 실행은 지정된 작업 폴더와 경로를 사용합니다.', 'Managed execution uses its assigned workspace and allowed paths.')}><Select value={selected.permissionPreset} disabled={readOnly} onChange={event => updateNode({ permissionPreset: event.target.value as WorkflowNode['permissionPreset'] })}><option value="plan">Plan</option><option value="standard">Standard</option>{selected.permissionPreset === 'full-access' && <option value="full-access" disabled>{text('Full access · 관리형 실행에서 미지원', 'Full access · unsupported for managed execution')}</option>}</Select></Field></>}
        <label className="workflow-field">{text('지시', 'Instructions')}<textarea value={selected.instructions} readOnly={readOnly} onChange={event => updateNode({ instructions: event.target.value })} rows={4} /></label>
        {selected.operation === 'agent' && <><label className="workflow-field">{text('완료 조건 · 한 줄에 하나', 'Acceptance criteria · one per line')}<textarea value={selected.acceptance.join('\n')} readOnly={readOnly} onChange={event => updateNode({ acceptance: event.target.value.split('\n') })} rows={3} /></label>
        <label className="workflow-field">{text('수정 허용 경로 · 한 줄에 하나', 'Allowed paths · one per line')}<textarea value={selected.allowedPaths.join('\n')} readOnly={readOnly} onChange={event => updateNode({ allowedPaths: event.target.value.split('\n') })} rows={2} /></label></>}
        <fieldset className="workflow-connections"><legend>{text('참조할 입력', 'Input references')}</legend>{graph.nodes.filter(node => node.id !== selected.id).map(node => <label className="workflow-inline" key={node.id}><input type="checkbox" disabled={readOnly} checked={selected.inputs.some(input => input.nodeId === node.id)} onChange={event => updateNode({ inputs: event.target.checked ? [...selected.inputs, { nodeId: node.id, kind: 'document' }] : selected.inputs.filter(input => input.nodeId !== node.id) })} />{node.title}<Select aria-label={`${node.title} ${text('참조 종류', 'reference type')}`} value={selected.inputs.find(input => input.nodeId === node.id)?.kind ?? 'document'} disabled={readOnly || !selected.inputs.some(input => input.nodeId === node.id)} onChange={event => updateNode({ inputs: selected.inputs.map(input => input.nodeId === node.id ? { ...input, kind: event.target.value as 'document' | 'result' } : input) })}><option value="document">{text('문서', 'Document')}</option><option value="result">{text('실행 결과', 'Execution result')}</option></Select></label>)}</fieldset>
        <Field label={text('추가 시도 한도', 'Retry limit')}><Input type="number" min={0} max={20} value={selected.retryLimit} readOnly={readOnly} onChange={event => updateNode({ retryLimit: Math.min(20, Math.max(0, Number(event.target.value))) })} /></Field>
        {selected.operation === 'condition' && <><Field label={text('판단할 단계 결과', 'Result source')}><Select value={selected.condition?.sourceNodeId ?? ''} disabled={readOnly} onChange={event => updateNode({ condition: { sourceNodeId: event.target.value, field: 'outcome', equals: selected.condition?.equals ?? 'passed' } })}><option value="">{text('단계를 선택하세요', 'Choose a stage')}</option>{graph.nodes.filter(node => node.id !== selected.id).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</Select></Field><Field label={text('비교할 결과', 'Expected outcome')}><Select value={selected.condition?.equals ?? 'passed'} disabled={readOnly} onChange={event => updateNode({ condition: { sourceNodeId: selected.condition?.sourceNodeId ?? '', field: 'outcome', equals: event.target.value as 'passed' | 'failed' } })}><option value="passed">{text('통과', 'Passed')}</option><option value="failed">{text('실패', 'Failed')}</option></Select></Field></>}
        {selected.operation === 'join' && <Field label={text('합류 조건', 'Join policy')}><Select value={selected.joinPolicy ?? 'all'} disabled={readOnly} onChange={event => updateNode({ joinPolicy: event.target.value as 'all' | 'any' })}><option value="all">{text('모든 결과 도착', 'All results')}</option><option value="any">{text('하나 이상 도착', 'Any result')}</option></Select></Field>}
        <fieldset className="workflow-connections"><legend>{text('다음 연결', 'Outgoing connections')}</legend>{graph.edges.filter(edge => edge.from === selected.id).map(edge => <div className="workflow-edge-row" key={edge.id}><Select aria-label={text('연결 조건', 'Connection outcome')} value={edge.outcome} disabled={readOnly} onChange={event => updateEdge(edge.id, { outcome: event.target.value as WorkflowEdge['outcome'] })}>{outcomes.map(outcome => <option key={outcome} value={outcome}>{({ next: text('다음', 'Next'), passed: text('통과', 'Passed'), failed: text('실패', 'Failed'), approved: text('허용', 'Approved'), rejected: text('거절', 'Rejected') })[outcome]}</option>)}</Select><Select aria-label={text('다음 단계', 'Next stage')} value={edge.to} disabled={readOnly} onChange={event => updateEdge(edge.id, { to: event.target.value })}>{graph.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</Select><Input aria-label={text('연결 반복 한도', 'Connection retry limit')} type="number" min="0" max="20" value={edge.retryLimit ?? ''} readOnly={readOnly} onChange={event => updateEdge(edge.id, { retryLimit: event.target.value ? Number(event.target.value) : undefined })} /><IconButton aria-label={text('연결 삭제', 'Remove connection')} icon={Trash2} disabled={readOnly} onClick={() => onChange({ ...graph, edges: graph.edges.filter(item => item.id !== edge.id) })} /></div>)}{!readOnly && <Button onClick={() => { const target = graph.nodes.find(node => node.id !== selected.id); if (target) onChange({ ...graph, edges: [...graph.edges, { id: `edge-${crypto.randomUUID()}`, from: selected.id, to: target.id, outcome: 'next' }] }); }} disabled={graph.nodes.length < 2} leadingIcon={<Plus />}>{text('연결 추가', 'Add connection')}</Button>}</fieldset>
        {!readOnly && <><div className="workflow-inline"><Button disabled={graph.entryNodeId === selected.id} onClick={() => onChange({ ...graph, entryNodeId: selected.id })}>{text('시작점으로 지정', 'Set as entry')}</Button><IconButton icon={ArrowUp} aria-label={text('화면에서 위로 이동', 'Move up on canvas')} onClick={() => updateNode({ position: { ...selected.position, y: Math.max(0, selected.position.y - 140) } })} /><IconButton icon={ArrowDown} aria-label={text('화면에서 아래로 이동', 'Move down on canvas')} onClick={() => updateNode({ position: { ...selected.position, y: selected.position.y + 140 } })} /></div><Button variant="danger" leadingIcon={<Trash2 />} onClick={() => setRemoveId(selected.id)}>{text('단계 삭제', 'Delete stage')}</Button></>}
      </div> : <p role="status">{text('단계를 선택해 편집하세요.', 'Select a stage to edit.')}</p>}
    </div>
    <Dialog open={removeId !== null} onOpenChange={open => { if (!open) setRemoveId(null); }} title={text('단계를 삭제할까요?', 'Delete this stage?')} description={text('연결도 초안에서 제거합니다. 저장된 대화·문서·실행 기록은 보관됩니다.', 'Connections are removed from the draft. Saved conversations, documents and execution records remain in history.')} closeLabel={text('닫기', 'Close')} footer={<><Button onClick={() => setRemoveId(null)}>{text('취소', 'Cancel')}</Button><Button variant="danger" onClick={() => { if (removeId) onChange({ ...graph, nodes: graph.nodes.filter(node => node.id !== removeId), edges: graph.edges.filter(edge => edge.from !== removeId && edge.to !== removeId), entryNodeId: graph.entryNodeId === removeId ? null : graph.entryNodeId }); setRemoveId(null); }}>{text('삭제', 'Delete')}</Button></>}><p>{removeId ? label(removeId) : ''}</p></Dialog>
  </div>;
}
