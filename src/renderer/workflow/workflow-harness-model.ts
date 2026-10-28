import type { ChatAgentProfile } from '../../shared/chat-agent-profiles';
import type { ProviderModel } from '../../shared/daemon-provider';
import { workflowApprovalNeedsPerson, workflowChainPredecessor, workflowChains, type WorkflowAgentSnapshot, type WorkflowGraph, type WorkflowNode } from '../../shared/workflow-graph';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import type { WorkflowAgentListItem } from './WorkflowAgentList';
import type { WorkflowEdgeDecoration, WorkflowNodeDecoration } from './workflow-canvas-types';
import { workflowEffortLabel, workflowOperationLabel, workflowPermissionLabel, type WorkflowCopy } from './workflow-copy';

/**
 * The flow's agents as the canvas shows them (Settings › AI › 에이전트 placed on stages): pure, so the workspace
 * and its tests derive the same cards, chains, notes and patches.
 */

type Tone = 'codex' | 'claude' | 'other';
export const agentTone = (providerId: string | undefined): Tone => providerId === 'codex' ? 'codex' : providerId === 'claude' ? 'claude' : 'other';
const providerLabel = (providers: readonly StructuredAgentProviderOption[], id: string | undefined) => providers.find(item => item.id === id)?.label ?? id ?? '';
const modelLabel = (providers: readonly StructuredAgentProviderOption[], providerId: string | undefined, model: string | undefined) =>
  providers.find(item => item.id === providerId)?.models.find(item => item.id === model)?.label ?? model ?? '';

export function agentSnapshot(profile: ChatAgentProfile, capturedAt: string): WorkflowAgentSnapshot {
  return { profileId: profile.id, name: profile.name, providerId: profile.providerId, ...(profile.model ? { model: profile.model } : {}), capturedAt };
}

/**
 * Placing an agent on a stage (decision 4): the stage takes the agent's AI, model, effort and permission and owns
 * them from then on. A workflow never runs with 전체 권한, so that permission comes in as 승인 후 실행 (`lowered`).
 */
export function workflowAssignAgent(profile: ChatAgentProfile, capturedAt: string): { readonly patch: Partial<WorkflowNode>; readonly lowered: boolean } {
  const lowered = profile.permissionPreset === 'full-access';
  return {
    patch: { agent: agentSnapshot(profile, capturedAt), providerId: profile.providerId, model: profile.model, reasoningEffort: profile.reasoningEffort || undefined, permissionPreset: lowered ? 'standard' : profile.permissionPreset },
    lowered,
  };
}

/** Each stage on a chain (one conversation): its place, and the person stages and connections the line runs through. */
export interface WorkflowChainPlaces {
  readonly stages: Readonly<Record<string, { readonly index: number; readonly length: number; readonly chain: readonly string[] }>>;
  /** Person stages (answer, approval) between two stages of a chain: the conversation waits there. */
  readonly between: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}
export function workflowChainPlaces(graph: WorkflowGraph): WorkflowChainPlaces {
  const stages: Record<string, { index: number; length: number; chain: readonly string[] }> = {};
  const between = new Set<string>(); const edges = new Set<string>();
  for (const chain of workflowChains(graph)) {
    chain.forEach((id, index) => { stages[id] = { index, length: chain.length, chain }; });
    // Walk back from each continuing stage to the one it continues, through the person stages on the line.
    for (const id of chain.slice(1)) {
      const previous = chain[chain.indexOf(id) - 1];
      let current = id;
      for (let steps = 0; steps < graph.nodes.length && current !== previous; steps += 1) {
        const incoming = graph.edges.filter(edge => edge.to === current && !edge.retryLimit);
        incoming.forEach(edge => edges.add(edge.id));
        const from = incoming[0]?.from;
        if (!from) break;
        if (from !== previous) between.add(from);
        current = from;
      }
    }
  }
  return { stages, between, edges };
}

/** The graph with this stage's own `session` choice cleared: whether it could continue at all. */
function couldContinue(graph: WorkflowGraph, nodeId: string): string | undefined {
  return workflowChainPredecessor({ ...graph, nodes: graph.nodes.map(node => node.id === nodeId ? { ...node, session: undefined } : node) }, nodeId);
}

