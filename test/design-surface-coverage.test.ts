import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MOBILE_PRIMARY_DESTINATIONS } from '../mobile/src/MobileTabBar';
import { MOBILE_SHEETS, MOBILE_SUB_PAGES } from '../mobile/src/MobileWorkspace';
import {
  DESKTOP_DESTINATION_STORIES,
  MOBILE_AUXILIARY_STORIES,
  MOBILE_PRIMARY_STORIES,
  MOBILE_SHEET_STORIES,
  MOBILE_SUB_PAGE_STORIES,
  type DesignSurfaceEvidence,
} from '../src/renderer/design-surface-registry';
import { ACTIVITY_RAIL_DESTINATIONS } from '../src/renderer/workbench/ActivityRail';

const storySources = [
  'src/renderer/workbench/DesktopHandoff.stories.tsx',
  'src/renderer/workbench/MobileShell.stories.tsx',
  'src/renderer/workbench/MobileActiveSurfaces.stories.tsx',
  'src/renderer/ui/Overlays.stories.tsx',
  'src/renderer/ui/Feedback.stories.tsx',
].map((path) => readFileSync(resolve(process.cwd(), path), 'utf8')).join('\n');

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function exportName(storyId: string): string {
  const slug = storyId.slice(storyId.lastIndexOf('--') + 2);
  return slug.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join('');
}

function expectStoriesExist(registry: Readonly<Record<string, DesignSurfaceEvidence>>): void {
  for (const [surface, evidence] of Object.entries(registry)) {
    expect(storySources, `${surface} -> ${evidence.storyId}`).toContain(`export const ${exportName(evidence.storyId)}`);
  }
}

describe('active design surface coverage', () => {
  it('covers every runtime desktop and mobile destination exactly once', () => {
    expect(sorted(Object.keys(DESKTOP_DESTINATION_STORIES))).toEqual(sorted(ACTIVITY_RAIL_DESTINATIONS));
    expect(sorted(Object.keys(MOBILE_PRIMARY_STORIES))).toEqual(sorted(MOBILE_PRIMARY_DESTINATIONS));
    expect(sorted(Object.keys(MOBILE_SUB_PAGE_STORIES))).toEqual(sorted(MOBILE_SUB_PAGES));
    expect(sorted(Object.keys(MOBILE_SHEET_STORIES))).toEqual(sorted(MOBILE_SHEETS));
  });

  it('points every active and auxiliary surface at a committed story export', () => {
    for (const registry of [
      DESKTOP_DESTINATION_STORIES,
      MOBILE_PRIMARY_STORIES,
      MOBILE_SUB_PAGE_STORIES,
      MOBILE_SHEET_STORIES,
      MOBILE_AUXILIARY_STORIES,
    ]) expectStoriesExist(registry);
  });
});
