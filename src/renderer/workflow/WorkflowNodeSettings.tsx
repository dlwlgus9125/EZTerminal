import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '../../shared/workflow-graph';
import { workflowOutcomePorts } from '../../shared/workflow-graph';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import { Button, Field, IconButton, Input, Select } from '../ui';
import { workflowOperationLabel, workflowOutcomeLabel, workflowPermissionLabel, type WorkflowCopy } from './workflow-copy';

const operations: WorkflowNode['operation'][] = ['agent', 'condition', 'parallel', 'join', 'approval', 'complete'];
const roles: WorkflowNode['role'][] = ['planning', 'design', 'implementation', 'review', 'integration'];

/**
 * The stage form: every setting the canvas can change is also editable here, without dragging.
 * `structure` keeps only what decides where the stage sits in the flow (the stage panel shows its own
 * settings above it).
 */
export function WorkflowNodeSettings({ graph, node, text, readOnly, providers, onChange, onRequestDelete, onMove, part = 'all', titleLocked = false }: {
  readonly graph: WorkflowGraph; readonly node: WorkflowNode; readonly text: WorkflowCopy; readonly readOnly: boolean;
  readonly providers: readonly StructuredAgentProviderOption[];
  readonly part?: 'all' | 'structure';
  /** The stage is working: its title (one of its own settings) cannot change until it finishes. */
  readonly titleLocked?: boolean;
  readonly onChange: (graph: WorkflowGraph) => void;
  readonly onRequestDelete?: (nodeId: string) => void;
  /** Only where the canvas cannot drag (static renderer): nudges the stored position. */
  readonly onMove?: (nodeId: string, dy: number) => void;
}): JSX.Element {
  const update = (patch: Partial<WorkflowNode>) => { if (!readOnly) onChange({ ...graph, nodes: graph.nodes.map(item => item.id === node.id ? { ...item, ...patch } : item) }); };
  const updateEdge = (id: string, patch: Partial<WorkflowEdge>) => onChange({ ...graph, edges: graph.edges.map(edge => edge.id === id ? { ...edge, ...patch } : edge) });
  const provider = providers.find(item => item.id === node.providerId);
  const ports = workflowOutcomePorts(node.operation);
  const others = graph.nodes.filter(item => item.id !== node.id);
  return <div className="workflow-inspector workflow-node-settings">
    <Field label={text('단계 이름', 'Stage title')}><Input value={node.title} maxLength={300} readOnly={readOnly || titleLocked} onChange={event => update({ title: event.target.value })} /></Field>
    <Field label={text('동작', 'Operation')}><Select value={node.operation} disabled={readOnly} onChange={event => update({ operation: event.target.value as WorkflowNode['operation'] })}>{operations.map(operation => <option key={operation} value={operation}>{workflowOperationLabel(operation, text)}</option>)}</Select></Field>
    <Field label={text('역할', 'Role')}><Select value={node.role} disabled={readOnly} onChange={event => update({ role: event.target.value as WorkflowNode['role'] })}>{roles.map(role => <option key={role} value={role}>{({ planning: text('기획', 'Planning'), design: text('설계', 'Design'), implementation: text('구현', 'Implementation'), review: text('검토', 'Review'), integration: text('통합', 'Integration') })[role]}</option>)}</Select></Field>
    {node.operation === 'agent' && part === 'all' && <>
      <Field label={text('AI 제공자', 'AI provider')}><Select value={node.providerId ?? ''} disabled={readOnly} onChange={event => update({ providerId: event.target.value || undefined, model: undefined })}><option value="">{text('선택하세요', 'Choose a provider')}</option>{node.providerId && !provider && <option value={node.providerId}>{node.providerId} · {text('사용 불가', 'Unavailable')}</option>}{providers.map(item => <option value={item.id} key={item.id} disabled={item.disabled}>{item.label}{item.disabled ? text(' · 사용 불가', ' · Unavailable') : ''}</option>)}</Select></Field>
      <Field label={text('모델', 'Model')} description={text('실행할 모델을 명시적으로 선택하세요.', 'Select the model that will execute this stage.')}><Select value={node.model ?? ''} disabled={readOnly} onChange={event => update({ model: event.target.value || undefined })}><option value="">{text('모델 선택', 'Choose a model')}</option>{node.model && !provider?.models.some(model => model.id === node.model) && <option value={node.model}>{node.model} · {text('재확인 필요', 'Recheck required')}</option>}{provider?.models.map(model => <option value={model.id} key={model.id}>{model.label}</option>)}</Select></Field>
      <Field label={text('권한', 'Permissions')} description={text('관리형 실행은 지정된 작업 폴더와 경로를 사용합니다.', 'Managed execution uses its assigned workspace and allowed paths.')}><Select value={node.permissionPreset} disabled={readOnly} onChange={event => update({ permissionPreset: event.target.value as WorkflowNode['permissionPreset'] })}><option value="plan">{workflowPermissionLabel('plan', text)}</option><option value="standard">{workflowPermissionLabel('standard', text)}</option>{node.permissionPreset === 'full-access' && <option value="full-access" disabled>{`${workflowPermissionLabel('full-access', text)} · ${text('관리형 실행에서 미지원', 'unsupported for managed execution')}`}</option>}</Select></Field>
    </>}
    {part === 'all' && <label className="workflow-field">{text('지시', 'Instructions')}<textarea value={node.instructions} readOnly={readOnly} onChange={event => update({ instructions: event.target.value })} rows={4} /></label>}
    {node.operation === 'agent' && part === 'all' && <>
      <label className="workflow-field">{text('완료 조건 · 한 줄에 하나', 'Acceptance criteria · one per line')}<textarea value={node.acceptance.join('\n')} readOnly={readOnly} onChange={event => update({ acceptance: event.target.value.split('\n') })} rows={3} /></label>
      <label className="workflow-field">{text('수정 허용 경로 · 한 줄에 하나', 'Allowed paths · one per line')}<textarea value={node.allowedPaths.join('\n')} readOnly={readOnly} onChange={event => update({ allowedPaths: event.target.value.split('\n') })} rows={2} /></label>
    </>}
    <fieldset className="workflow-connections"><legend>{text('참조할 입력', 'Input references')}</legend>{others.map(item => <label className="workflow-inline" key={item.id}><input type="checkbox" disabled={readOnly} checked={node.inputs.some(input => input.nodeId === item.id)} onChange={event => update({ inputs: event.target.checked ? [...node.inputs, { nodeId: item.id, kind: 'document' }] : node.inputs.filter(input => input.nodeId !== item.id) })} />{item.title}<Select aria-label={`${item.title} ${text('참조 종류', 'reference type')}`} value={node.inputs.find(input => input.nodeId === item.id)?.kind ?? 'document'} disabled={readOnly || !node.inputs.some(input => input.nodeId === item.id)} onChange={event => update({ inputs: node.inputs.map(input => input.nodeId === item.id ? { ...input, kind: event.target.value as 'document' | 'result' } : input) })}><option value="document">{text('문서', 'Document')}</option><option value="result">{text('실행 결과', 'Execution result')}</option></Select></label>)}</fieldset>
    {part === 'all' && <Field label={text('추가 시도 한도', 'Retry limit')}><Input type="number" min={0} max={20} value={node.retryLimit} readOnly={readOnly} onChange={event => update({ retryLimit: Math.min(20, Math.max(0, Number(event.target.value))) })} /></Field>}
    {node.operation === 'condition' && <>
      <Field label={text('판단할 단계 결과', 'Result source')}><Select value={node.condition?.sourceNodeId ?? ''} disabled={readOnly} onChange={event => update({ condition: { sourceNodeId: event.target.value, field: 'outcome', equals: node.condition?.equals ?? 'passed' } })}><option value="">{text('단계를 선택하세요', 'Choose a stage')}</option>{others.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field>
      <Field label={text('비교할 결과', 'Expected outcome')}><Select value={node.condition?.equals ?? 'passed'} disabled={readOnly} onChange={event => update({ condition: { sourceNodeId: node.condition?.sourceNodeId ?? '', field: 'outcome', equals: event.target.value as 'passed' | 'failed' } })}><option value="passed">{text('통과', 'Passed')}</option><option value="failed">{text('실패', 'Failed')}</option></Select></Field>
    </>}
    {node.operation === 'join' && <Field label={text('합류 조건', 'Join policy')}><Select value={node.joinPolicy ?? 'all'} disabled={readOnly} onChange={event => update({ joinPolicy: event.target.value as 'all' | 'any' })}><option value="all">{text('모든 결과 도착', 'All results')}</option><option value="any">{text('하나 이상 도착', 'Any result')}</option></Select></Field>}
    <fieldset className="workflow-connections"><legend>{text('다음 연결', 'Outgoing connections')}</legend>
      {graph.edges.filter(edge => edge.from === node.id).map(edge => <div className="workflow-edge-row" key={edge.id}>
        <Select aria-label={text('연결 조건', 'Connection outcome')} value={edge.outcome} disabled={readOnly} onChange={event => updateEdge(edge.id, { outcome: event.target.value as WorkflowEdge['outcome'] })}>{[...new Set([...ports, edge.outcome])].map(outcome => <option key={outcome} value={outcome}>{workflowOutcomeLabel(outcome, text)}</option>)}</Select>
        <Select aria-label={text('다음 단계', 'Next stage')} value={edge.to} disabled={readOnly} onChange={event => updateEdge(edge.id, { to: event.target.value })}>{graph.nodes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select>
        <Input aria-label={text('연결 반복 한도', 'Connection retry limit')} type="number" min="0" max="20" value={edge.retryLimit ?? ''} readOnly={readOnly} onChange={event => updateEdge(edge.id, { retryLimit: event.target.value ? Number(event.target.value) : undefined })} />
        <IconButton aria-label={text('연결 삭제', 'Remove connection')} icon={Trash2} disabled={readOnly} onClick={() => onChange({ ...graph, edges: graph.edges.filter(item => item.id !== edge.id) })} />
      </div>)}
      {!readOnly && ports.length > 0 && <Button onClick={() => { const target = others[0]; if (target) onChange({ ...graph, edges: [...graph.edges, { id: `edge-${crypto.randomUUID()}`, from: node.id, to: target.id, outcome: ports[0] }] }); }} disabled={others.length === 0} leadingIcon={<Plus />}>{text('연결 추가', 'Add connection')}</Button>}
    </fieldset>
    {!readOnly && <div className="workflow-inline">
      <Button disabled={graph.entryNodeId === node.id} onClick={() => onChange({ ...graph, entryNodeId: node.id })}>{text('시작점으로 지정', 'Set as entry')}</Button>
      {onMove && <><IconButton icon={ArrowUp} aria-label={text('화면에서 위로 이동', 'Move up on canvas')} onClick={() => onMove(node.id, -140)} /><IconButton icon={ArrowDown} aria-label={text('화면에서 아래로 이동', 'Move down on canvas')} onClick={() => onMove(node.id, 140)} /></>}
    </div>}
    {!readOnly && onRequestDelete && <Button variant="danger" leadingIcon={<Trash2 />} onClick={() => onRequestDelete(node.id)}>{text('단계 삭제', 'Delete stage')}</Button>}
  </div>;
}

/** A selected connection: what it routes, where, and how many retries it allows. */
export function WorkflowEdgeInspector({ graph, edge, text, readOnly, taken, onChange, onSelectNode }: {
  readonly graph: WorkflowGraph; readonly edge: WorkflowEdge; readonly text: WorkflowCopy; readonly readOnly: boolean; readonly taken?: number;
  readonly onChange: (graph: WorkflowGraph) => void; readonly onSelectNode: (nodeId: string) => void;
}): JSX.Element {
  const source = graph.nodes.find(node => node.id === edge.from);
  const target = graph.nodes.find(node => node.id === edge.to);
  const update = (patch: Partial<WorkflowEdge>) => onChange({ ...graph, edges: graph.edges.map(item => item.id === edge.id ? { ...item, ...patch } : item) });
  return <div className="workflow-inspector workflow-edge-inspector">
    <p className="workflow-edge-inspector__route"><Button variant="ghost" onClick={() => source && onSelectNode(source.id)}>{source?.title ?? edge.from}</Button><span aria-hidden="true">→</span><Button variant="ghost" onClick={() => target && onSelectNode(target.id)}>{target?.title ?? edge.to}</Button></p>
    {taken !== undefined && <p role="status">{edge.retryLimit ? text(`이 실행에서 재시도 ${taken}/${edge.retryLimit}회 사용`, `This run used ${taken}/${edge.retryLimit} retries`) : taken > 0 ? text(`이 실행에서 ${taken}번 지나감`, `Taken ${taken}× in this run`) : text('이 실행에서는 지나가지 않음', 'Not taken in this run')}</p>}
    <Field label={text('연결 조건', 'Connection outcome')}><Select value={edge.outcome} disabled={readOnly} onChange={event => update({ outcome: event.target.value as WorkflowEdge['outcome'] })}>{[...new Set([...(source ? workflowOutcomePorts(source.operation) : []), edge.outcome])].map(outcome => <option key={outcome} value={outcome}>{workflowOutcomeLabel(outcome, text)}</option>)}</Select></Field>
    <Field label={text('다음 단계', 'Next stage')}><Select value={edge.to} disabled={readOnly} onChange={event => update({ to: event.target.value })}>{graph.nodes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field>
    <Field label={text('재시도 한도', 'Retry limit')} description={text('실패·거절로 앞 단계로 돌아가는 연결에만 씁니다.', 'Only for a failure or rejection that returns to an earlier stage.')}><Input type="number" min="0" max="20" value={edge.retryLimit ?? ''} readOnly={readOnly} onChange={event => update({ retryLimit: event.target.value ? Number(event.target.value) : undefined })} /></Field>
    {!readOnly && <Button variant="danger" leadingIcon={<Trash2 />} onClick={() => onChange({ ...graph, edges: graph.edges.filter(item => item.id !== edge.id) })}>{text('연결 삭제', 'Remove connection')}</Button>}
  </div>;
}