/** Why a stage starts a new conversation even if asked to continue (mirrors workflowChainPredecessor's walk). */
function freshReason(graph: WorkflowGraph, node: WorkflowNode, text: WorkflowCopy): string {
  if (!node.agent) return text('에이전트를 배정하면 정할 수 있습니다.', 'Choose once an agent is placed.');
  const nodes = new Map(graph.nodes.map(item => [item.id, item]));
  let current = node.id;
  for (let steps = 0; steps < graph.nodes.length; steps += 1) {
    const sources = [...new Set(graph.edges.filter(edge => edge.to === current && !edge.retryLimit).map(edge => edge.from))];
    if (sources.length === 0) return text('앞에 이어받을 단계가 없어 새 대화로 시작합니다.', 'Nothing comes before it, so it starts a new conversation.');
    if (sources.length > 1) return text('여러 단계에서 들어오는 단계라 새 대화로 시작합니다.', 'Several stages lead into it, so it starts a new conversation.');
    const previous = nodes.get(sources[0]!);
    if (!previous) break;
    if (new Set(graph.edges.filter(edge => edge.from === previous.id && !edge.retryLimit).map(edge => edge.to)).size > 1) return text(`'${previous.title}'에서 여러 갈래로 나뉘어 새 대화로 시작합니다.`, `'${previous.title}' branches out, so it starts a new conversation.`);
    if (previous.operation === 'answer' || previous.operation === 'approval') { current = previous.id; continue; }
    if (previous.operation !== 'agent') return text(`앞 단계가 ${workflowOperationLabel(previous.operation, text)}라 새 대화로 시작합니다.`, `The stage before is a ${workflowOperationLabel(previous.operation, text).toLowerCase()}, so it starts a new conversation.`);
    if (!previous.agent) return text(`앞 AI 단계 '${previous.title}'에 에이전트가 없어 새 대화로 시작합니다.`, `'${previous.title}' has no agent, so it starts a new conversation.`);
    return text(`앞 AI 단계 '${previous.title}'와 에이전트나 모델이 달라 새 대화로 시작합니다.`, `'${previous.title}' has another agent or model, so it starts a new conversation.`);
  }
  return text('이 단계는 새 대화로 시작합니다.', 'This stage starts a new conversation.');
}

/**
 * '이 단계를 실행할 때' and the panel's conversation line, in what was measured (probe P4): continuing keeps the
 * conversation, nothing lost to a summary; Claude keeps its cache when only the effort changes; Codex reads the
 * conversation again when the effort changes between chained stages, so the same effort saves the most.
 */
export function workflowStageSession(graph: WorkflowGraph, node: WorkflowNode, text: WorkflowCopy): {
  readonly value: 'continue' | 'fresh'; readonly from?: string; readonly reason?: string; readonly note?: string; readonly conversationHint?: string;
} {
  const possible = couldContinue(graph, node.id);
  const places = workflowChainPlaces(graph).stages[node.id];
  const nextTitles = places && places.index < places.length - 1 ? places.chain.slice(places.index + 1).map(id => graph.nodes.find(item => item.id === id)?.title ?? id) : [];
  const leads = nextTitles.length ? text(`실행하면 새 대화로 시작하고, ${nextTitles.map(title => `'${title}'`).join(', ')}까지 같은 대화로 이어서 합니다.`, `Runs as a new conversation that ${nextTitles.map(title => `'${title}'`).join(', ')} continue${nextTitles.length > 1 ? '' : 's'}.`) : undefined;
  if (!possible) return { value: 'fresh', reason: freshReason(graph, node, text), ...(leads ? { conversationHint: leads } : {}) };
  const previous = graph.nodes.find(item => item.id === possible)!;
  if (node.session === 'fresh') return { value: 'fresh', from: previous.title, note: text('새 대화에서 시작합니다. 앞 단계 결과는 요약으로 넘겨받아 빠지는 내용이 생길 수 있습니다.', 'Starts a new conversation; the previous result arrives as a summary, which can lose detail.') };
  const sameEffort = (previous.reasoningEffort ?? '') === (node.reasoningEffort ?? '');
  const note = node.providerId === 'codex'
    ? sameEffort ? text('재시도해도 같은 대화로 돌아옵니다. 노력이 앞 단계와 같아 토큰을 가장 아낍니다.', 'A retry returns to the same conversation. The same effort as before saves the most tokens.')
      : text('노력이 앞 단계와 달라 Codex가 대화를 다시 읽습니다(토큰이 더 듭니다). 노력을 같게 두면 가장 아낍니다.', 'The effort differs from the stage before, so Codex reads the conversation again (more tokens). The same effort saves the most.')
    : node.providerId === 'claude' ? text('재시도해도 같은 대화로 돌아옵니다. Claude는 노력만 바꾸면 캐시를 그대로 씁니다.', 'A retry returns to the same conversation. Claude keeps its cache when only the effort changes.')
      : undefined;
  return { value: 'continue', from: previous.title, ...(note ? { note } : {}),
    conversationHint: text(`실행하면 '${previous.title}' 대화에서 이어서 합니다. 요약하지 않아 앞 내용이 그대로 남습니다.`, `Runs in the '${previous.title}' conversation. Nothing is summarised, so the earlier work stays as it was.`) };
}

