/** Startup-only projection. A layout reference can open history, but can never restart a CLI. */
export function restoreConversationLayout(layout: unknown): unknown {
  const restored = structuredClone(layout) as { panels?: Record<string, { contentComponent?: string; params?: Record<string, unknown> }> };
  for (const panel of Object.values(restored.panels ?? {})) {
    if (panel.contentComponent !== 'terminal') continue;
    const params = panel.params ?? {};
    if (typeof params.conversationId === 'string') {
      panel.contentComponent = 'agent-session';
      panel.params = { historyId: params.conversationId, conversationId: params.conversationId };
    } else if (params.lastSurface !== 'terminal') panel.params = { ...params, restoreState: 'ended' };
  }
  return restored;
}
