import type { PlanningAiJob } from '../../shared/planning-ai';
import { sceneSnapshot } from './scene-fixtures';

export function planningAiFixture(): PlanningAiJob {
  const before = { op: 'item.put' as const, value: structuredClone(sceneSnapshot.draft.items[0]) };
  return { request: { requestId: 'proposal-story', projectId: sceneSnapshot.projectId, expectedRevision: sceneSnapshot.revision,
    target: { kind: 'item', id: before.value.id, revision: before.value.revision }, instruction: '오프라인에서도 입력을 잃지 않도록 요구사항을 구체화해줘.',
    providerId: 'claude', model: 'Selected model', reasoningEffort: 'high', contextIds: [] },
    sessionId: 'planning-ai-story', state: 'ready', createdAt: '2026-10-13T06:00:00.000Z', before,
    proposal: { summary: '오프라인 입력과 전송 결과 확인을 수용 기준에 추가합니다.', operation: { op: 'item.put', value: {
      ...before.value, body: '작업을 입력하고 명시적으로 전송한다. 연결이 끊겨도 초안을 보존하고, 전송 결과가 불명확하면 같은 요청을 확인한다.',
      acceptance: [...before.value.acceptance, '오프라인 작성 중인 내용이 앱 재시작 후 복원된다.', '전송 결과 확인 중 새로 작성한 내용이 지워지지 않는다.'],
    } } } };
}
