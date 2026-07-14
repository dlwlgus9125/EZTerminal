// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FilePreviewResult } from '../shared/file-preview';
import { FilePreviewContent } from './FilePreviewContent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(
  result: FilePreviewResult,
  openExternalHttpUrl = vi.fn(),
  location: { line?: number; column?: number } = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(
    <FilePreviewContent result={result} openExternalHttpUrl={openExternalHttpUrl} {...location} />,
  ));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('FilePreviewContent', () => {
  it('renders Markdown without raw HTML or remote images and opens only safe links explicitly', () => {
    const openExternal = vi.fn();
    const element = render({
      ok: true,
      kind: 'text',
      name: 'README.md',
      mime: 'text/markdown',
      content: [
        '# Hello',
        '<script>window.evil = true</script>',
        '![tracker](https://example.com/tracker.png)',
        '[safe](https://example.com/docs)',
        '[unsafe](javascript:alert(1))',
      ].join('\n\n'),
      truncated: false,
      fileSize: 100,
    }, openExternal);

    expect(element.querySelector('script')).toBeNull();
    expect(element.querySelector('img')).toBeNull();
    expect(element.textContent).toContain('Image not loaded: tracker');
    expect(element.querySelectorAll('a')).toHaveLength(1);
    act(() => (element.querySelector('a') as HTMLAnchorElement).click());
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('owns and revokes an image Blob URL on unmount', () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const element = render({
      ok: true,
      kind: 'image',
      name: 'photo.png',
      mime: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      width: 1,
      height: 1,
      fileSize: 3,
    });

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect((element.querySelector('img') as HTMLImageElement).src).toBe('blob:preview');
    act(() => root?.unmount());
    root = null;
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('uses source mode and highlights an exact Markdown line/column location', () => {
    const element = render({
      ok: true,
      kind: 'text',
      name: 'README.md',
      mime: 'text/markdown',
      content: '# heading\nsecond line',
      truncated: false,
      fileSize: 21,
    }, vi.fn(), { line: 2, column: 3 });
    expect(element.querySelector('.file-preview-markdown')).toBeNull();
    expect(element.querySelector('[data-line="2"]')?.classList).toContain('file-source-line--selected');
    expect(element.querySelector('mark')?.textContent).toBe('c');
  });
});
