import { useCallback, useEffect, useRef, useState } from 'react';
import { Glyph } from '../ui/Glyph';
import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { DaemonProviderManagementResult, ProviderModel } from '../../shared/daemon-provider';
import { planningAiProviderSupported, planningAiProfileChain, planningAiRole, type PlanningAiApi, type PlanningAiJob, type PlanningAiRequest, type PlanningAiResult, type PlanningAiTarget } from '../../shared/planning-ai';
import type { PlanningSnapshot } from '../../shared/planning';
import { useAppTranslation } from '../i18n';
import { Badge, Button, Field, Select } from '../ui';
import { sceneIdentity } from './scene-model';
import './planning-ai.css';

export interface PlanningAiAccess extends PlanningAiApi {
  getDaemonSnapshot(): Promise<DaemonSnapshot | null>;
  listDaemonProviderModels(providerId: string): Promise<DaemonProviderManagementResult<readonly ProviderModel[]>>;
}
export interface PlanningAiPanelProps {
  readonly snapshot: PlanningSnapshot;
  readonly target?: PlanningAiTarget;
  readonly access: PlanningAiAccess;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly pendingRequest: PlanningAiRequest | null;
  readonly persistPendingRequest: (request: PlanningAiRequest | null) => Promise<void>;
  readonly onApplied: (snapshot: PlanningSnapshot) => void;
  readonly onOpenConversation?: (sessionId: string) => void;
}
interface Change { readonly path: string; readonly before: string; readonly after: string; }
function content(value: unknown): string { return value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value); }
export function planningProposalChanges(before: unknown, after: unknown, at = ''): Change[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    const previous: unknown[] = Array.isArray(before) ? before : []; const next: unknown[] = Array.isArray(after) ? after : [];
    const count = Math.max(previous.length, next.length);
    return Array.from({ length: count }, (_, index) => {
      const entry = next[index] ?? previous[index]; const label = entry && typeof entry === 'object' && 'id' in entry ? String(entry.id) : index + 1;
      return planningProposalChanges(previous[index], next[index], `${at} / ${label}`);
    }).flat();
  }
  if ((before && typeof before === 'object') || (after && typeof after === 'object')) {
    const previous = (before ?? {}) as Record<string, unknown>; const next = (after ?? {}) as Record<string, unknown>;
    return [...new Set([...Object.keys(previous), ...Object.keys(next)])].flatMap(key => planningProposalChanges(previous[key], next[key], at ? `${at} / ${key}` : key));
  }
  return [{ path: at, before: content(before), after: content(after) }];
}

