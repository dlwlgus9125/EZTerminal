import type { IpcMain } from 'electron';

import {
  ChatAgentProfileListSchema,
  ChatAgentProfileSchema,
  type ChatAgentProfile,
  type ChatAgentProfileList,
  type ChatAgentProfileResult,
} from '../shared/chat-agent-profiles';
import { JsonFile } from './json-file';

const FILE = 'chat-agent-profiles.json';
const EMPTY: ChatAgentProfileList = { version: 1, profiles: [] };

function validate(raw: unknown): ChatAgentProfileList | null {
  const parsed = ChatAgentProfileListSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The desktop's saved agent profiles (main-process JSON, read by settings, the start panel and MCP). */
export class ChatAgentProfileStore {
  private readonly file: JsonFile;
  private cached: readonly ChatAgentProfile[] = [];

  constructor(dir: string) {
    this.file = new JsonFile(dir, FILE);
  }

  async init(): Promise<void> {
    await this.file.init();
    this.cached = (await this.file.readValidated(validate, EMPTY)).profiles;
  }

  list(): readonly ChatAgentProfile[] {
    return this.cached;
  }

  /** Adds a profile, or replaces the one with the same id in place. */
  async save(raw: unknown): Promise<ChatAgentProfileResult> {
    const parsed = ChatAgentProfileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'This profile is incomplete or too long.' };
    const profile = parsed.data;
    return this.write((current) => {
      const index = current.findIndex((entry) => entry.id === profile.id);
      return index < 0 ? [...current, profile] : current.map((entry, at) => (at === index ? profile : entry));
    }, 'save', 'Up to 50 profiles can be saved.');
  }

  async remove(id: unknown): Promise<ChatAgentProfileResult> {
    if (typeof id !== 'string') return { ok: false, error: 'This profile is no longer available.' };
    return this.write((current) => current.filter((entry) => entry.id !== id), 'remove', 'The profile could not be removed.');
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private async write(
    mutate: (current: readonly ChatAgentProfile[]) => readonly ChatAgentProfile[],
    label: string,
    invalid: string,
  ): Promise<ChatAgentProfileResult> {
    const next = await this.file.update(validate, EMPTY, (current) => ({ version: 1 as const, profiles: [...mutate(current.profiles)] }), `${label} chat agent profile`);
    if (!next) return { ok: false, error: invalid };
    this.cached = next.profiles;
    return { ok: true, profiles: next.profiles };
  }
}

/** `chat-agent-profiles:list|save|remove` for the desktop renderer. */
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
  return () => {
    for (const channel of ['list', 'save', 'remove']) ipc.removeHandler(`chat-agent-profiles:${channel}`);
  };
}
