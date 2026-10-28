import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  WorkflowTemplateFileSchema,
  WorkflowTemplateInputSchema,
  isBuiltinWorkflowTemplateId,
  type WorkflowTemplate,
  type WorkflowTemplateFile,
  type WorkflowTemplateResult,
} from '../shared/workflow-templates';
import { JsonFile } from './json-file';

const FILE = 'workflow-templates.json';
const EMPTY: WorkflowTemplateFile = { version: 1, templates: [] };

/** Tolerant read: a damaged file is an empty list (and is set aside as `.corrupt`), never a crash. */
function validate(raw: unknown): WorkflowTemplateFile | null {
  const parsed = WorkflowTemplateFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The workflow templates saved on this PC (app-wide, every project). The built-ins are code and never stored. */
export class WorkflowTemplateStore {
  private readonly file: JsonFile;
  private cached: readonly WorkflowTemplate[] = [];

  constructor(dir: string, private readonly now: () => Date = () => new Date()) {
    this.file = new JsonFile(dir, FILE);
  }

  async init(): Promise<void> {
    await this.file.init();
    this.cached = (await this.file.readValidated(validate, EMPTY)).templates;
  }

  list(): readonly WorkflowTemplate[] {
    return this.cached;
  }

  /** Adds a template, or replaces the one with the same id in place (keeping when it was first saved). */
  async save(raw: unknown, expect?: (current: WorkflowTemplate | undefined) => boolean): Promise<WorkflowTemplateResult> {
    const parsed = WorkflowTemplateInputSchema.safeParse(raw);
    if (!parsed.success || isBuiltinWorkflowTemplateId(parsed.data.id)) return { ok: false, error: 'This template is incomplete or too long.' };
    const input = parsed.data;
    const at = this.now().toISOString();
    return this.write((current) => {
      const index = current.findIndex((entry) => entry.id === input.id);
      return index < 0
        ? [...current, { ...input, createdAt: at, updatedAt: at }]
        : current.map((entry, position) => (position === index ? { ...input, createdAt: entry.createdAt, updatedAt: at } : entry));
    }, 'save', 'Up to 200 templates can be saved.', expect && ((current) => expect(current.find((entry) => entry.id === input.id))));
  }

  /** `expect` (save and remove) sees the saved template (or undefined) in the write itself. */
  async remove(id: unknown, expect?: (current: WorkflowTemplate | undefined) => boolean): Promise<WorkflowTemplateResult> {
    if (typeof id !== 'string') return { ok: false, error: 'This template is no longer available.' };
    return this.write((current) => current.filter((entry) => entry.id !== id), 'remove', 'The template could not be removed.',
      expect && ((current) => expect(current.find((entry) => entry.id === id))));
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private async write(
    mutate: (current: readonly WorkflowTemplate[]) => readonly WorkflowTemplate[],
    label: string,
    invalid: string,
    expect?: (current: readonly WorkflowTemplate[]) => boolean,
  ): Promise<WorkflowTemplateResult> {
    let conflict = false;
    const next = await this.file.update(validate, EMPTY, (current) => {
      if (expect && !expect(current.templates)) { conflict = true; return current; }
      return { version: 1 as const, templates: [...mutate(current.templates)] };
    }, `${label} workflow template`);
    if (!next) return { ok: false, error: invalid };
    this.cached = next.templates;
    return conflict ? { ok: false, error: 'It changed since it was read; nothing was saved.', conflict: true } : { ok: true, templates: next.templates };
  }
}

/** `workflow-templates:list|save|remove` for the desktop renderer. */
export function installWorkflowTemplateIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly store: WorkflowTemplateStore;
  readonly ready: Promise<unknown>;
  /** The sender is an EZTerminal window with its session-surface id. */
  readonly authorized: (event: IpcMainInvokeEvent, clientId: unknown) => boolean;
}): () => void {
  const { ipc, store, ready, authorized } = input;
  const refused = { ok: false as const, error: 'This window cannot change templates.' };
  ipc.handle('workflow-templates:list', async (event, clientId: unknown) => {
    if (!authorized(event, clientId)) return [];
    await ready;
    return store.list();
  });
  ipc.handle('workflow-templates:save', async (event, clientId: unknown, template: unknown) => {
    if (!authorized(event, clientId)) return refused;
    await ready;
    return store.save(template);
  });
  ipc.handle('workflow-templates:remove', async (event, clientId: unknown, id: unknown) => {
    if (!authorized(event, clientId)) return refused;
    await ready;
    return store.remove(id);
  });
  return () => {
    for (const channel of ['list', 'save', 'remove']) ipc.removeHandler(`workflow-templates:${channel}`);
  };
}