/** Explicit generation and review share host revision checks and encrypted pending-command recovery. */
export function PlanningAiPanel({ snapshot, target: fixedTarget, access, disabled = false, disabledReason, pendingRequest, persistPendingRequest, onApplied, onOpenConversation }: PlanningAiPanelProps): JSX.Element {
  const { i18n } = useAppTranslation(); const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => ko ? korean : english;
  const stateLabel = (state: PlanningAiJob['state']): string => ({ prepared: text('전송 준비', 'Prepared'), generating: text('생성 중', 'Generating'), ready: text('검토 대기', 'Ready for review'), failed: text('생성 실패', 'Failed'), uncertain: text('결과 확인 필요', 'Unconfirmed'), applied: text('적용됨', 'Applied') })[state];
  const changeLabel = (value: string): string => value.split(' / ').map(key => ({ title: text('이름', 'Title'), body: text('본문', 'Body'), acceptance: text('수용 기준', 'Acceptance criteria'), instructions: text('역할 지시', 'Instructions'), allowedTools: text('허용 도구', 'Allowed tools'), retryLimit: text('재시도 한도', 'Retry limit'), elements: text('화면 요소', 'Elements'), properties: text('속성', 'Properties'), layout: text('배치', 'Layout'), text: text('표시 문구', 'Text'), accessibleName: text('접근 가능한 이름', 'Accessible name') } as Record<string, string>)[key] ?? key).join(' / ');
  const targetTitle = (id: string): string => [...snapshot.draft.items, ...snapshot.draft.tasks, ...snapshot.draft.profiles, ...snapshot.draft.scenes, ...snapshot.draft.components].find(entry => entry.id === id)?.title ?? id;
  const [instruction, setInstruction] = useState('');
  const [providers, setProviders] = useState<DaemonSnapshot['providers']>([]);
  const [providerId, setProviderId] = useState(''); const [model, setModel] = useState(''); const [effort, setEffort] = useState('');
  const [models, setModels] = useState<readonly ProviderModel[]>([]); const [modelsLoading, setModelsLoading] = useState(false);
  const [targetKey, setTargetKey] = useState('');
  const [profileId, setProfileId] = useState(''); const [contextIds, setContextIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<readonly PlanningAiJob[]>([]); const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const targets: Array<{ target: PlanningAiTarget; title: string }> = [
    ...snapshot.draft.items.map(value => ({ target: { kind: 'item' as const, id: value.id, revision: value.revision }, title: value.title })),
    ...snapshot.draft.tasks.map(value => ({ target: { kind: 'task' as const, id: value.id, revision: value.revision }, title: value.title })),
    ...snapshot.draft.profiles.map(value => ({ target: { kind: 'profile' as const, id: value.id, revision: value.revision }, title: value.title })),
  ];
  const target = fixedTarget ?? targets.find(entry => `${entry.target.kind}:${entry.target.id}` === targetKey)?.target;
  const role = planningAiRole(target);
  const availableProfiles = snapshot.draft.profiles.filter(profile => profile.role === role);
  const selectedProfile = availableProfiles.find(profile => profile.id === profileId);
  let profileError: string | undefined;
  let profileChain: typeof snapshot.draft.profiles = [];
  try { if (target && selectedProfile) profileChain = planningAiProfileChain(snapshot, target, selectedProfile.id, selectedProfile.revision); }
  catch (reason) { profileError = reason instanceof Error ? reason.message : String(reason); }
  const references = [...snapshot.draft.items, ...snapshot.draft.tasks, ...snapshot.draft.scenes, ...snapshot.draft.components];
  const selectedJob = jobs.find(job => job.request.requestId === jobId) ?? [...jobs].reverse().find(job => !target || job.request.target.id === target.id);
  const ready = selectedJob?.state === 'ready';
  const currentModel = models.find(entry => entry.id === model);
  const generating = jobs.some(job => ['prepared', 'generating'].includes(job.state));
  const refresh = useCallback(async () => {
    try {
      const result = await access.planningAiRequest({ type: 'read', projectId: snapshot.projectId });
      if (!mounted.current) return;
      if (!result.ok) setError(result.message); else setJobs(result.jobs);
    } catch { if (mounted.current) setError(ko ? 'AI 제안을 불러오지 못했습니다.' : 'AI proposals could not be loaded.'); }
  }, [access, snapshot.projectId, ko]);
  useEffect(() => { mounted.current = true; void refresh(); void access.getDaemonSnapshot().then(value => { if (mounted.current) setProviders(value?.providers ?? []); }).catch(() => { if (mounted.current) setError(ko ? 'AI 연결을 확인하지 못했습니다.' : 'Provider availability could not be checked.'); }); return () => { mounted.current = false; }; }, [access, refresh, ko]);
  useEffect(() => { if (!generating || disabled) return; const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [generating, disabled, refresh]);
  useEffect(() => {
    let active = true; setModels([]); setModel(''); setEffort('');
    if (!providerId) { setModelsLoading(false); return; }
    setModelsLoading(true);
    void access.listDaemonProviderModels(providerId).then(result => {
      if (!active) return;
      if (result.ok) setModels(result.value); else setError(result.message);
    }).catch(() => { if (active) setError(ko ? '모델 목록을 불러오지 못했습니다.' : 'Model discovery failed.'); }).finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [access, providerId, ko]);

  const accept = async (result: PlanningAiResult): Promise<void> => {
    if (!result.ok) throw new Error(result.message);
    if (result.mutation && !result.mutation.ok) throw new Error(result.mutation.message);
    setJobs(old => [...old.filter(job => !result.jobs.some(next => next.request.requestId === job.request.requestId)), ...result.jobs]);
    if (result.jobs[0]) setJobId(result.jobs[0].request.requestId);
    if (result.mutation?.ok) onApplied(result.mutation.snapshot);
    await persistPendingRequest(null);
  };
  const execute = async (request: PlanningAiRequest, replay = false): Promise<void> => {
    setBusy(true); setError(null);
    try {
      if (!replay) await persistPendingRequest(request);
      await accept(await access.planningAiRequest(request));
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : text('전송 결과를 확인하지 못했습니다. 같은 요청을 대조하세요.', 'Delivery is unconfirmed. Check the same request.')); }
    finally { if (mounted.current) setBusy(false); }
  };
  const generate = (): void => {
    if (!target) return;
    void execute({ type: 'start', request: { requestId: sceneIdentity('proposal'), projectId: snapshot.projectId, expectedRevision: snapshot.revision,
      target, instruction, providerId, model, ...(effort ? { reasoningEffort: effort } : {}), contextIds,
      ...(selectedProfile ? { profileId: selectedProfile.id, profileVersion: selectedProfile.revision } : {}) } });
  };
  const stale = selectedJob && selectedJob.request.expectedRevision !== snapshot.revision;
  const changes = selectedJob?.proposal ? planningProposalChanges(selectedJob.before.op !== 'entity.delete' ? selectedJob.before.value : null,
    selectedJob.proposal.operation.op !== 'entity.delete' ? selectedJob.proposal.operation.value : null) : [];
  return <section className="planning-ai" aria-label={text('AI 기획 제안', 'AI planning proposals')}>
    <header><div><h3>{text('AI와 다듬기', 'Refine with AI')}</h3><p>{fixedTarget?.elementIds ? text(`선택한 요소 ${fixedTarget.elementIds.length}개만 수정 제안`, `Propose changes to ${fixedTarget.elementIds.length} selected element(s)`) : text('저장된 항목을 바탕으로 제안을 만들고 변경 내용을 확인합니다.', 'Generate a proposal from the saved item and review its changes.')}</p></div><Button size="sm" variant="ghost" leadingIcon={<Glyph name="refresh" />} disabled={busy || disabled} onClick={() => void refresh()}>{text('새로고침', 'Refresh')}</Button></header>
    {disabledReason && <p role="status">{disabledReason}</p>}
    {error && <p role="alert" className="planning-ai__error">{error}</p>}
    {pendingRequest && <div className="planning-ai__pending"><p>{text('저장된 요청의 결과를 먼저 확인하세요. 새 요청은 중복 전송하지 않습니다.', 'Check the saved request before starting another proposal.')}</p><Button disabled={busy || disabled} onClick={() => void execute(pendingRequest, true)}>{text('같은 요청 결과 확인', 'Check same request')}</Button><Button variant="ghost" disabled={busy} onClick={() => void persistPendingRequest(null).catch(reason => setError(String(reason)))}>{text('기록을 남기고 요청 닫기', 'Keep history and close request')}</Button></div>}
    {!fixedTarget && <Field label={text('수정할 항목', 'Item to refine')}><Select value={targetKey} disabled={busy || !!pendingRequest} onChange={event => { setTargetKey(event.target.value); setJobId(''); }}><option value="">{text('선택하세요', 'Select an item')}</option>{targets.map(entry => <option key={`${entry.target.kind}:${entry.target.id}`} value={`${entry.target.kind}:${entry.target.id}`}>{entry.title} · {entry.target.kind}</option>)}</Select></Field>}
    <Field label={text('단계 역할 프로필', 'Stage role profile')}><Select value={selectedProfile?.id ?? ''} disabled={busy || !!pendingRequest || !target} onChange={event => setProfileId(event.target.value)}><option value="">{availableProfiles.length ? text('사용할 역할을 선택하세요', 'Choose a role profile') : text('저장된 역할 없음 · 기본 지침', 'No saved role · default instructions')}</option>{availableProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.title} · v{profile.revision}</option>)}</Select></Field>
    {profileError && <p role="alert">{profileError}</p>}
    {!!profileChain.length && <details className="planning-ai__context"><summary>{text('적용할 역할 지침과 상속 참조', 'Role instructions and inherited references')}</summary>{profileChain.map(profile => <article key={profile.id}><strong>{profile.title} · v{profile.revision}</strong><pre>{profile.instructions || text('추가 지침 없음', 'No additional instructions')}</pre>{profile.contextRefs.map((reference, index) => <p key={`${reference.id}-${index}`}>{reference.sourcePath ?? targetTitle(reference.id)} · v{reference.revision}{reference.baselineId ? ` · ${reference.baselineId}` : ''}</p>)}</article>)}<p>{text('이 설정과 참조 내용은 요청 시 고정됩니다. 실제 생성은 도구 없이 진행하며 모델은 아래에서 직접 선택합니다.', 'These instructions and references are frozen when requested. Generation uses no tools; choose the model explicitly below.')}</p></details>}
    <details className="planning-ai__context"><summary>{text(`추가 참조 자료 ${contextIds.length}개`, `${contextIds.length} additional references`)}</summary><p>{text('선택한 요구사항·기능·사용흐름·화면의 저장된 버전을 함께 보냅니다.', 'Include saved requirements, features, flows, tasks, or screens in this request.')}</p>{references.filter(reference => reference.id !== target?.id).map(reference => <label className="planning-ai__reference" key={reference.id}><input type="checkbox" checked={contextIds.includes(reference.id)} disabled={busy || !!pendingRequest || (!contextIds.includes(reference.id) && contextIds.length >= 100)} onChange={event => setContextIds(previous => event.target.checked ? [...previous, reference.id] : previous.filter(id => id !== reference.id))} /><span>{reference.title} · v{reference.revision}</span></label>)}</details>
    <div className="planning-ai__settings"><Field label={text('AI 연결', 'Provider')}><Select value={providerId} disabled={busy || !!pendingRequest} onChange={event => setProviderId(event.target.value)}><option value="">{text('직접 선택', 'Choose explicitly')}</option>{providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.enabled || provider.health !== 'ready' || !planningAiProviderSupported(provider.protocol)}>{provider.displayName}{!planningAiProviderSupported(provider.protocol) ? text(' · 도구 없는 제안 미지원', ' · tool-free proposals unsupported') : ''}</option>)}</Select></Field>
      <Field label={text('모델', 'Model')}><Select value={model} disabled={busy || !!pendingRequest || modelsLoading || !providerId} onChange={event => { setModel(event.target.value); setEffort(''); }}><option value="">{modelsLoading ? text('불러오는 중', 'Loading') : text('직접 선택', 'Choose explicitly')}</option>{models.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</Select></Field>
      {!!currentModel?.reasoningEfforts?.length && <Field label={text('추론 수준', 'Reasoning')}><Select value={effort} disabled={busy || !!pendingRequest} onChange={event => setEffort(event.target.value)}><option value="">{text('모델 기본값', 'Model default')}</option>{currentModel.reasoningEfforts.map(value => <option key={value} value={value}>{value}</option>)}</Select></Field>}</div>
    <Field label={text('어떻게 바꿀까요?', 'What should change?')}><textarea aria-label={text('어떻게 바꿀까요?', 'What should change?')} className="planning-ai__instruction" value={instruction} maxLength={20000} onChange={event => setInstruction(event.target.value)} /></Field>
    <Button leadingIcon={<Glyph name="spark" />} disabled={disabled || busy || !!pendingRequest || !target || !instruction.trim() || !model || modelsLoading || !!profileError || (!!availableProfiles.length && !selectedProfile)} onClick={generate}>{text('변경 제안 만들기', 'Generate proposal')}</Button>
    {!!jobs.length && <Field label={text('제안 기록', 'Proposal history')}><Select value={selectedJob?.request.requestId ?? ''} onChange={event => setJobId(event.target.value)}>{[...jobs].reverse().map(job => <option key={job.request.requestId} value={job.request.requestId}>{targetTitle(job.request.target.id)} · {stateLabel(job.state)} · {new Date(job.createdAt).toLocaleString()}</option>)}</Select></Field>}
    {selectedJob && <div className="planning-ai__proposal"><div className="planning-ai__status"><Badge>{stateLabel(selectedJob.state)}</Badge><span>{selectedJob.request.providerId} · {selectedJob.request.model}{selectedJob.request.reasoningEffort ? ` · ${selectedJob.request.reasoningEffort}` : ''}</span>{onOpenConversation && <Button size="sm" variant="ghost" onClick={() => onOpenConversation(selectedJob.sessionId)}>{text('생성 대화 보기', 'View generation conversation')}</Button>}</div>
      {selectedJob.message && <p role="status">{selectedJob.message}</p>}
      {!!selectedJob.profileSnapshots?.length && <p>{text('요청에 고정된 역할', 'Frozen role')}: {selectedJob.profileSnapshots.map(profile => `${profile.title} v${profile.revision}`).join(' → ')}</p>}
      {!!selectedJob.contextSnapshots?.length && <details className="planning-ai__context"><summary>{text(`요청에 고정된 참조 ${selectedJob.contextSnapshots.length}개`, `${selectedJob.contextSnapshots.length} frozen references`)}</summary>{selectedJob.contextSnapshots.map((context, index) => <p key={index}>{typeof context.content === 'string' ? context.reference.sourcePath : context.content.title} · v{context.reference.revision}</p>)}</details>}
      {selectedJob.proposal && <><h4>{selectedJob.proposal.summary}</h4><p>{text('아래 변경은 적용 버튼을 눌러야 저장됩니다.', 'The changes below are saved only when you apply them.')}</p><div className="planning-ai__changes">{changes.map(change => <article key={change.path}><strong>{changeLabel(change.path)}</strong><div><section><h5>{text('현재', 'Current')}</h5><pre>{change.before}</pre></section><section><h5>{text('제안', 'Proposed')}</h5><pre>{change.after}</pre></section></div></article>)}</div></>}
      {ready && stale && <p role="status">{text('기획 버전이 바뀌어 이 제안은 적용할 수 없습니다. 최신 항목으로 다시 요청하세요.', 'Planning has changed. Generate a new proposal from the current item.')}</p>}
      {ready && <Button disabled={disabled || busy || !!pendingRequest || !!stale} onClick={() => void execute({ type: 'apply', projectId: snapshot.projectId, requestId: selectedJob.request.requestId })}>{text('검토한 변경 적용', 'Apply reviewed changes')}</Button>}
    </div>}
  </section>;
}
