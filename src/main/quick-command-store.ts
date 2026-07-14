import { randomUUID } from 'node:crypto';

import {
  MAX_QUICK_COMMANDS,
  QUICK_COMMAND_SCHEMA_VERSION,
  QuickCommandInputSchema,
  QuickCommandSchema,
  QuickCommandsFileSchema,
  quickCommandNameKey,
  type QuickCommand,
  type QuickCommandMutationResult,
  type QuickCommandsFile,
} from '../shared/quick-command';
import { JsonFile } from './json-file';

const QUICK_COMMANDS_FILE = 'quick-commands.json';

export type { QuickCommandMutationError, QuickCommandMutationResult } from '../shared/quick-command';

export interface QuickCommandStoreOptions {
  readonly newId?: () => string;
  readonly now?: () => Date;
}

type QuickCommandListener = (commands: readonly QuickCommand[]) => void;

const emptyFile = (): QuickCommandsFile => ({
  schemaVersion: QUICK_COMMAND_SCHEMA_VERSION,
  commands: [],
});

const validateFile = (raw: unknown): QuickCommandsFile | null => {
  const parsed = QuickCommandsFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

function copyCommand(command: QuickCommand): QuickCommand {
  return { ...command };
}

function invalidInputMessage(raw: unknown): string {
  const parsed = QuickCommandInputSchema.safeParse(raw);
  if (parsed.success) return 'invalid quick command';
  return parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'command'}: ${issue.message}`)
    .join('; ');
}

/**
 * Main-process authority for the bounded Quick Command collection.
 *
 * Every read-modify-write runs inside JsonFile's per-file queue. The store
 * never logs command text; listeners receive a fresh validated snapshot only
 * after a successful logical mutation has been written.
 */
export class QuickCommandStore {
  private readonly file: JsonFile;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly listeners = new Set<QuickCommandListener>();

  constructor(dir: string, options: QuickCommandStoreOptions = {}) {
    this.file = new JsonFile(dir, QUICK_COMMANDS_FILE);
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await this.file.init();
  }

  async list(): Promise<QuickCommand[]> {
    const current = await this.file.enqueue(() => this.file.readValidated(validateFile, emptyFile()));
    return current.commands.map(copyCommand);
  }

  subscribe(listener: QuickCommandListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(raw: unknown): Promise<QuickCommandMutationResult> {
    const input = QuickCommandInputSchema.safeParse(raw);
    if (!input.success) {
      return { ok: false, error: 'invalid', message: invalidInputMessage(raw) };
    }

    return this.mutate((current) => {
      if (current.commands.length >= MAX_QUICK_COMMANDS) {
        return {
          result: {
            ok: false,
            error: 'limit-reached',
            message: `at most ${MAX_QUICK_COMMANDS} quick commands can be saved`,
          },
        };
      }
      if (this.hasName(current.commands, input.data.name)) {
        return {
          result: {
            ok: false,
            error: 'duplicate-name',
            message: 'a quick command with that name already exists',
          },
        };
      }

      const now = this.now().toISOString();
      const command = QuickCommandSchema.safeParse({
        id: this.newId(),
        ...input.data,
        createdAt: now,
        updatedAt: now,
      });
      if (!command.success) {
        return {
          result: {
            ok: false,
            error: 'invalid',
            message: 'failed to generate a valid quick command record',
          },
        };
      }
      if (current.commands.some((item) => item.id === command.data.id)) {
        return {
          result: {
            ok: false,
            error: 'id-collision',
            message: 'failed to generate a unique quick command id',
          },
        };
      }

      const next: QuickCommandsFile = {
        ...current,
        commands: [...current.commands, command.data],
      };
      return { next, result: { ok: true, command: copyCommand(command.data) } };
    });
  }

  async update(id: string, raw: unknown): Promise<QuickCommandMutationResult> {
    const input = QuickCommandInputSchema.safeParse(raw);
    if (!input.success) {
      return { ok: false, error: 'invalid', message: invalidInputMessage(raw) };
    }

    return this.mutate((current) => {
      const index = current.commands.findIndex((command) => command.id === id);
      if (index < 0) {
        return { result: { ok: false, error: 'not-found', message: 'quick command not found' } };
      }
      if (this.hasName(current.commands, input.data.name, id)) {
        return {
          result: {
            ok: false,
            error: 'duplicate-name',
            message: 'a quick command with that name already exists',
          },
        };
      }

      const previous = current.commands[index];
      const description = input.data.description;
      const command = QuickCommandSchema.parse({
        id: previous.id,
        name: input.data.name,
        command: input.data.command,
        ...(description ? { description } : {}),
        createdAt: previous.createdAt,
        updatedAt: this.now().toISOString(),
      });
      const commands = current.commands.slice();
      commands[index] = command;
      return {
        next: { ...current, commands },
        result: { ok: true, command: copyCommand(command) },
      };
    });
  }

  async delete(id: string): Promise<QuickCommandMutationResult> {
    return this.mutate((current) => {
      const index = current.commands.findIndex((command) => command.id === id);
      if (index < 0) {
        return { result: { ok: false, error: 'not-found', message: 'quick command not found' } };
      }
      const command = current.commands[index];
      return {
        next: {
          ...current,
          commands: current.commands.filter((item) => item.id !== id),
        },
        result: { ok: true, command: copyCommand(command) },
      };
    });
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private hasName(commands: readonly QuickCommand[], name: string, exceptId?: string): boolean {
    const key = quickCommandNameKey(name);
    return commands.some((command) => command.id !== exceptId && quickCommandNameKey(command.name) === key);
  }

  private async mutate(
    mutation: (current: QuickCommandsFile) => {
      readonly next?: QuickCommandsFile;
      readonly result: QuickCommandMutationResult;
    },
  ): Promise<QuickCommandMutationResult> {
    return this.file.enqueue(async () => {
      const current = await this.file.readValidated(validateFile, emptyFile());
      const { next, result } = mutation(current);
      if (!next) return result;

      const validated = validateFile(next);
      if (validated === null) {
        return {
          ok: false,
          error: 'invalid',
          message: 'quick command update failed validation',
        };
      }
      await this.file.writeAtomic(JSON.stringify(validated));
      this.notify(validated.commands);
      return result;
    });
  }

  private notify(commands: readonly QuickCommand[]): void {
    for (const listener of this.listeners) {
      try {
        listener(commands.map(copyCommand));
      } catch (error) {
        console.error('[quick-command-store] change listener failed:', error);
      }
    }
  }
}
