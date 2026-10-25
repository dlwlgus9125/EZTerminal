// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunCleanupPlan, RunRetentionAccess } from '../../shared/run-retention';
import { RunFolderCleanupDialog, runFolderKeepText } from './RunFolderCleanupDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const text = (_ko: string, en: string) => en;

const plan: RunCleanupPlan = {
  cleanedRunIds: [],
  runs: [
    { runId: 'r1', runNumber: 1, subprojectId: 'flow', why: 'older', folders: [
      { runId: 'r1', attemptId: 'A1', kind: 'attempt', path: 'C:/work/attempt-1', state: 'removable' },
      { runId: 'r1', attemptId: 'A1', kind: 'validation', path: 'C:/work/validation-1', state: 'kept', code: 'untracked', reason: 'It has files Git does not keep (untracked or ignored).' },
    ] },
    { runId: 'x1', runNumber: 1, subprojectId: 'other-flow', why: 'older', folders: [{ runId: 'x1', attemptId: 'B1', kind: 'attempt', path: 'C:/work/other', state: 'removable' }] },
  ],
};

describe('RunFolderCleanupDialog', () => {
  it('lists this flow’s older runs with what can go and why the rest stays, then cleans them up in one go', async () => {
    const access: RunRetentionAccess = {
      plan: vi.fn(async () => ({ ok: true as const, value: plan })),
      cleaned: vi.fn(async () => ({ ok: true as const, value: [] })),
      cleanup: vi.fn(async () => ({ ok: true as const, value: { removed: 1, kept: [] } })),
      folderState: vi.fn(), readFile: vi.fn(),
    };
    const onCleaned = vi.fn();
    await act(async () => root.render(<RunFolderCleanupDialog open onOpenChange={vi.fn()} projectId="P" subprojectId="flow" access={access} text={text} onCleaned={onCleaned} />));
    const dialog = document.querySelector('[data-testid="run-folder-cleanup"]')!;
    expect(dialog.textContent).toContain('Run #1');
    expect(dialog.textContent).toContain('C:/work/attempt-1');
    expect(dialog.textContent).toContain('It has files Git does not keep (ignored ones included).');
    // Another flow's runs are not offered here.
    expect(dialog.textContent).not.toContain('C:/work/other');
    const confirm = document.querySelector('[data-testid="run-folder-cleanup-confirm"]') as HTMLButtonElement;
    expect(confirm.textContent).toBe('Clean up 1 folder');
    await act(async () => confirm.click());
    expect(access.cleanup).toHaveBeenCalledWith('P', ['r1']);
    expect(document.body.textContent).toContain('Cleaned up 1 folder.');
    expect(onCleaned).toHaveBeenCalledWith([]);
  });

  it('says so when nothing can be cleaned up, and offers no button', async () => {
    const access: RunRetentionAccess = {
      plan: vi.fn(async () => ({ ok: true as const, value: { runs: [], cleanedRunIds: [] } })),
      cleaned: vi.fn(async () => ({ ok: true as const, value: [] })),
      cleanup: vi.fn(),
      folderState: vi.fn(), readFile: vi.fn(),
    };
    await act(async () => root.render(<RunFolderCleanupDialog open onOpenChange={vi.fn()} projectId="P" subprojectId="flow" access={access} text={text} />));
    expect(document.body.textContent).toContain('There are no work folders to clean up.');
    expect((document.querySelector('[data-testid="run-folder-cleanup-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('words every reason a folder stays, falling back to the host’s own words', () => {
    expect(runFolderKeepText('lfs', 'x', (ko) => ko)).toBe('Git LFS를 씁니다.');
    expect(runFolderKeepText(undefined, 'Host words.', text)).toBe('Host words.');
  });
});
