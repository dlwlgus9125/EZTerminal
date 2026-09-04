import {
  DEFAULT_CLAUDE_PROVIDER_ENABLEMENT,
  getClaudeEnablementGateFailure,
  parseClaudeProviderEnablement,
  type ClaudeProviderEnablement,
} from '../shared/daemon-provider';
import type { ClaudeProviderEnablementStore } from './claude-provider-adapter';
import { JsonFile } from './json-file';

export const CLAUDE_PROVIDER_ENABLEMENT_FILE_NAME = 'claude-provider-enablement.json';
export const CLAUDE_PROVIDER_ENABLEMENT_SCHEMA_VERSION = 1;

interface ClaudeProviderEnablementFile {
  readonly schemaVersion: typeof CLAUDE_PROVIDER_ENABLEMENT_SCHEMA_VERSION;
  readonly enablement: ClaudeProviderEnablement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnablementFile(value: unknown): ClaudeProviderEnablementFile | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.includes('schemaVersion')
    || !keys.includes('enablement')
    || value.schemaVersion !== CLAUDE_PROVIDER_ENABLEMENT_SCHEMA_VERSION
  ) return null;
  const enablement = parseClaudeProviderEnablement(value.enablement);
  if (!enablement || getClaudeEnablementGateFailure(enablement)) return null;
  return {
    schemaVersion: CLAUDE_PROVIDER_ENABLEMENT_SCHEMA_VERSION,
    enablement,
  };
}

function defaultFile(): ClaudeProviderEnablementFile {
  return {
    schemaVersion: CLAUDE_PROVIDER_ENABLEMENT_SCHEMA_VERSION,
    enablement: { ...DEFAULT_CLAUDE_PROVIDER_ENABLEMENT },
  };
}

/**
 * Main-owned, non-secret Claude consent persistence. JsonFile provides the
 * serialized temp+rename commit and quarantines malformed or schema-invalid
 * files; exact-key validation prevents credentials from becoming settings.
 */
export class UserDataClaudeProviderEnablementStore implements ClaudeProviderEnablementStore {
  private readonly file: JsonFile;
  private initialization: Promise<void> | null = null;

  constructor(userDataDirectory: string) {
    this.file = new JsonFile(userDataDirectory, CLAUDE_PROVIDER_ENABLEMENT_FILE_NAME);
  }

  get path(): string {
    return this.file.path;
  }

  init(): Promise<void> {
    this.initialization ??= this.file.init();
    return this.initialization;
  }

  async load(): Promise<ClaudeProviderEnablement> {
    await this.init();
    return this.file.enqueue(async () => {
      const persisted = await this.file.readValidated(
        parseEnablementFile,
        defaultFile(),
      );
      return { ...persisted.enablement };
    });
  }

  async save(value: ClaudeProviderEnablement): Promise<void> {
    await this.init();
    const enablement = parseClaudeProviderEnablement(value);
    if (!enablement) throw new Error('Claude provider enablement is invalid.');
    const gateFailure = getClaudeEnablementGateFailure(enablement);
    if (gateFailure) throw new Error(gateFailure.message);
    const persisted: ClaudeProviderEnablementFile = {
      schemaVersion: CLAUDE_PROVIDER_ENABLEMENT_SCHEMA_VERSION,
      enablement,
    };
    await this.file.enqueue(() => this.file.writeAtomic(JSON.stringify(persisted)));
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
