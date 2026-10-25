// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DerivedResults } from './derive-results';
import { ResultsFiles } from './ResultsFiles';
import type { ResultsServices } from './results-services';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const derived = (paths: readonly string[]): DerivedResults => ({
  changes: [], turns: [], running: [], pendingDecisions: 0, artifactSequence: 0,
  files: paths.map(path => ({ path, kind: 'update' })) as unknown as DerivedResults['files'],
});
const ROOT = 'C:\\work\\attempt-1';

describe('ResultsFiles in a cleaned-up work folder (작업 폴더 정리)', () => {
  it('reads the file from the run’s kept result, never the old path, and offers nothing that opens it', async () => {
    const services: ResultsServices = {
      readFilePreview: vi.fn(),
      readCleanedFile: vi.fn(async () => ({ ok: true as const, kind: 'text' as const, name: 'notes.txt', mime: 'text/plain' as const, content: 'as the run left it', truncated: false, fileSize: 18 })),
      openFileInApp: vi.fn(),
    };
    await act(async () => root.render(<ResultsFiles sessionId="s-clean-1" workspaceRoot={ROOT} derived={derived(['notes.txt'])} services={services}
      folder={{ kind: 'cleaned', root: ROOT, result: true }} />));
    expect(services.readCleanedFile).toHaveBeenCalledWith(`${ROOT}\\notes.txt`);
    expect(services.readFilePreview).not.toHaveBeenCalled();
    expect(container.textContent).toContain('as the run left it');
    expect(container.querySelector('[data-testid="results-files-cleaned"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Open with default app"]')).toBeNull();
  });

  it('shows no isolated HTML or PDF view of a cleaned folder, and reads nothing when the run kept no result', async () => {
    const renderHtml = vi.fn(() => <iframe title="html" />);
    const renderPdf = vi.fn(() => <iframe title="pdf" />);
    const services: ResultsServices = { readFilePreview: vi.fn(), readCleanedFile: vi.fn() };
    await act(async () => root.render(<ResultsFiles sessionId="s-clean-2" workspaceRoot={ROOT} derived={derived(['page.html'])} services={services}
      renderHtml={renderHtml} renderPdf={renderPdf} folder={{ kind: 'cleaned', root: ROOT, result: true }} />));
    expect(renderHtml).not.toHaveBeenCalled();
    expect(container.textContent).toContain('preview is not available');
    await act(async () => root.render(<ResultsFiles sessionId="s-clean-3" workspaceRoot={ROOT} derived={derived(['report.pdf'])} services={services}
      renderHtml={renderHtml} renderPdf={renderPdf} folder={{ kind: 'cleaned', root: ROOT, result: true }} />));
    expect(renderPdf).not.toHaveBeenCalled();
    await act(async () => root.render(<ResultsFiles sessionId="s-clean-4" workspaceRoot={ROOT} derived={derived(['notes.txt'])} services={services}
      folder={{ kind: 'cleaned', root: ROOT, result: false }} />));
    expect(container.textContent).toContain('kept no result');
    expect(services.readCleanedFile).not.toHaveBeenCalled();
    expect(services.readFilePreview).not.toHaveBeenCalled();
  });

  it('reads nothing while the host is asked, and nothing when it could not tell (Codex I2-7c P1-5)', async () => {
    const services: ResultsServices = { readFilePreview: vi.fn(), readCleanedFile: vi.fn(), openFileInApp: vi.fn() };
    const renderHtml = vi.fn(() => <iframe title="html" />);
    await act(async () => root.render(<ResultsFiles sessionId="s-check-1" workspaceRoot={ROOT} derived={derived(['page.html'])} services={services}
      renderHtml={renderHtml} folder={{ kind: 'checking' }} />));
    expect(renderHtml).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Open in browser"], [data-testid="results-open-browser"]')).toBeNull();
    const retry = vi.fn();
    await act(async () => root.render(<ResultsFiles sessionId="s-check-2" workspaceRoot={ROOT} derived={derived(['notes.txt'])} services={services}
      folder={{ kind: 'error', retry }} />));
    expect(container.textContent).toContain('Could not check');
    await act(async () => ([...container.querySelectorAll('button')].find(button => button.textContent === 'Check again') as HTMLButtonElement).click());
    expect(retry).toHaveBeenCalled();
    expect(services.readFilePreview).not.toHaveBeenCalled();
    expect(services.readCleanedFile).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Open with default app"]')).toBeNull();
  });

  it('still reads a folder that was not cleaned up as it is', async () => {
    const services: ResultsServices = {
      readFilePreview: vi.fn(async () => ({ ok: true as const, kind: 'text' as const, name: 'notes.txt', mime: 'text/plain' as const, content: 'live', truncated: false, fileSize: 4 })),
      readCleanedFile: vi.fn(),
      openFileInApp: vi.fn(),
    };
    await act(async () => root.render(<ResultsFiles sessionId="s-live" workspaceRoot={ROOT} derived={derived(['notes.txt'])} services={services} />));
    expect(services.readFilePreview).toHaveBeenCalledWith(`${ROOT}\\notes.txt`);
    expect(services.readCleanedFile).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Open with default app"]')).not.toBeNull();
  });
});
