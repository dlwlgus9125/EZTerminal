import type { PlanningSnapshot, SceneElement, ScreenScene } from '../../shared/planning';

const layout: SceneElement['layout'] = { direction: 'column', width: 'fill', height: 'hug', gap: 12, padding: 0, overflow: 'visible' };
export const sampleScene: ScreenScene = {
  id: 'scene-chat', revision: 2, title: '대화 시작', platform: 'android', width: 390, height: 720, featureIds: ['feature-chat'], status: 'ready',
  elements: [
    { id: 'frame', kind: 'frame', parentId: null, order: 0, layout: { ...layout, padding: 24, gap: 20 }, properties: { accessibleName: '대화 영역' }, stateIds: [] },
    { id: 'title', kind: 'text', parentId: 'frame', order: 0, layout, properties: { text: '어떤 작업을 함께 할까요?', accessibleName: '제목' }, stateIds: [] },
    { id: 'input', kind: 'input', parentId: 'frame', order: 1, layout, properties: { accessibleName: '작업 내용', placeholder: '작업 내용을 입력하세요', required: true }, stateIds: ['default'] },
    { id: 'send', kind: 'button', parentId: 'frame', order: 2, layout, properties: { text: '대화 시작', accessibleName: '대화 시작', variant: 'primary' }, stateIds: ['default'], component: { componentId: 'component-button', version: 2, overrides: { text: '대화 시작', accessibleName: '대화 시작' } } },
    { id: 'success', kind: 'text', parentId: 'frame', order: 3, layout, properties: { text: '요청을 확인했습니다. 대화를 이어가세요.', accessibleName: '완료 안내' }, stateIds: ['success'] },
  ],
  states: [{ id: 'default', title: '입력', kind: 'default' }, { id: 'success', title: '전송 완료', kind: 'success' }, { id: 'offline', title: '오프라인', kind: 'offline' }],
  transitions: [{ id: 'send-success', elementId: 'send', fromStateId: 'default', trigger: 'activate', toStateId: 'success' }],
};
export const sceneSnapshot: PlanningSnapshot = {
  schemaVersion: 1, projectId: 'scene-project', revision: 2,
  draft: { id: 'draft-scene', items: [{ id: 'feature-chat', revision: 1, kind: 'feature', title: '대화를 시작한다', body: '작업을 입력하고 명시적으로 전송한다.', status: 'ready', acceptance: ['입력과 전송 결과를 유지한다.'] }], links: [], scenes: [sampleScene],
    components: [{ id: 'component-button', revision: 2, title: '기본 동작 버튼', allowedOverrides: ['text', 'accessibleName', 'disabled'], elements: [{ id: 'component-root', kind: 'button', parentId: null, order: 0, layout, properties: { text: '시작', variant: 'primary', accessibleName: '시작' }, stateIds: [] }] }],
    profiles: [], tasks: [], assets: [], },
  baselines: [], history: [], profileProposals: [],
};
