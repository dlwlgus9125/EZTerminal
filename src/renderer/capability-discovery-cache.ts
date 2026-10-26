import type { AgentCapabilitiesClient, AgentCapabilitiesRequest } from '../shared/agent-capabilities';

type ListResult = Awaited<ReturnType<AgentCapabilitiesClient['list']>>;

/** How long one answer serves every box of the same conversation scope. */
export const CAPABILITY_DISCOVERY_REUSE_MS = 60_000;

const caches = new WeakMap<AgentCapabilitiesClient, Map<string, { readonly at: number; readonly answer: Promise<ListResult> }>>();

/**
 * The extensions catalog for a scope, asked once and shared for a minute.
 * Listing launches the provider (Codex app-server, Claude CLI); a message box
 * shown in several terminals, or remounted on every toggle, must not launch it
 * each time. A failed answer is not kept.
 */
export function discoverCapabilities(
  client: AgentCapabilitiesClient,
  request: AgentCapabilitiesRequest,
  now: () => number = Date.now,
): Promise<ListResult> {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  const key = `${request.providerId}\0${request.workspaceId}\0${request.sessionId ?? ''}`;
  const cached = cache.get(key);
  if (cached && now() - cached.at < CAPABILITY_DISCOVERY_REUSE_MS) return cached.answer;
  const answer = Promise.resolve().then(() => client.list(request));
  const entry = { at: now(), answer };
  cache.set(key, entry);
  const forget = (): void => { if (cache!.get(key) === entry) cache!.delete(key); };
  void answer.then((result) => { if (!result.ok) forget(); }, forget);
  return answer;
}
