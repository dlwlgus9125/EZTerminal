import type { IpcMain } from 'electron';

import {
  ChatAgentPhaseFileSchema,
  ChatAgentProfileListSchema,
  ChatAgentProfileSchema,
  EMPTY_CHAT_AGENT_PHASES,
  linkedPhaseSettings,
  type ChatAgentPhaseMap,
  type ChatAgentProfile,
  type ChatAgentProfileList,
  type ChatAgentProfileResult,
} from '../shared/chat-agent-profiles';
import { JsonFile } from './json-file';

const FILE = 'chat-agent-profiles.json';
/** Separate from the profiles: an older build reads a changed profile file strictly and would overwrite it. */
const PHASE_FILE = 'chat-agent-phases.json';
const EMPTY: ChatAgentProfileList = { version: 1, profiles: [] };
type PhaseFile = ChatAgentPhaseMap & { readonly version: 1 };
const EMPTY_PHASES: PhaseFile = { version: 1, ...EMPTY_CHAT_AGENT_PHASES };

function validatePhases(raw: unknown): PhaseFile | null {
  const parsed = ChatAgentPhaseFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function withoutVersion(file: PhaseFile): ChatAgentPhaseMap {
  return { byProvider: file.byProvider, ...(file.review ? { review: file.review } : {}), switchModel: file.switchModel };
}

function validate(raw: unknown): ChatAgentProfileList | null {
  const parsed = ChatAgentProfileListSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The desktop's saved agent profiles (main-process JSON, read by settings, the start panel and MCP). */
export class ChatAgentProfileStore {
  private readonly file: JsonFile;
  private readonly phaseFile: JsonFile;
  private cached: readonly ChatAgentProfile[] = [];
  private cachedPhases: ChatAgentPhaseMap = EMPTY_CHAT_AGENT_PHASES;

  constructor(dir: string) {
    this.file = new JsonFile(dir, FILE);
    this.phaseFile = new JsonFile(dir, PHASE_FILE);
  }

  async init(): Promise<void> {
    await this.file.init();
    this.cached = (await this.file.readValidated(validate, EMPTY)).profiles;
    await this.phaseFile.init();
    this.cachedPhases = withoutVersion(await this.phaseFile.readValidated(validatePhases, EMPTY_PHASES));
  }

  list(): readonly ChatAgentProfile[] {
    return this.cached;
  }

  /** 단계 연결 (Settings › AI): which saved agent each conversation phase uses. */
  phases(): ChatAgentPhaseMap {
    return this.cachedPhases;
  }

  /** The linked agent's effort (and model, with '모델도 바꾸기') for a phase of a `providerId` conversation. */
  phaseSettings(providerId: string, phase: 'plan' | 'implement'): { readonly model?: string; readonly reasoningEffort?: string } | undefined {
    const linked = linkedPhaseSettings(this.cachedPhases, this.cached, providerId, phase);
    return linked && (linked.model || linked.reasoningEffort)
      ? { ...(linked.model ? { model: linked.model } : {}), ...(linked.reasoningEffort ? { reasoningEffort: linked.reasoningEffort } : {}) }
      : undefined;
  }

  /** `expect`: write only while the saved links still pass it (checked in the write itself, after any save before it). */
  async savePhases(raw: unknown, expect?: (current: ChatAgentPhaseMap) => boolean): Promise<{ readonly ok: true; readonly phases: ChatAgentPhaseMap } | { readonly ok: false; readonly error: string; readonly conflict?: true }> {
    const parsed = ChatAgentPhaseFileSchema.safeParse(raw && typeof raw === 'object' ? { ...raw, version: 1 } : raw);
    if (!parsed.success) return { ok: false, error: 'These phase links are incomplete.' };
    const value = parsed.data;
    let conflict = false;
    const next = await this.phaseFile.update(validatePhases, EMPTY_PHASES, (current) => {
      if (expect && !expect(withoutVersion(current))) { conflict = true; return current; }
      return value;
    }, 'save chat agent phases');
    if (!next) return { ok: false, error: 'These phase links could not be saved.' };
    this.cachedPhases = withoutVersion(next);
    return conflict ? { ok: false, error: 'It changed since it was read; nothing was saved.', conflict: true } : { ok: true, phases: this.cachedPhases };
  }

  /** Adds a profile, or replaces the one with the same id in place. `expect` sees the saved one (or undefined) in the write itself. */
  async save(raw: unknown, expect?: (current: ChatAgentProfile | undefined) => boolean): Promise<ChatAgentProfileResult> {
    const parsed = ChatAgentProfileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'This profile is incomplete or too long.' };
    const profile = parsed.data;
    return this.write((current) => {
      const index = current.findIndex((entry) => entry.id === profile.id);
      return index < 0 ? [...current, profile] : current.map((entry, at) => (at === index ? profile : entry));
    }, 'save', 'Up to 50 profiles can be saved.', expect && ((current) => expect(current.find((entry) => entry.id === profile.id))));
  }

  async remove(id: unknown, expect?: (current: ChatAgentProfile | undefined) => boolean): Promise<ChatAgentProfileResult> {
    if (typeof id !== 'string') return { ok: false, error: 'This profile is no longer available.' };
    return this.write((current) => current.filter((entry) => entry.id !== id), 'remove', 'The profile could not be removed.',
      expect && ((current) => expect(current.find((entry) => entry.id === id))));
  }

  async flush(): Promise<void> {
    await this.file.flush();
    await this.phaseFile.flush();
  }

  private async write(
    mutate: (current: readonly ChatAgentProfile[]) => readonly ChatAgentProfile[],
    label: string,
    invalid: string,
    expect?: (current: readonly ChatAgentProfile[]) => boolean,
  ): Promise<ChatAgentProfileResult> {
    let conflict = false;
    const next = await this.file.update(validate, EMPTY, (current) => {
      if (expect && !expect(current.profiles)) { conflict = true; return current; }
      return { version: 1 as const, profiles: [...mutate(current.profiles)] };
    }, `${label} chat agent profile`);
    if (!next) return { ok: false, error: invalid };
    this.cached = next.profiles;
    return conflict ? { ok: false, error: 'It changed since it was read; nothing was saved.', conflict: true } : { ok: true, profiles: next.profiles };
  }
}

/** `chat-agent-profiles:list|save|remove|phases|save-phases` for the desktop renderer. */
export function installChatAgentProfileIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly store: ChatAgentProfileStore;
  readonly ready: Promise<unknown>;
}): () => void {
  const { ipc, store, ready } = input;
  ipc.handle('chat-agent-profiles:list', async () => {
    await ready;
    return store.list();
  });
  ipc.handle('chat-agent-profiles:save', async (_event, profile: unknown) => {
    await ready;
    return store.save(profile);
  });
  ipc.handle('chat-agent-profiles:remove', async (_event, id: unknown) => {
    await ready;
    return store.remove(id);
  });
  ipc.handle('chat-agent-profiles:phases', async () => {
    await ready;
    return store.phases();
  });
  ipc.handle('chat-agent-profiles:save-phases', async (_event, phases: unknown) => {
    await ready;
    return store.savePhases(phases);
  });
  return () => {
    for (const channel of ['list', 'save', 'remove', 'phases', 'save-phases']) ipc.removeHandler(`chat-agent-profiles:${channel}`);
  };
}
