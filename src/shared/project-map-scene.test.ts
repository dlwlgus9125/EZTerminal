import { describe, expect, it } from 'vitest';

import architectureJson from '../../.ezterminal/project-map/maps/runtime-architecture.architecture.json';
import { layoutProjectMap } from './project-map-layout';
import {
  type ProjectMapDocument,
  validateProjectMapSpec,
} from './project-map';
import { diffProjectMapDocuments, serializeProjectMapSvg } from './project-map-scene';

const parsed = validateProjectMapSpec(architectureJson);
if (!parsed.value) throw new Error(JSON.stringify(parsed.diagnostics));
const spec = parsed.value;

function document(summary = spec.summary, fingerprintCharacter = 'a'): ProjectMapDocument {
  const currentSpec = { ...spec, summary };
  const layout = layoutProjectMap(currentSpec).layout;
  return {
    collectionId: 'ezterminal-system',
    mapId: currentSpec.id,
    mapPath: `.ezterminal/project-map/maps/${currentSpec.id}.${currentSpec.type}.json`,
    state: 'valid',
    spec: currentSpec,
    layout,
    provenance: {
      kind: 'commit-pinned',
      roots: [{ rootAlias: 'app', head: 'c'.repeat(40), dirty: false }],
    },
    verification: {
      quality: 'production',
      fingerprint: `sha256:${fingerprintCharacter.repeat(64)}`,
      verifiedAt: '2026-08-20T00:00:00.000Z',
      manifestHash: `sha256:${'1'.repeat(64)}`,
      specHash: `sha256:${'2'.repeat(64)}`,
      inputHash: `sha256:${'3'.repeat(64)}`,
      layoutHash: `sha256:${'4'.repeat(64)}`,
      checks: [
        'schema', 'semantics', 'evidence', 'inputs', 'layout', 'routes', 'labels',
        'containment', 'accessibility', 'provenance',
      ].map((name) => ({ name, status: 'passed' })) as ProjectMapDocument['verification']['checks'],
      diagnostics: [],
    },
    fromLastGood: false,
  };
}

describe('Project Map canonical scene', () => {
  it('serializes the same verified scene to a standalone 1600x900 SVG', () => {
    const current = document();
    const exported = serializeProjectMapSvg(current, 'dark');
    expect(exported.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"');
    expect(exported.svg).toContain(current.spec.title);
    expect(exported.svg).toContain(current.verification.fingerprint.slice(7, 19));
    expect(exported.svg).not.toMatch(/<script|javascript:|<foreignObject/iu);
  });

  it('reports only stable-ID semantic and evidence changes without risk inference', () => {
    const before = document();
    const after = document(`${spec.summary} Updated.`, 'b');
    const diff = diffProjectMapDocuments(before, after);
    expect(diff.fromFingerprint).toBe(before.verification.fingerprint);
    expect(diff.toFingerprint).toBe(after.verification.fingerprint);
    expect(diff.semantic).toEqual([{ kind: 'changed', id: spec.id, fields: ['summary'] }]);
    expect(diff.evidence).toEqual([]);
    expect(JSON.stringify(diff)).not.toMatch(/risk|severity/iu);
  });
});
