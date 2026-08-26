import { describe, expect, it } from 'vitest';

import { layoutProjectMap } from './project-map-layout';
import {
  type ProjectMapEvidence,
  type ProjectMapManifest,
  type ProjectMapSpec,
  isProjectMapBindingRequest,
  isProjectMapCollectionRequest,
  isProjectMapStartJobRequest,
  normalizeProjectMapInputText,
  serializeProjectMapInputVersions,
  validateProjectMapManifest,
  validateProjectMapSpec,
  validateProjectMapSpecText,
} from './project-map';

const evidence: ProjectMapEvidence[] = [{
  rootAlias: 'app',
  relativePath: 'src/main/main.ts',
  startLine: 1,
  endLine: 2,
  lineDigest: `sha256:${'a'.repeat(64)}`,
  claim: 'The runtime starts here.',
}];

const common = {
  schemaVersion: 2 as const,
  id: 'sample',
  title: 'Sample map',
  summary: 'A bounded map used by contract tests.',
  contentLocale: 'en' as const,
  layoutIntent: { density: 'balanced' as const, emphasisIds: ['first', 'second'] },
  chapters: [{
    id: 'start-here',
    title: 'Start here',
    summary: 'Follow the primary path.',
    focusIds: ['first', 'second'],
  }],
};

const relation = {
  id: 'first-to-second',
  from: 'first',
  to: 'second',
  label: 'continues',
  kind: 'primary' as const,
  evidence,
};

describe('Project Map input review contract', () => {
  it('normalizes only line endings and serializes records in portable lexical order', () => {
    expect(normalizeProjectMapInputText('one\r\ntwo\rthree\n')).toBe('one\ntwo\nthree\n');
    expect(serializeProjectMapInputVersions([
      { rootAlias: 'z', relativePath: 'src/z.ts', version: 'z-version' },
      { rootAlias: 'app', relativePath: 'src/b.ts', version: 'b-version' },
      { rootAlias: 'app', relativePath: 'src/a.ts', version: 'a-version' },
    ])).toBe([
      'app\u0000src/a.ts\u0000a-version',
      'app\u0000src/b.ts\u0000b-version',
      'z\u0000src/z.ts\u0000z-version',
    ].join('\n'));
  });
});

const specs: ProjectMapSpec[] = [
  {
    ...common,
    type: 'architecture',
    groups: [{ id: 'runtime', label: 'Runtime' }],
    nodes: [
      { id: 'first', label: 'Renderer', kind: 'surface', group: 'runtime', rank: 0, order: 0, evidence },
      { id: 'second', label: 'Main', kind: 'service', group: 'runtime', rank: 1, order: 0, evidence },
    ],
    relations: [relation],
    mainPath: ['first', 'second'],
  },
  {
    ...common,
    type: 'workflow',
    lanes: [{ id: 'human', label: 'Human' }],
    steps: [
      { id: 'first', label: 'Review', kind: 'review', lane: 'human', rank: 0, order: 0, evidence },
      { id: 'second', label: 'Send', kind: 'action', lane: 'human', rank: 1, order: 0, evidence },
    ],
    transitions: [relation],
    mainPath: ['first', 'second'],
  },
  {
    ...common,
    type: 'sequence',
    participants: [
      { id: 'first', label: 'Renderer', kind: 'surface', evidence },
      { id: 'second', label: 'Main', kind: 'service', evidence },
    ],
    messages: [{
      id: 'request',
      from: 'first',
      to: 'second',
      label: 'request',
      kind: 'call',
      order: 0,
      evidence,
    }],
  },
  {
    ...common,
    type: 'dataflow',
    stages: [{ id: 'transport', label: 'Transport' }],
    entities: [
      { id: 'first', label: 'Frame', kind: 'source', stage: 'transport', order: 0, evidence },
      { id: 'second', label: 'Screen', kind: 'sink', stage: 'transport', order: 1, evidence },
    ],
    flows: [relation],
    primaryPath: ['first', 'second'],
  },
  {
    ...common,
    type: 'lifecycle',
    phases: [{ id: 'active', label: 'Active' }],
    states: [
      { id: 'first', label: 'Opening', kind: 'initial', phase: 'active', order: 0, evidence },
      { id: 'second', label: 'Ready', kind: 'steady', phase: 'active', order: 1, evidence },
    ],
    transitions: [{ ...relation, event: 'opened' }],
    initialState: 'first',
  },
];

