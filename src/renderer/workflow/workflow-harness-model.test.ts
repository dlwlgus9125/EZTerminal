import { describe, expect, it } from 'vitest';
import { CHECK_GRAPH, HARNESS_GRAPH, HARNESS_PROFILES, HARNESS_PROVIDERS, harnessAgent, harnessGraph } from '../harness/harness-fixtures';
import {
  workflowAssignAgent, workflowCanSkipUnchanged, workflowChainPlaces, workflowHarnessDecorations, workflowNextCheckId, workflowReviewChoice, workflowReviewPatch, workflowStageSession,
} from './workflow-harness-model';

const text = (ko: string) => ko;
const profile = (id: string) => HARNESS_PROFILES.find(entry => entry.id === id)!;
const node = (graph: typeof HARNESS_GRAPH, id: string) => graph.nodes.find(entry => entry.id === id)!;

describe('placing an agent (decision 4)', () => {
  it('copies the agent’s AI, model, effort and permission onto the stage', () => {
    const { patch, lowered } = workflowAssignAgent(profile('agent-design'), '2026-10-29T00:00:00.000Z');
    expect(lowered).toBe(false);
    expect(patch).toEqual({ agent: { profileId: 'agent-design', name: '설계 담당', providerId: 'claude', model: 'claude-opus-5-5', capturedAt: '2026-10-29T00:00:00.000Z' },
      providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard' });
  });
  it('lowers 전체 권한 to 승인 후 실행 (workflows never run with full access)', () => {
    const { patch, lowered } = workflowAssignAgent(profile('agent-full'), '2026-10-29T00:00:00.000Z');
    expect(lowered).toBe(true);
    expect(patch.permissionPreset).toBe('standard');
  });
});

describe('chains (one conversation)', () => {
  it('numbers the stages of a chain and runs the line through the person stage between them', () => {
    const places = workflowChainPlaces(HARNESS_GRAPH);
    expect(Object.fromEntries(Object.entries(places.stages).map(([id, place]) => [id, `${place.index + 1}/${place.length}`]))).toEqual({ 'dev:req': '1/3', 'dev:plan': '2/3', 'dev:mock': '3/3' });
    expect([...places.between]).toEqual(['dev:answer']);
    expect([...places.edges].sort()).toEqual(['dev:answer-plan', 'dev:plan-mock', 'dev:req-answer']);
  });
  it('labels a chain connection once when two outcomes lead into the same next stage', () => {
    const { edges, nodes } = workflowHarnessDecorations(CHECK_GRAPH, { providers: HARNESS_PROVIDERS, text });
    expect(edges).toEqual({ 'chk:run-sum': { chain: true, label: '이어서' }, 'chk:run-sum-failed': { chain: true } });
    expect(nodes['chk:sum']?.badges).toEqual(['검토 끔', '결과가 같으면 건너뜀']);
    expect(nodes['chk:look']?.badges).toEqual(['사람이 수락']);
  });
  it('names the agent, its effort and a missing one on the card', () => {
    const { nodes } = workflowHarnessDecorations(HARNESS_GRAPH, { providers: HARNESS_PROVIDERS, text, profileIds: new Set(['agent-design', 'agent-review']) });
    expect(nodes['dev:mock']).toMatchObject({ agent: { name: '설계 담당', detail: 'Claude · Opus 5.5', effort: '보통', tone: 'claude' }, chain: { label: '이어서 3/3', position: 'last' } });
    expect(nodes['dev:implement']?.agent).toMatchObject({ name: '구현 담당', missing: true });
    expect(nodes['dev:implement']?.badges).toEqual(['pnpm test', 'pnpm typecheck', '검토 끔']);
    expect(nodes['dev:answer']?.chain).toEqual({ label: '대화 유지 · AI 비용 없음', position: 'middle' });
  });
});

describe('이 단계를 실행할 때 — in what was measured (probe P4)', () => {
  it('Claude: continuing keeps the conversation; only an effort change keeps the cache', () => {
    const session = workflowStageSession(HARNESS_GRAPH, node(HARNESS_GRAPH, 'dev:mock'), text);
    expect(session).toMatchObject({ value: 'continue', from: '계획' });
    expect(session.note).toBe('재시도해도 같은 대화로 돌아옵니다. Claude는 노력만 바꾸면 캐시를 그대로 씁니다.');
    expect(session.conversationHint).toBe("실행하면 '계획' 대화에서 이어서 합니다. 요약하지 않아 앞 내용이 그대로 남습니다.");
  });
  it('Codex: an effort change between chained stages reads the conversation again; the same effort saves the most', () => {
    const codex = { agent: harnessAgent('agent-build'), providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium' };
    const graph = harnessGraph({ 'dev:req': codex, 'dev:plan': { ...codex, reasoningEffort: 'xhigh' }, 'dev:mock': codex });
    expect(workflowStageSession(graph, node(graph, 'dev:plan'), text).note).toBe('노력이 앞 단계와 달라 Codex가 대화를 다시 읽습니다(토큰이 더 듭니다). 노력을 같게 두면 가장 아낍니다.');
    const same = harnessGraph({ 'dev:req': codex, 'dev:plan': codex });
    expect(workflowStageSession(same, node(same, 'dev:plan'), text).note).toBe('재시도해도 같은 대화로 돌아옵니다. 노력이 앞 단계와 같아 토큰을 가장 아낍니다.');
  });
  it('the first stage of a chain says which stages continue it', () => {
    const session = workflowStageSession(HARNESS_GRAPH, node(HARNESS_GRAPH, 'dev:req'), text);
    expect(session.value).toBe('fresh');
    expect(session.conversationHint).toBe("실행하면 새 대화로 시작하고, '계획', '시안'까지 같은 대화로 이어서 합니다.");
  });
  it('a stage that cannot continue says why; 새 대화로 says a summary can lose detail', () => {
    expect(workflowStageSession(HARNESS_GRAPH, node(HARNESS_GRAPH, 'dev:implement'), text).reason).toBe("앞 AI 단계 '교차 검토'와 에이전트나 모델이 달라 새 대화로 시작합니다.");
    const empty = harnessGraph({ 'dev:implement': { agent: undefined } });
    expect(workflowStageSession(empty, node(empty, 'dev:implement'), text).reason).toBe('에이전트를 배정하면 정할 수 있습니다.');
    const fresh = harnessGraph({ 'dev:plan': { session: 'fresh' } });
    expect(workflowStageSession(fresh, node(fresh, 'dev:plan'), text)).toMatchObject({ value: 'fresh', from: '요구 정리', note: '새 대화에서 시작합니다. 앞 단계 결과는 요약으로 넘겨받아 빠지는 내용이 생길 수 있습니다.' });
  });
});

describe('review, checks and skipping', () => {
  it('offers the run’s reviewer, off, or another saved agent, and keeps one this PC lacks', () => {
    const own = harnessGraph({ 'dev:mock': { review: { mode: 'agent', agent: { ...harnessAgent('agent-review'), profileId: 'agent-gone', name: '옛 검토' } } } });
    const choice = workflowReviewChoice(node(own, 'dev:mock'), HARNESS_PROFILES, 'Codex · GPT-6-Astra', text);
    expect(choice.value).toBe('agent:agent-gone');
    expect(choice.options.map(option => option.label)).toEqual(expect.arrayContaining(['실행 기본 (Codex · GPT-6-Astra)', '끔 · 확인 명령으로만', '다른 에이전트: 교차 검토', '옛 검토 · 이 PC에 없음']));
    expect(workflowReviewPatch('off', HARNESS_PROFILES, node(own, 'dev:mock'), 'now')).toEqual({ review: { mode: 'off' } });
    expect(workflowReviewPatch('run-default', HARNESS_PROFILES, node(own, 'dev:mock'), 'now')).toEqual({ review: undefined });
    expect(workflowReviewPatch('agent:agent-review', HARNESS_PROFILES, node(own, 'dev:mock'), '2026-10-29T00:00:00.000Z').review).toEqual({ mode: 'agent', agent: { ...harnessAgent('agent-review'), capturedAt: '2026-10-29T00:00:00.000Z' } });
  });
  it('gives a new check an id the stage does not have (allowances are kept per id)', () => {
    expect(workflowNextCheckId(node(HARNESS_GRAPH, 'dev:plan'))).toBe('check-1');
    const taken = harnessGraph({ 'dev:plan': { checks: [{ id: 'check-2', command: 'a' }, { id: 'x', command: 'b' }] } });
    expect(workflowNextCheckId(node(taken, 'dev:plan'))).toBe('check-3');
  });
  it('결과가 같으면 건너뜀 applies after a stage with checks', () => {
    expect(workflowCanSkipUnchanged(CHECK_GRAPH, 'chk:sum')).toBe(true);
    expect(workflowCanSkipUnchanged(CHECK_GRAPH, 'chk:run')).toBe(false);
    expect(workflowCanSkipUnchanged(HARNESS_GRAPH, 'dev:mock')).toBe(false);
  });
});
