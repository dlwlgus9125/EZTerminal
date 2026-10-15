import { z } from 'zod';
import { PlanningAssetSchema } from './planning';

export const PLANNING_ASSET_MAX_BYTES = 512 * 1024;
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const PlanningAssetMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'font/woff', 'font/woff2']);
export const PlanningAssetBinarySchema = z.object({
  assetId: id, hash: z.string().regex(/^[a-f0-9]{64}$/u), mimeType: PlanningAssetMimeSchema,
  dataBase64: z.string().min(4).max(Math.ceil(PLANNING_ASSET_MAX_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict();
export const PlanningAssetRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stage'), projectId: id, subprojectId: id.optional(), assetId: id, title: z.string().trim().min(1).max(300), mimeType: PlanningAssetMimeSchema, dataBase64: PlanningAssetBinarySchema.shape.dataBase64 }).strict(),
  z.object({ type: z.literal('read'), projectId: id, subprojectId: id.optional(), assetId: id, baselineId: id.optional() }).strict(),
]);
export type PlanningAssetRequest = z.infer<typeof PlanningAssetRequestSchema>;
export const PlanningAssetResultSchema = z.union([
  z.object({ ok: z.literal(true), asset: PlanningAssetSchema, dataBase64: PlanningAssetBinarySchema.shape.dataBase64.optional() }).strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);
export type PlanningAssetResult = z.infer<typeof PlanningAssetResultSchema>;
export interface PlanningAssetApi { executePlanningAsset(request: PlanningAssetRequest): Promise<PlanningAssetResult>; }