describe('Project Map contract', () => {
  it.each(specs.map((spec) => [spec.type, spec] as const))(
    'validates and deterministically lays out a %s map',
    (_type, spec) => {
      const validation = validateProjectMapSpec(spec);
      expect(validation.value).toEqual(spec);
      expect(validation.diagnostics).toEqual([]);

      const first = layoutProjectMap(spec);
      const second = layoutProjectMap(spec);
      expect(second).toEqual(first);
      expect(first.layout.nodes).toHaveLength(2);
      expect(first.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    },
  );

  it('rejects unknown properties, traversal, and disconnected primary paths', () => {
    const source = specs[0];
    const result = validateProjectMapSpecText(JSON.stringify({
      ...source,
      unexpected: true,
      nodes: source.type === 'architecture'
        ? source.nodes.map((node) => ({
          ...node,
          evidence: node.evidence.map((anchor) => ({ ...anchor, relativePath: '../secret.txt' })),
        }))
        : [],
    }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('schema.invalid');

    if (source.type !== 'architecture') throw new Error('fixture mismatch');
    const disconnected = validateProjectMapSpec({
      ...source,
      relations: [{ ...relation, from: 'second', to: 'first' }],
    });
    expect(disconnected.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('semantic.disconnected-path');
  });

  it('rejects non-portable Windows path separators', () => {
    const source = specs[0];
    if (source.type !== 'architecture') throw new Error('fixture mismatch');
    const result = validateProjectMapSpec({
      ...source,
      nodes: source.nodes.map((node) => ({
        ...node,
        evidence: node.evidence.map((anchor) => ({
          ...anchor,
          relativePath: 'src\\main\\main.ts',
        })),
      })),
    });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('schema.invalid');
  });

  it.each([
    'src//main.ts',
    './src/main.ts',
    'src/./main.ts',
    'src/main.ts\u0000ignored',
    ' src/main.ts',
  ])('rejects ambiguous or control-bearing portable paths: %s', (relativePath) => {
    const source = specs[0];
    if (source.type !== 'architecture') throw new Error('fixture mismatch');
    const result = validateProjectMapSpec({
      ...source,
      nodes: source.nodes.map((node) => ({
        ...node,
        evidence: node.evidence.map((anchor) => ({ ...anchor, relativePath })),
      })),
    });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('schema.invalid');
  });

  it('requires globally unique semantic IDs and chapter focus on selectable items', () => {
    const source = specs[0];
    if (source.type !== 'architecture') throw new Error('fixture mismatch');
    const collision = validateProjectMapSpec({
      ...source,
      relations: [{ ...source.relations[0], id: 'first' }],
    });
    expect(collision.value).toBeUndefined();
    expect(collision.diagnostics.map((diagnostic) => diagnostic.code)).toContain('semantic.duplicate-id');

    const bandFocus = validateProjectMapSpec({
      ...source,
      chapters: [{ ...source.chapters[0], focusIds: ['runtime'] }],
    });
    expect(bandFocus.value).toBeUndefined();
    expect(bandFocus.diagnostics.map((diagnostic) => diagnostic.code)).toContain('semantic.unknown-reference');
  });

  it('rejects repeated primary path items and inconsistent lifecycle initial states', () => {
    const architecture = specs[0];
    const lifecycle = specs[4];
    if (architecture.type !== 'architecture' || lifecycle.type !== 'lifecycle') {
      throw new Error('fixture mismatch');
    }
    const repeated = validateProjectMapSpec({
      ...architecture,
      relations: [...architecture.relations, { ...architecture.relations[0], id: 'return', from: 'second', to: 'first' }],
      mainPath: ['first', 'second', 'first'],
    });
    expect(repeated.value).toBeUndefined();
    expect(repeated.diagnostics.map((diagnostic) => diagnostic.code)).toContain('semantic.repeated-path-item');

    const mismatched = validateProjectMapSpec({ ...lifecycle, initialState: 'second' });
    expect(mismatched.value).toBeUndefined();
    expect(mismatched.diagnostics.map((diagnostic) => diagnostic.code)).toContain('semantic.initial-state-mismatch');
  });

  it('requires portable root aliases and an explicit no-impact reason', () => {
    const manifest: ProjectMapManifest = {
      schemaVersion: 2,
      collectionId: 'ezterminal',
      ownerRootAlias: 'app',
      overviewMapId: 'sample',
      roots: [{ alias: 'app', label: 'EZTerminal' }],
      maps: [{
        id: 'sample',
        type: 'architecture',
        path: 'maps/sample.architecture.json',
        authoritativeInputs: [{ rootAlias: 'app', relativePath: 'src/main/main.ts' }],
        review: {
          inputDigest: `sha256:${'b'.repeat(64)}`,
          decision: 'no-semantic-impact',
        },
      }],
    };
    const result = validateProjectMapManifest(manifest);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('manifest.missing-review-reason');
  });

  it('rejects control-bearing or non-exact IPC request identities', () => {
    expect(isProjectMapCollectionRequest({
      projectId: 'project-1\u0000other',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
    })).toBe(false);
    expect(isProjectMapBindingRequest({
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      bindings: [{
        rootAlias: 'app',
        rootId: 'root-1',
        workspaceId: 'workspace-1',
        injected: true,
      }],
    })).toBe(false);
  });

  it('accepts only bounded dedicated-session metadata on Project Map jobs', () => {
    const request = {
      projectId: 'project-1',
      ownerRootId: 'root-1',
      ownerWorkspaceId: 'workspace-1',
      type: 'workflow',
      intent: 'create',
      activityId: 'activity-new-session',
      dispatch: 'dedicated-session',
      agentLabel: 'Codex',
    };
    expect(isProjectMapStartJobRequest(request)).toBe(true);
    expect(isProjectMapStartJobRequest({ ...request, dispatch: 'busy-existing-session' })).toBe(false);
    expect(isProjectMapStartJobRequest({ ...request, agentLabel: 'Codex\u0000hidden' })).toBe(false);
  });
});
