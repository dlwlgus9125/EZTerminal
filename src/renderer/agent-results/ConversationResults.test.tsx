// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CleanedFolderState } from '../../shared/run-retention';
import { ConversationResults } from './ConversationResults';
import type { ResultsServices } from './results-services';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

const ROOT = 'C:\\work\\attempt-1';
const text = { ok: true as const, kind: 'text' as const, name: 'notes.txt', mime: 'text/plain' as const, content: 'text', truncated: false, fileSize: 4 };
const show = (sessionId: string, services: ResultsServices) => root.render(<ConversationResults
  source={{ ownerPanelId: `panel-${sessionId}`, sessionId, workspaceRoot: ROOT, items: [], children: [], transcriptFloor: 0, loaded: true, baselineSequence: 0, historyOnly: true, turnActive: false }}
  services={services} navigation={{ sequence: 1, section: 'files', path: 'notes.txt' }} />);

describe('ConversationResults and a cleaned-up work folder (Codex I2-7c P1-5)', () => {
  it('reads nothing of the folder until the host says it is live', async () => {
    const services: ResultsServices = { readFilePreview: vi.fn(async () => text), readCleanedFile: vi.fn(), cleanedFolder: vi.fn(() => new Promise<CleanedFolderState>(() => undefined)) };
    await act(async () => show('s-asking', services));
    expect(container.textContent).toContain('Checking the work folder');
    expect(services.readFilePreview).not.toHaveBeenCalled();
  });

  it('asks again while a cleanup removes the folder, then reads from the kept result', async () => {
    vi.useFakeTimers();
    const answers: CleanedFolderState[] = [{ state: 'retiring', root: ROOT }, { state: 'cleaned', root: ROOT, result: true }];
    const services: ResultsServices = { readFilePreview: vi.fn(async () => text), readCleanedFile: vi.fn(async () => text), cleanedFolder: vi.fn(async () => answers.shift()!) };
    await act(async () => show('s-retiring', services));
    expect(services.readFilePreview).not.toHaveBeenCalled();
    expect(services.readCleanedFile).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(services.cleanedFolder).toHaveBeenCalledTimes(2);
    expect(services.readCleanedFile).toHaveBeenCalledWith(`${ROOT}\\notes.txt`);
    expect(services.readFilePreview).not.toHaveBeenCalled();
  });

  it('reads nothing when the host cannot tell, and offers to ask again', async () => {
    const services: ResultsServices = { readFilePreview: vi.fn(async () => text), cleanedFolder: vi.fn(async () => { throw new Error('record unreadable'); }) };
    await act(async () => show('s-error', services));
    expect(container.textContent).toContain('Could not check');
    expect(services.readFilePreview).not.toHaveBeenCalled();
    await act(async () => ([...container.querySelectorAll('button')].find(button => button.textContent === 'Check again') as HTMLButtonElement).click());
    expect(services.cleanedFolder).toHaveBeenCalledTimes(2);
  });

  it('stops reading a live folder once the host says its cleanup record changed (Codex I2-7c recheck)', async () => {
    const listeners: (() => void)[] = [];
    const answers: CleanedFolderState[] = [{ state: 'live' }, { state: 'cleaned', root: ROOT, result: true }];
    const services: ResultsServices = { readFilePreview: vi.fn(async () => text), readCleanedFile: vi.fn(async () => text), cleanedFolder: vi.fn(async () => answers.shift()!),
      onFolderChanged: listener => { listeners.push(listener); return () => undefined; } };
    await act(async () => show('s-changed', services));
    expect(services.readFilePreview).toHaveBeenCalledTimes(1);
    await act(async () => { for (const listener of listeners) listener(); });
    expect(services.cleanedFolder).toHaveBeenCalledTimes(2);
    expect(services.readCleanedFile).toHaveBeenCalledWith(`${ROOT}\\notes.txt`);
    expect(services.readFilePreview).toHaveBeenCalledTimes(1);
  });

  it('reads a live folder as it is', async () => {
    const services: ResultsServices = { readFilePreview: vi.fn(async () => text), readCleanedFile: vi.fn(), cleanedFolder: vi.fn(async (): Promise<CleanedFolderState> => ({ state: 'live' })) };
    await act(async () => show('s-live', services));
    expect(services.readFilePreview).toHaveBeenCalledWith(`${ROOT}\\notes.txt`);
    expect(services.readCleanedFile).not.toHaveBeenCalled();
  });
});