/** Effort levels the stage's model offers ('' = the model's default), keeping the stage's own value listed. */
export function workflowEffortOptions(node: WorkflowNode, catalogs: Readonly<Record<string, readonly ProviderModel[]>>, text: WorkflowCopy): readonly { value: string; label: string }[] {
  const efforts = catalogs[node.providerId ?? '']?.find(model => model.id === node.model)?.reasoningEfforts ?? [];
  const listed = node.reasoningEffort && !efforts.includes(node.reasoningEffort) ? [node.reasoningEffort, ...efforts] : efforts;
  return [{ value: '', label: text('모델 기본값', 'Model default') }, ...listed.map(effort => ({ value: effort, label: workflowEffortLabel(effort, text) }))];
}

/** 검토: the run's reviewer, off (checks only), or one of the saved agents as this stage's own reviewer. */
export function workflowReviewChoice(node: WorkflowNode, profiles: readonly ChatAgentProfile[], reviewer: string | undefined, text: WorkflowCopy): { readonly value: string; readonly options: readonly { value: string; label: string }[]; readonly note?: string } {
  const value = node.review?.mode === 'off' ? 'off' : node.review?.mode === 'agent' ? `agent:${node.review.agent.profileId}` : 'run-default';
  const own = node.review?.mode === 'agent' ? node.review.agent : undefined;
  const options = [
    { value: 'run-default', label: reviewer ? text(`실행 기본 (${reviewer})`, `Run default (${reviewer})`) : text('실행 기본', 'Run default') },
    { value: 'off', label: text('끔 · 확인 명령으로만', 'Off · checks only') },
    ...profiles.map(profile => ({ value: `agent:${profile.id}`, label: text(`다른 에이전트: ${profile.name}`, `Another agent: ${profile.name}`) })),
    ...(own && !profiles.some(profile => profile.id === own.profileId) ? [{ value, label: text(`${own.name} · 이 PC에 없음`, `${own.name} · not on this PC`) }] : []),
  ];
  const note = node.review?.mode === 'off'
    ? node.checks?.length ? text('검토를 끄면 확인 명령이 모두 통과해야 다음으로 갑니다.', 'With review off, every check must pass to go on.')
      : text('확인 명령이 없으면 바로 뒤에 사람 승인 단계가 있어야 합니다. 그 승인은 자동 승인으로 넘어가지 않고 "사람이 수락함"으로 남습니다.', 'Without a check, an approval must come right after it; auto-approve never answers it, and it is recorded as accepted by a person.')
    : own ? text(`'${own.name}'이(가) 새 대화로 이 단계 결과를 검토합니다.`, `'${own.name}' reviews this stage in a new conversation.`) : undefined;
  return { value, options, ...(note ? { note } : {}) };
}
/** The review a choice of the select means (`agent:<id>` takes that agent as it is now). */
export function workflowReviewPatch(value: string, profiles: readonly ChatAgentProfile[], node: WorkflowNode, capturedAt: string): Partial<WorkflowNode> {
  if (value === 'off') return { review: { mode: 'off' } };
  if (value.startsWith('agent:')) {
    const profile = profiles.find(entry => entry.id === value.slice('agent:'.length));
    return profile ? { review: { mode: 'agent', agent: agentSnapshot(profile, capturedAt) } } : { review: node.review };
  }
  return { review: undefined };
}

/** A new check's id: stable once given (allowances are kept per id), never one the stage already has. */
export function workflowNextCheckId(node: WorkflowNode): string {
  const taken = new Set((node.checks ?? []).map(check => check.id));
  let number = (node.checks?.length ?? 0) + 1;
  while (taken.has(`check-${number}`)) number += 1;
  return `check-${number}`;
}

