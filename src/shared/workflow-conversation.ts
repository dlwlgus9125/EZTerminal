import { z } from 'zod';
const id = z.string().min(1).max(160);
/** A saved, host-resolved quotation. This never grants graph or execution permissions. */
export const WorkflowConversationContextSchema = z.object({
  projectId: id, subprojectId: id, nodeId: id, graphRevision: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  title: z.string().max(300), document: z.string().max(200_000), instructions: z.string().max(65_536),
  references: z.array(z.object({ nodeId: id, kind: z.enum(['document', 'result']), title: z.string().max(300), text: z.string().max(300_000), runId: id.optional(), attemptId: id.optional() }).strict()).max(128),
}).strict();
export type WorkflowConversationContext = z.infer<typeof WorkflowConversationContextSchema>;
