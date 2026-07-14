import {
  AGENT_SETTINGS_SCHEMA_VERSION,
  type AgentSettings,
  type GenericAgentProfile,
} from '../shared/agent';
import { JsonFile } from './json-file';

const AGENT_SETTINGS_FILE = 'agent-settings.json';
const MAX_GENERIC_PROFILES = 50;

export function defaultAgentSettings(): AgentSettings {
  return {
    schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
    notifications: { waiting: true, blocked: true, error: true },
    genericProfiles: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProfile(raw: unknown): GenericAgentProfile | null {
  if (!isPlainObject(raw)) return null;
  const { id, name, executable, enabled } = raw;
  if (typeof id !== 'string' || id.length < 1 || id.length > 80) return null;
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 80) return null;
  if (typeof executable !== 'string' || executable.length < 1 || executable.length > 128) return null;
  // Generic detection intentionally recognizes a direct executable basename,
  // never a path, wrapper, pipeline, or shell fragment.
  if (/[\\/\r\n\0]/u.test(executable) || executable.trim() !== executable) return null;
  if (typeof enabled !== 'boolean') return null;
  return { id, name, executable, enabled };
}

export function validateAgentSettings(raw: unknown): AgentSettings | null {
  if (!isPlainObject(raw) || raw.schemaVersion !== AGENT_SETTINGS_SCHEMA_VERSION) return null;
  if (!isPlainObject(raw.notifications)) return null;
  const { waiting, blocked, error } = raw.notifications;
  if (typeof waiting !== 'boolean' || typeof blocked !== 'boolean' || typeof error !== 'boolean') return null;
  if (!Array.isArray(raw.genericProfiles) || raw.genericProfiles.length > MAX_GENERIC_PROFILES) return null;

  const profiles: GenericAgentProfile[] = [];
  const ids = new Set<string>();
  const executables = new Set<string>();
  for (const entry of raw.genericProfiles) {
    const profile = parseProfile(entry);
    if (!profile) return null;
    const idKey = profile.id.toLocaleLowerCase('en-US');
    const executableKey = normalizeExecutable(profile.executable);
    if (ids.has(idKey) || executables.has(executableKey)) return null;
    ids.add(idKey);
    executables.add(executableKey);
    profiles.push(profile);
  }

  return {
    schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
    notifications: { waiting, blocked, error },
    genericProfiles: profiles,
  };
}

export function normalizeExecutable(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\.(?:exe|cmd|bat|ps1)$/u, '');
}

export class AgentSettingsStore {
  private readonly file: JsonFile;
  private cached: AgentSettings = defaultAgentSettings();

  constructor(dir: string) {
    this.file = new JsonFile(dir, AGENT_SETTINGS_FILE);
  }

  async init(): Promise<void> {
    await this.file.init();
    this.cached = await this.file.readValidated(validateAgentSettings, defaultAgentSettings());
  }

  get current(): AgentSettings {
    return this.cached;
  }

  async get(): Promise<AgentSettings> {
    return this.cached;
  }

  async set(raw: unknown): Promise<AgentSettings | null> {
    const parsed = validateAgentSettings(raw);
    if (!parsed) return null;
    await this.file.enqueue(async () => {
      await this.file.writeAtomic(JSON.stringify(parsed));
      this.cached = parsed;
    });
    return parsed;
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }
}
