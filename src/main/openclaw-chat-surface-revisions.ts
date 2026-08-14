import type { OpenClawChatSurfaceSnapshot } from '../shared/openclaw';

/** Monotonic within one renderer realm and one-way across renderer reloads. */
export class OpenClawChatSurfaceRevisionGate {
  private currentInstanceId: string | null = null;
  private currentRevision = 0;
  private readonly retiredInstanceIds = new Set<string>();

  public accept(surface: OpenClawChatSurfaceSnapshot): boolean {
    if (this.retiredInstanceIds.has(surface.instanceId)) return false;
    if (surface.instanceId !== this.currentInstanceId) {
      if (this.currentInstanceId) this.retiredInstanceIds.add(this.currentInstanceId);
      this.currentInstanceId = surface.instanceId;
      this.currentRevision = 0;
    }
    if (surface.revision <= this.currentRevision) return false;
    this.currentRevision = surface.revision;
    return true;
  }
}
