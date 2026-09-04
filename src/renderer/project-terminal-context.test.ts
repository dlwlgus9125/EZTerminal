import { describe, expect, it } from 'vitest';

import type { ProjectWorkspaceDescriptor } from '../shared/project-workspace';
import { projectTerminalMetadataForDirectory } from './project-terminal-context';

const descriptor: ProjectWorkspaceDescriptor = {
  projectId: 'project-1',
  name: 'Project one',
  roots: [{
    rootId: 'root-1',
    name: 'Project one',
    displayPath: 'C:\\Work\\Project',
    primary: true,
  }],
  workspaces: [{
    workspaceId: 'main-1',
    rootId: 'root-1',
    name: 'Project one (main)',
    displayPath: 'C:\\Work\\Project',
    kind: 'main',
    access: 'granted',
  }, {
    workspaceId: 'external-1',
    rootId: 'root-1',
    name: 'External review',
    displayPath: 'D:\\Review',
    kind: 'external',
    access: 'authorization-required',
  }],
};

describe('projectTerminalMetadataForDirectory', () => {
  it('maps an exact Windows workspace root to main-owned opaque identity', () => {
    expect(projectTerminalMetadataForDirectory(descriptor, 'c:/work/project/')).toEqual({
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'main-1',
      projectName: 'Project one',
      titleMode: 'generated',
    });
  });

  it('does not project descendants or workspaces without access', () => {
    expect(projectTerminalMetadataForDirectory(descriptor, 'C:\\Work\\Project\\src')).toBeNull();
    expect(projectTerminalMetadataForDirectory(descriptor, 'D:\\Review')).toBeNull();
  });

  it('keeps POSIX matching case-sensitive', () => {
    const posix: ProjectWorkspaceDescriptor = {
      projectId: 'project-posix',
      name: 'Case sensitive',
      roots: [{ rootId: 'root-posix', name: 'Case sensitive', displayPath: '/work/Foo', primary: true }],
    };
    expect(projectTerminalMetadataForDirectory(posix, '/work/Foo/')).toMatchObject({
      rootId: 'root-posix',
      workspaceId: 'root-posix',
    });
    expect(projectTerminalMetadataForDirectory(posix, '/work/foo')).toBeNull();
  });
});
