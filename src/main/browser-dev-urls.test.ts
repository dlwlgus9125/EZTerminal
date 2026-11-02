import { describe, expect, it, vi } from 'vitest';

import type { DaemonTranscriptItem } from '../shared/daemon-protocol';
import { BrowserDevUrls, devUrlOutput } from './browser-dev-urls';

const url = (port: number): string => `http://localhost:${String(port)}`;

describe('devUrlOutput: what counts as a program having printed an address', () => {
  const result = (patch: Partial<DaemonTranscriptItem>): DaemonTranscriptItem => ({
    id: 'r', sessionId: 'chat', sequence: 1, kind: 'tool-result', text: 'Local: http://localhost:5173/', isDelta: false, isSensitive: false, createdAt: '2026-11-02T00:00:00.000Z',
    payload: { v: 1, type: 'tool', callId: 'c', name: 'Bash', category: 'command', phase: 'result' }, ...patch,
  });
  const tool = (category: string, name = 'tool'): Partial<DaemonTranscriptItem> => ({ payload: { v: 1, type: 'tool', callId: 'c', name, category, phase: 'result' } as DaemonTranscriptItem['payload'] });

  it('is a command\'s output', () => {
    expect(devUrlOutput(result({}))).toBe('Local: http://localhost:5173/');
  });

  it.each(['web', 'mcp', 'read', 'search', 'list', 'edit', 'write', 'agent'])('is not a %s tool\'s: it can repeat what anyone wrote', (category) => {
    expect(devUrlOutput(result(tool(category)))).toBeUndefined();
  });

  it('is nothing with no payload to say what made it', () => {
    const plain = JSON.parse(JSON.stringify({ ...result({}), payload: undefined })) as DaemonTranscriptItem;
    expect(devUrlOutput(plain)).toBeUndefined();
  });

  it('is nothing from another kind of payload', () => {
    expect(devUrlOutput(result({ payload: { v: 1, type: 'todo', items: [] } as unknown as DaemonTranscriptItem['payload'] }))).toBeUndefined();
  });

  it('is nothing from a sensitive row', () => {
    expect(devUrlOutput(result({ isSensitive: true }))).toBeUndefined();
  });

  it.each(['tool-call', 'assistant-message', 'user-message', 'notice'] as const)('is nothing from a %s', (kind) => {
    expect(devUrlOutput(result({ kind }))).toBeUndefined();
  });
});

describe('BrowserDevUrls', () => {
  it('lists the latest first, with where each was seen', () => {
    const urls = new BrowserDevUrls();
    urls.add('workspace', url(1), 'terminal');
    urls.add('workspace', url(2), 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(2), source: 'ai' }, { url: url(1), source: 'terminal' }]);
  });

  it('keeps five to a workspace', () => {
    const urls = new BrowserDevUrls();
    for (const port of [1, 2, 3, 4, 5, 6, 7]) urls.add('workspace', url(port), 'terminal');
    expect(urls.candidates('workspace').map((entry) => entry.url)).toEqual([7, 6, 5, 4, 3].map(url));
  });

  it('keeps one entry for one address, as fresh as its last sighting', () => {
    const urls = new BrowserDevUrls();
    urls.add('workspace', url(1), 'terminal');
    urls.add('workspace', url(2), 'terminal');
    urls.add('workspace', url(1), 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(1), source: 'ai' }, { url: url(2), source: 'terminal' }]);
  });

  it('keeps workspaces apart', () => {
    const urls = new BrowserDevUrls();
    urls.add('one', url(1), 'terminal');
    expect(urls.candidates('two')).toEqual([]);
  });

  it('says when the list changed, and not when it did not', () => {
    const onChange = vi.fn();
    const urls = new BrowserDevUrls(onChange);
    urls.add('workspace', url(1), 'terminal');
    urls.add('workspace', url(1), 'terminal');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reads an AI\'s output from its end only', () => {
    const urls = new BrowserDevUrls();
    urls.addFromText('workspace', `${url(1)} ${'x'.repeat(20_000)} ${url(2)}`, 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(2), source: 'ai' }]);
  });

  it('never offers the app\'s own ports', () => {
    const urls = new BrowserDevUrls(undefined, () => new Set([1]));
    urls.addFromText('workspace', `${url(1)} ${url(2)}`, 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(2), source: 'ai' }]);
  });
});
