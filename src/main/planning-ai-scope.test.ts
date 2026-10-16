import { describe, expect, it } from 'vitest';
import { sceneSnapshot } from '../renderer/planning/scene-fixtures';
import { planningAiBefore, planningAiFrozenContext, planningAiPrompt, validatePlanningAiProposal } from './planning-ai-scope';
import { planningAiProfileChain, type PlanningAiTarget } from '../shared/planning-ai';
import type { PlanningRoleProfile } from '../shared/planning';

const target: PlanningAiTarget = { kind: 'scene', id: 'scene-chat', revision: 2, elementIds: ['title'] };
function fixture() {
  const snapshot = structuredClone(sceneSnapshot);
  const before = planningAiBefore(snapshot, target);
  const proposal = { summary: 'Make the heading clearer', operation: structuredClone(before) };
  if (proposal.operation.op !== 'scene.put') throw new Error('Missing scene');
  proposal.operation.value.elements.find(value => value.id === 'title')!.properties.text = 'Updated heading';
  return { snapshot, before, proposal };
}
describe('planning AI scope authority', () => {
  it('accepts selected element text/layout and preserves every unselected element', () => {
    const { snapshot, before, proposal } = fixture();
    expect(validatePlanningAiProposal(snapshot, target, before, proposal)).toEqual(proposal);
    expect(snapshot.draft.scenes[0].elements[1].properties.text).not.toBe('Updated heading');
  });
  it.each(['unselected', 'structure', 'identity', 'revision', 'delete', 'script'])('rejects a %s scope escape', (mode) => {
    const { snapshot, before, proposal } = fixture();
    const unsafe = JSON.parse(JSON.stringify(proposal));
    if (mode === 'unselected') unsafe.operation.value.elements[2].properties.placeholder = 'outside scope';
    if (mode === 'structure') unsafe.operation.value.elements[1].parentId = null;
    if (mode === 'identity') unsafe.operation.value.id = 'another-scene';
    if (mode === 'revision') unsafe.operation.value.revision = 3;
    if (mode === 'delete') unsafe.operation = { op: 'entity.delete', kind: 'scene', id: target.id };
    if (mode === 'script') unsafe.operation.value.elements[1].properties.script = 'run code';
    expect(() => validatePlanningAiProposal(snapshot, target, before, unsafe)).toThrow();
  });
  it('rejects linked component edits, invalid references, and stale selection', () => {
    const { snapshot } = fixture();
    const linked = { ...target, elementIds: ['send'] };
    const before = planningAiBefore(snapshot, linked);
    const changed = structuredClone(before);
    if (changed.op !== 'scene.put') throw new Error('Missing scene');
    changed.value.elements.find(value => value.id === 'send')!.properties.text = 'Override';
    expect(() => validatePlanningAiProposal(snapshot, linked, before, { summary: 'Bad', operation: changed })).toThrow(/linked/u);
    expect(() => planningAiBefore(snapshot, { ...target, revision: 1 })).toThrow(/changed/u);
    expect(() => planningAiBefore(snapshot, { ...target, elementIds: ['missing'] })).toThrow(/invalid/u);
  });
  it('builds a strict entity schema prompt with only selected reference documents', () => {
    const { snapshot, before } = fixture();
    const prompt = planningAiPrompt(snapshot, target, before, 'Clarify heading', ['feature-chat']);
    expect(prompt).toContain('"additionalProperties":false');
    expect(prompt).toContain('Only properties and layout');
    expect(() => planningAiPrompt(snapshot, target, before, 'Edit', ['missing'])).toThrow(/missing/u);
  });
  it('freezes parent-to-leaf instructions and versioned role/selected context without granting tools', async () => {
    const { snapshot, before } = fixture();
    const base: PlanningRoleProfile = { id: 'base', revision: 1, title: 'Base design', role: 'design', instructions: 'Preserve accessible names.', contextRefs: [{ kind: 'item', id: 'feature-chat', revision: 1 }], allowedTools: ['planning.read'], retryLimit: 2 };
    snapshot.draft.profiles = [base, { ...base, id: 'mobile', revision: 2, title: 'Mobile design', parentProfileId: 'base', instructions: 'Use 48px touch targets.', contextRefs: [] }];
    const profiles = planningAiProfileChain(snapshot, target, 'mobile', 2);
    const context = await planningAiFrozenContext(snapshot, profiles, ['component-button']);
    const prompt = planningAiPrompt(snapshot, target, before, 'Refine', ['component-button'], profiles, context);
    expect(prompt.indexOf(base.instructions)).toBeLessThan(prompt.indexOf('Use 48px touch targets.'));
    expect(context.map(value => value.reference.id)).toEqual(['feature-chat', 'component-button']);
    snapshot.draft.items[0].body = 'Changed after dispatch';
    expect(context[0].content).not.toMatchObject({ body: 'Changed after dispatch' });
    expect(prompt).toContain('No tools are available');
    expect(() => planningAiProfileChain(snapshot, target, 'mobile', 1)).toThrow(/changed/u);
    expect(() => planningAiProfileChain(snapshot, { kind: 'item', id: 'feature-chat', revision: 1 }, 'mobile', 2)).toThrow(/stage/u);
    snapshot.draft.profiles[0].parentProfileId = 'mobile';
    expect(() => planningAiProfileChain(snapshot, target, 'mobile', 2)).toThrow(/cycle/u);
  });
  it('rejects stale role references and requires verified file context instead of silently omitting it', async () => {
    const { snapshot } = fixture();
    const profile: PlanningRoleProfile = { id: 'role', revision: 1, title: 'Role', role: 'design', instructions: '', contextRefs: [{ kind: 'item', id: 'feature-chat', revision: 99 }], allowedTools: ['planning.read'], retryLimit: 2 };
    await expect(planningAiFrozenContext(snapshot, [profile], [])).rejects.toThrow(/revision/u);
    profile.contextRefs = [{ kind: 'file', id: 'spec', revision: 1, sourcePath: 'docs/spec.md', hash: 'a'.repeat(64) }];
    await expect(planningAiFrozenContext(snapshot, [profile], [])).rejects.toThrow(/verified/u);
    expect(await planningAiFrozenContext(snapshot, [profile], [], async () => 'Verified body')).toMatchObject([{ content: 'Verified body' }]);
  });
});
