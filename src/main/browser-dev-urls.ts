import type { BrowserDevCandidate } from '../shared/browser';
import { findDevUrls } from '../shared/dev-server-url';

const KEPT_PER_WORKSPACE = 5;
const TEXT_TAIL_CHARS = 16_000;

/** What a workspace's terminals and AIs last named, in memory: a dev server's address outlives neither it nor the app. */
export class BrowserDevUrls {
  private readonly workspaces = new Map<string, readonly BrowserDevCandidate[]>();

  constructor(private readonly onChange?: () => void, private readonly controlPorts?: () => ReadonlySet<number>) {}

  candidates(workspaceId: string): readonly BrowserDevCandidate[] {
    return this.workspaces.get(workspaceId) ?? [];
  }

  add(workspaceId: string, url: string, source: BrowserDevCandidate['source']): void {
    const known = this.candidates(workspaceId);
    if (known[0]?.url === url && known[0].source === source) return;
    this.workspaces.set(workspaceId, [{ url, source }, ...known.filter((entry) => entry.url !== url)].slice(0, KEPT_PER_WORKSPACE));
    this.onChange?.();
  }

  addFromText(workspaceId: string, text: string, source: BrowserDevCandidate['source']): void {
    const urls = findDevUrls(text.slice(-TEXT_TAIL_CHARS), this.controlPorts?.());
    for (const url of urls) this.add(workspaceId, url, source);
  }
}
