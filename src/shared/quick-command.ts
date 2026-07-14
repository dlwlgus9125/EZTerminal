import { z } from 'zod';

export const QUICK_COMMAND_SCHEMA_VERSION = 1 as const;
export const MAX_QUICK_COMMANDS = 200;
export const MAX_QUICK_COMMAND_NAME_CHARS = 80;
export const MAX_QUICK_COMMAND_CHARS = 8192;
export const MAX_QUICK_COMMAND_DESCRIPTION_CHARS = 240;

const QuickCommandNameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(MAX_QUICK_COMMAND_NAME_CHARS, `name must be at most ${MAX_QUICK_COMMAND_NAME_CHARS} characters`);

const QuickCommandTextSchema = z
  .string()
  .min(1, 'command is required')
  .max(MAX_QUICK_COMMAND_CHARS, `command must be at most ${MAX_QUICK_COMMAND_CHARS} characters`)
  .refine((command) => !/[\0\r\n]/.test(command), {
    message: 'command must be a single line and cannot contain NUL',
  });

const QuickCommandDescriptionSchema = z
  .string()
  .trim()
  .max(
    MAX_QUICK_COMMAND_DESCRIPTION_CHARS,
    `description must be at most ${MAX_QUICK_COMMAND_DESCRIPTION_CHARS} characters`,
  )
  .optional();

export interface QuickCommandInput {
  readonly name: string;
  readonly command: string;
  readonly description?: string;
}

/** Untrusted create/update payload accepted by the main-owned store. */
export const QuickCommandInputSchema: z.ZodType<QuickCommandInput> = z
  .strictObject({
    name: QuickCommandNameSchema,
    command: QuickCommandTextSchema,
    description: QuickCommandDescriptionSchema,
  })
  .transform(({ description, ...input }) => (description ? { ...input, description } : input));

/** Persisted and renderer-visible command. Commands never contain cwd/env or auto-run policy. */
export const QuickCommandSchema = z.strictObject({
  id: z.string().uuid(),
  name: QuickCommandNameSchema,
  command: QuickCommandTextSchema,
  description: QuickCommandDescriptionSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type QuickCommand = z.infer<typeof QuickCommandSchema>;

export type QuickCommandMutationError =
  | 'invalid'
  | 'duplicate-name'
  | 'limit-reached'
  | 'not-found'
  | 'id-collision';

export type QuickCommandMutationResult =
  | { readonly ok: true; readonly command: QuickCommand }
  | { readonly ok: false; readonly error: QuickCommandMutationError; readonly message: string };

export function quickCommandNameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('en-US');
}

export const QuickCommandsFileSchema = z
  .strictObject({
    schemaVersion: z.literal(QUICK_COMMAND_SCHEMA_VERSION),
    commands: z.array(QuickCommandSchema).max(MAX_QUICK_COMMANDS),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    file.commands.forEach((command, index) => {
      if (ids.has(command.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['commands', index, 'id'],
          message: 'quick command ids must be unique',
        });
      }
      ids.add(command.id);

      const key = quickCommandNameKey(command.name);
      if (names.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['commands', index, 'name'],
          message: 'quick command names must be unique ignoring case',
        });
      }
      names.add(key);
    });
  });

export type QuickCommandsFile = z.infer<typeof QuickCommandsFileSchema>;
