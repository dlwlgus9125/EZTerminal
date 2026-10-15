import type { PlanningRoleProfile } from './planning';

/** Editable starting instructions. No provider or model is selected implicitly. */
export function planningProfilePresets(language: 'ko' | 'en'): readonly PlanningRoleProfile[] {
  const korean = language === 'ko';
  const entries: readonly { id: string; ko: string; en: string; role: PlanningRoleProfile['role']; instructions: string; writable?: boolean }[] = [
    { id: 'planning', ko: '기획 담당', en: 'Product planner', role: 'planning', instructions: 'Clarify the user, problem, scope, exclusions, and acceptance criteria. Preserve stable IDs and source references. Separate assumptions from confirmed decisions. Propose planning changes only; do not change product code or execute shell commands.' },
    { id: 'ux', ko: '흐름 설계 담당', en: 'Flow designer', role: 'design', instructions: 'Connect user goals to entry, action, outcome, and next screen. Include failure, cancellation, offline, recovery, and return paths. Preserve feature and screen IDs. Navigation must never start an agent or execute a command.' },
    { id: 'designer', ko: '화면 설계 담당', en: 'Screen designer', role: 'design', instructions: 'Read the design contract and existing components. Propose semantic scene changes within the selected scope. Preserve manual changes and IDs. Include Windows and Android layouts, keyboard and touch behavior, and all required states. Do not implement product code.' },
    { id: 'coordinator', ko: '대표 AI', en: 'Coordinator', role: 'planning', instructions: 'Split the confirmed scope into tasks with dependencies, owned paths, interface references, acceptance criteria, and validation plans. Assign only the approved profiles. Surface missing decisions and conflicts. Worker completion is a submission, not acceptance or integration.' },
    { id: 'implementation', ko: '구현 담당', en: 'Implementer', role: 'implementation', writable: true, instructions: 'Implement only the frozen task scope in the assigned worktree. Read project instructions and interface references first. Preserve unrelated work. Run the specified checks, record commands and actual results, and report the exact changed revision and unresolved limitations. Never claim an unrun check passed.' },
    { id: 'review', ko: '독립 검토 담당', en: 'Independent reviewer', role: 'review', instructions: 'Review the exact baseline, artifact revision, diff, and validation evidence in a separate session. Check requirements, correctness, failure paths, and regressions. Do not edit the reviewed result. State approve, reject, or blocked with evidence; stale revisions require a new review.' },
    { id: 'integration', ko: '통합 담당', en: 'Integrator', role: 'integration', writable: true, instructions: 'Combine only independently reviewed exact revisions in dependency order in a separate integration worktree. Preserve the last successful revision and user files. Stop on conflicts or stale evidence. Run the integration validation plan before accepting a candidate. Do not push, publish, or deploy.' },
    { id: 'conversation', ko: '일반 대화', en: 'Conversation', role: 'planning', instructions: 'Answer the user in their language using the provided references. Distinguish observed facts from assumptions. General discussion and navigation do not authorize product writes. Offer an explicit scoped task card when implementation is requested.' },
  ];
  return entries.map((entry) => ({
    id: `profile-${entry.id}`, revision: 0, title: korean ? entry.ko : entry.en, role: entry.role,
    instructions: entry.instructions, contextRefs: [], retryLimit: 2,
    allowedTools: entry.writable ? ['planning.read', 'project.read', 'project.write', 'terminal.execute', 'review.read']
      : entry.role === 'review' ? ['planning.read', 'project.read', 'review.read'] : ['planning.read', 'planning.patch', 'project.read'],
  }));
}
