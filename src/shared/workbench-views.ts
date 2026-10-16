import { z } from 'zod';

const id = z.string().min(1).max(256);
/** Presentation membership only. Paths, drafts and runtime credentials never belong here. */
export const WorkbenchViewsSchema = z.object({
  version: z.literal(1),
  activeId: id,
  views: z.array(z.object({ id, title: z.string().max(80), panelIds: z.array(id).max(64), activePanelId: id.optional() }).strict()).min(1).max(32),
}).strict().superRefine((value, context) => {
  const ids = value.views.map(view => view.id);
  const panels = value.views.flatMap(view => view.panelIds);
  if (new Set(ids).size !== ids.length || !ids.includes(value.activeId) || new Set(panels).size !== panels.length) {
    context.addIssue({ code: 'custom', message: 'Workbench views must have unique identities and membership.' });
  }
});
export type WorkbenchViewsState = z.infer<typeof WorkbenchViewsSchema>;
export type WorkbenchView = WorkbenchViewsState['views'][number];
