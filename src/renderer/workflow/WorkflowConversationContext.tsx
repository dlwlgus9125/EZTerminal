import { useCallback, useEffect, useState } from 'react';
import { Glyph } from '../ui/Glyph';
import type { WorkflowAccess } from '../../shared/workflow';
import type { WorkflowConversationContext as ReferenceSnapshot } from '../../shared/workflow-conversation';
import { Badge, Button } from '../ui';
import { ChatMarkdown } from '../chat/markdown/ChatMarkdown';
import { useWorkflowCopy } from './workflow-copy';

export interface WorkflowConversationScope {
  readonly projectId: string;
  readonly subprojectId: string;
  readonly subprojectTitle: string;
  readonly nodeId?: string;
  readonly nodeTitle?: string;
  readonly revision: number;
  readonly readOnly: boolean;
  readonly mode: 'stage' | 'flow-edit' | 'run';
  readonly referenceSnapshot?: ReferenceSnapshot;
  readonly stale?: boolean;
}
export function useWorkflowConversationScope(access: Pick<WorkflowAccess, 'getWorkflowSnapshot'> & Partial<Pick<WorkflowAccess, 'executeWorkflowCommand'>> | undefined, projectId: string | undefined, sessionId: string | null | undefined): { scope: WorkflowConversationScope | null; loading: boolean; error?: string; refreshReferences: () => Promise<void>; retry: () => void } {
  const key = `${projectId ?? ''}:${sessionId ?? ''}`;
  const [state, setState] = useState<{ key: string; scope: WorkflowConversationScope | null; loading: boolean; error?: string }>({ key, scope: null, loading: !!access });
  const [reload, setReload] = useState(0);
  const refreshReferences = useCallback(async (): Promise<void> => {
    if (!access?.executeWorkflowCommand || !projectId || !sessionId) return;
    setState(previous => ({ ...previous, loading: true }));
    try {
      const current = await access.getWorkflowSnapshot(projectId); if (!current.ok) throw new Error(current.message);
      const link = current.snapshot.sessionLinks.find(item => item.sessionId === sessionId);
      const subproject = current.snapshot.subprojects.find(item => item.id === link?.subprojectId);
      if (!link || !subproject) throw new Error('The linked stage is unavailable.');
      const result = await access.executeWorkflowCommand({ type: 'session.refresh', commandId: `workflow-${crypto.randomUUID()}`, projectId, hostId: current.snapshot.hostId, expectedRevision: subproject.revision, subprojectId: subproject.id, payload: { sessionId } });
      if (!result.ok) throw new Error(result.message);
      setReload(value => value + 1);
    } catch (reason) { setState(previous => ({ ...previous, loading: false, error: String(reason) })); }
  }, [access, projectId, sessionId]);
  useEffect(() => {
    let current = true;
    if (!access || !projectId || !sessionId) { setState({ key, scope: null, loading: false }); return; }
    setState(previous => previous.key === key ? { ...previous, loading: true } : { key, scope: null, loading: true });
    const read = async (): Promise<void> => {
      try {
        const result = await access.getWorkflowSnapshot(projectId);
        if (!current) return;
        if (!result.ok) { setState(previous => ({ ...previous, key, loading: result.error !== 'unsupported', error: result.message })); return; }
        const { snapshot } = result;
        const liveLink = snapshot.sessionLinks.find(item => item.sessionId === sessionId);
        const link = liveLink ?? snapshot.historicalSessionLinks?.find(item => item.sessionId === sessionId);
        if (link) {
          const subproject = snapshot.subprojects.find(item => item.id === link.subprojectId);
          const node = subproject?.graph.nodes.find(item => item.id === link.nodeId);
          const archived = subproject?.archivedNodes.find(item => item.id === link.nodeId);
          setState({ key, loading: false, scope: { projectId, subprojectId: link.subprojectId, subprojectTitle: subproject?.title ?? link.subprojectId, nodeId: link.nodeId, nodeTitle: node?.title ?? archived?.title, revision: link.graphRevision, referenceSnapshot: link.referenceSnapshot, stale: link.scope === 'stage' && (link.referenceStale ?? !link.referenceSnapshot), readOnly: !liveLink || !subproject || subproject.status === 'archived' || !!link.nodeId && !node, mode: link.scope } });
          return;
        }
        const run = snapshot.runs.find(item => item.preparation.workflow && item.attempts.some(attempt => attempt.sessionId === sessionId));
        if (run?.preparation.workflow) {
          const frozen = run.preparation.workflow;
          const subproject = snapshot.subprojects.find(item => item.id === frozen.subprojectId);
          const attempt = run.attempts.find(item => item.sessionId === sessionId);
          const activation = run.workflowRuntime?.activations.find(item => item.attemptId === attempt?.attemptId);
          const node = frozen.graph.nodes.find(item => item.id === activation?.nodeId || item.id === attempt?.taskId);
          setState({ key, loading: false, scope: { projectId, subprojectId: frozen.subprojectId, subprojectTitle: subproject?.title ?? frozen.subprojectId, nodeId: node?.id, nodeTitle: node?.title, revision: frozen.revision, readOnly: false, mode: 'run' } }); return;
        }
        setState({ key, scope: null, loading: false });
      } catch (reason) { if (current) setState(previous => ({ ...previous, key, loading: true, error: String(reason) })); }
    };
    void read(); const timer = window.setInterval(() => void read(), 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [access, projectId, sessionId, key, reload]);
  return { ...(state.key === key ? state : { scope: null, loading: !!access }), refreshReferences, retry: () => setReload(value => value + 1) };
}
export function WorkflowConversationUnavailable({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  const text = useWorkflowCopy();
  return <aside className="workflow-conversation-context" role="status"><span>{message}</span><Button onClick={onRetry}>{text('작업 맥락 다시 확인', 'Retry workflow context')}</Button></aside>;
}
export function WorkflowConversationContext({ scope, onReturn, onRefresh, busy, error }: { readonly scope: WorkflowConversationScope; readonly onReturn?: () => void; readonly onRefresh?: () => Promise<void>; readonly busy?: boolean; readonly error?: string }): JSX.Element {
  const text = useWorkflowCopy();
  return <aside className="workflow-conversation-context" aria-label={text('대화의 작업 맥락', 'Conversation context')}>
    <span><strong>{scope.subprojectTitle}</strong>{scope.nodeTitle ? ` · ${scope.nodeTitle}` : scope.mode === 'flow-edit' ? text(' · 워크플로 편집', ' · Workflow editing') : ''}</span>
    <Badge>{scope.mode === 'run' ? text('실행 버전', 'Run version') : text('연결 버전', 'Linked version')} {scope.revision}</Badge>
    {scope.referenceSnapshot && <details><summary>{text('참조 중인 저장 단계 문서', 'Referenced saved stage document')} · v{scope.referenceSnapshot.graphRevision}</summary><p>{scope.referenceSnapshot.title}</p>{scope.referenceSnapshot.document ? <ChatMarkdown markdown={scope.referenceSnapshot.document} /> : <p>{text('저장된 본문 없음', 'No saved document text')}</p>}{scope.referenceSnapshot.references.map((reference, index) => <div key={`${reference.nodeId}-${index}`}><strong>{reference.title} · {reference.kind === 'document' ? text('단계 문서', 'Stage document') : text('실행 결과', 'Execution result')}</strong><pre>{reference.text}</pre></div>)}</details>}
    {scope.stale && !scope.readOnly && <span role="status">{text('저장 문서가 변경되었습니다. 이 대화는 표시된 참조 버전을 사용합니다.', 'The saved document changed. This conversation uses the reference version shown here.')}</span>}
    {scope.mode === 'stage' && !scope.readOnly && onRefresh && <Button disabled={busy} onClick={() => void onRefresh()}>{text('저장본으로 참조 갱신', 'Refresh references from saved version')}</Button>}
    {error && <span role="alert">{error}</span>}
    {scope.readOnly && <span role="status">{text('보관된 기록 · 읽기 전용', 'Archived record · read only')}</span>}
    {onReturn && <Button leadingIcon={<Glyph name="back" />} onClick={onReturn}>{scope.nodeId ? text('이 단계로 돌아가기', 'Return to this stage') : text('워크플로로 돌아가기', 'Return to workflow')}</Button>}
  </aside>;
}
