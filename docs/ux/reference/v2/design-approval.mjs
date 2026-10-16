// Durable user authorization. Browser review imports cannot replace this record.
export const designApproval = Object.freeze({
  id: 'ezterminal-v2-r6-2026-10-13',
  revision: 6,
  status: 'approved-for-implementation',
  approvedBy: 'user',
  approvedOn: '2026-10-13',
  recordedAt: '2026-10-13T04:47:09Z',
  timestampMeaning: '기록 생성 시각. 사용자 발화의 정확한 전송 시각은 제공되지 않음.',
  source: 'current-conversation-user-instruction',
  statement: '정리할내용 정리하고 나머지단계 모두 진행해줘',
  context: '사용자가 설계 승인 전 점검을 요청한 뒤, r6 기준 정리와 P6/P7 이후 G1–G8 진행을 지시함.',
  scope: 'r6 전체 설계, 확정 정책 I01–I11, Windows/Android, W01–W09 구현·검증·패키지 준비',
  implementationApproved: true,
  individualScreenReviews: 'not-asserted',
  implementationCompletion: 'not-asserted',
  exclusions: ['성능 측정', '원격 main 반영·push·배포 자동 수행'],
  manifest: 'approvals/2026-10-13-r6-final.json',
});