/** An AI stage after a stage with checks: 결과가 같으면 건너뜀 can apply (the host compares those checks' results). */
export function workflowCanSkipUnchanged(graph: WorkflowGraph, nodeId: string): boolean {
  const seen = new Set<string>(); const pending = [nodeId];
  while (pending.length) {
    const current = pending.pop()!;
    for (const edge of graph.edges) if (edge.to === current && !edge.retryLimit && !seen.has(edge.from)) { seen.add(edge.from); pending.push(edge.from); }
  }
  return graph.nodes.some(node => seen.has(node.id) && node.id !== nodeId && !!node.checks?.length);
}

export function workflowAgentListItems(profiles: readonly ChatAgentProfile[], graph: WorkflowGraph | undefined, providers: readonly StructuredAgentProviderOption[], text: WorkflowCopy): readonly WorkflowAgentListItem[] {
  return profiles.map(profile => ({
    id: profile.id, name: profile.name, providerLabel: providerLabel(providers, profile.providerId), model: modelLabel(providers, profile.providerId, profile.model),
    ...(profile.reasoningEffort ? { effortLabel: workflowEffortLabel(profile.reasoningEffort, text) } : {}),
    permissionLabel: workflowPermissionLabel(profile.permissionPreset, text), ...(profile.whenToUse ? { whenToUse: profile.whenToUse } : {}),
    tone: agentTone(profile.providerId), usedOn: graph?.nodes.filter(node => node.agent?.profileId === profile.id).length ?? 0,
  }));
}

/** What each card and connection shows: the agent and its effort, the chain, checks, review and person stages. */
export function workflowHarnessDecorations(graph: WorkflowGraph, options: { readonly profileIds?: ReadonlySet<string>; readonly providers: readonly StructuredAgentProviderOption[]; readonly text: WorkflowCopy }): {
  readonly nodes: Readonly<Record<string, WorkflowNodeDecoration>>; readonly edges: Readonly<Record<string, WorkflowEdgeDecoration>>;
} {
  const { text, providers } = options;
  const places = workflowChainPlaces(graph);
  const nodes: Record<string, WorkflowNodeDecoration> = {};
  for (const node of graph.nodes) {
    const place = places.stages[node.id];
    const badges = [
      ...(node.checks ?? []).map(check => check.command.length > 24 ? `${check.command.slice(0, 23)}…` : check.command),
      ...(node.review?.mode === 'off' ? [text('검토 끔', 'Review off')] : node.review?.mode === 'agent' ? [text(`검토: ${node.review.agent.name}`, `Review: ${node.review.agent.name}`)] : []),
      ...(node.skipWhenUnchanged ? [text('결과가 같으면 건너뜀', 'Skips when unchanged')] : []),
      ...(node.operation === 'approval' && workflowApprovalNeedsPerson(graph, node.id) ? [text('사람이 수락', 'A person accepts')] : []),
    ];
    const decoration: WorkflowNodeDecoration = {
      ...(node.operation === 'agent' && node.agent ? { agent: {
        name: node.agent.name, tone: agentTone(node.providerId ?? node.agent.providerId),
        detail: [providerLabel(providers, node.providerId), modelLabel(providers, node.providerId, node.model)].filter(Boolean).join(' · '),
        ...(node.reasoningEffort ? { effort: workflowEffortLabel(node.reasoningEffort, text) } : {}),
        ...(options.profileIds && !options.profileIds.has(node.agent.profileId) ? { missing: true } : {}),
      } } : {}),
      ...(place ? { chain: { label: text(`이어서 ${place.index + 1}/${place.length}`, `Continues ${place.index + 1}/${place.length}`), position: place.index === 0 ? 'first' as const : place.index === place.length - 1 ? 'last' as const : 'middle' as const } }
        : places.between.has(node.id) ? { chain: { label: text('대화 유지 · AI 비용 없음', 'Conversation kept · no AI cost'), position: 'middle' as const } } : {}),
      ...(badges.length ? { badges } : {}),
    };
    if (Object.keys(decoration).length) nodes[node.id] = decoration;
  }
  const edges: Record<string, WorkflowEdgeDecoration> = {};
  // Several outcomes into the same next stage are one line: one label on it.
  const labelled = new Set<string>();
  for (const edge of graph.edges) {
    if (!places.edges.has(edge.id)) continue;
    const pair = `${edge.from}>${edge.to}`;
    edges[edge.id] = labelled.has(pair) ? { chain: true } : { chain: true, label: text('이어서', 'Continues') };
    labelled.add(pair);
  }
  return { nodes, edges };
}
