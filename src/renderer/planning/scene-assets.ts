import { useEffect, useState } from 'react';
import { PLANNING_ASSET_MAX_BYTES, PlanningAssetMimeSchema, type PlanningAssetApi, type PlanningAssetRequest } from '../../shared/planning-asset';
import type { PlanningAsset, ScreenScene } from '../../shared/planning';
import type { ScenePackage } from './scene-model';

export type SceneAssetBinary = NonNullable<ScenePackage['binaries']>[number];
export type SceneAssetData = Readonly<Record<string, SceneAssetBinary>>;
export function readAssetFile(file: File): Promise<{mimeType: Extract<PlanningAssetRequest, {type:'stage'}>['mimeType']; dataBase64: string}> {
  if (file.size > PLANNING_ASSET_MAX_BYTES) return Promise.reject(new Error('Each asset must be 512 KiB or smaller.'));
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const fallback = ({woff:'font/woff',woff2:'font/woff2',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'} as Record<string,string>)[extension ?? ''];
  const declared = PlanningAssetMimeSchema.safeParse(file.type);
  const mime = declared.success ? declared : PlanningAssetMimeSchema.safeParse(fallback);
  if (!mime.success) return Promise.reject(new Error('Choose PNG, JPEG, WebP, GIF, WOFF or WOFF2.'));
  return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('The asset file could not be read.')); reader.onload = () => resolve({mimeType:mime.data,dataBase64:String(reader.result).split(',')[1] ?? ''}); reader.readAsDataURL(file); });
}
export async function validateSceneAssetBinary(binary: SceneAssetBinary, asset: PlanningAsset): Promise<void> {
  const bytes = Uint8Array.from(atob(binary.dataBase64), (character) => character.charCodeAt(0));
  if (bytes.length !== asset.byteLength || bytes.length > PLANNING_ASSET_MAX_BYTES || binary.assetId !== asset.id || binary.mimeType !== asset.mimeType) throw new Error('Asset bytes do not match the declared metadata.');
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  const hash = [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
  if (hash !== binary.hash || hash !== asset.hash) throw new Error('Asset checksum verification failed.');
}
export async function packageSceneAssets(value: ScenePackage, projectId: string, api: PlanningAssetApi, baselineId?: string): Promise<ScenePackage> {
  const binaries: SceneAssetBinary[] = [];
  for (const asset of value.assets) {
    const result = await api.executePlanningAsset({type:'read',projectId,assetId:asset.id,...(baselineId ? {baselineId} : {})});
    if (!result.ok) throw new Error(result.message);
    if (!result.dataBase64 || result.asset.hash !== asset.hash) throw new Error(`Asset ${asset.title} could not be exported at the selected revision.`);
    const binary: SceneAssetBinary = {assetId:asset.id,hash:asset.hash,mimeType:PlanningAssetMimeSchema.parse(asset.mimeType),dataBase64:result.dataBase64};
    await validateSceneAssetBinary(binary,asset); binaries.push(binary);
  }
  return {...value,binaries};
}
/** Staging writes immutable files only; all metadata is returned for one planning.patch bundle. */
export async function stageSceneAssets(value: ScenePackage, projectId: string, api: PlanningAssetApi): Promise<ScenePackage> {
  const assets = [...value.assets];
  for (const binary of value.binaries ?? []) {
    const index = assets.findIndex((asset)=>asset.id === binary.assetId);
    const asset = assets[index];
    if (!asset) throw new Error('Asset metadata is missing.');
    await validateSceneAssetBinary(binary,asset);
    const result = await api.executePlanningAsset({type:'stage',projectId,assetId:asset.id,title:asset.title,mimeType:binary.mimeType,dataBase64:binary.dataBase64});
    if (!result.ok) throw new Error(result.message);
    if (result.asset.hash !== binary.hash) throw new Error('Staged asset checksum does not match.');
    assets[index] = result.asset;
  }
  return {...value, assets};
}

export function useSceneAssetData(api: PlanningAssetApi | undefined, projectId: string, scene: ScreenScene | undefined, assets: readonly PlanningAsset[], baselineId?: string): {data: SceneAssetData; errors: readonly string[]} {
  const [state, setState] = useState<{data: SceneAssetData; errors: readonly string[]}>({data:{},errors:[]});
  const references = JSON.stringify([...new Set(scene?.elements.map((element)=>element.properties.assetId).filter(Boolean) ?? [])].sort().map((id)=>({id,hash:assets.find((asset)=>asset.id === id)?.hash})));
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      if (!api) { setState({data:{},errors:[]}); return; }
      const required: {id:string;hash?:string}[] = JSON.parse(references);
      const settled = await Promise.allSettled(required.map(async (reference): Promise<SceneAssetBinary> => {
        const asset = assets.find((entry)=>entry.id === reference.id);
        if (!asset) throw new Error(`Missing asset: ${reference.id}`);
        const result = await api.executePlanningAsset({type:'read',projectId,assetId:asset.id,...(baselineId ? {baselineId} : {})});
        if (!result.ok) throw new Error(result.message);
        if (!result.dataBase64 || result.asset.hash !== asset.hash) throw new Error(`Asset revision changed: ${asset.title}`);
        const binary: SceneAssetBinary = {assetId:asset.id,hash:asset.hash,mimeType:PlanningAssetMimeSchema.parse(asset.mimeType),dataBase64:result.dataBase64};
        await validateSceneAssetBinary(binary,asset); return binary;
      }));
      if (current) setState({data:Object.fromEntries(settled.flatMap((result)=>result.status === 'fulfilled' ? [[result.value.assetId,result.value]] : [])),errors:settled.flatMap((result)=>result.status === 'rejected' ? [String(result.reason)] : [])});
    };
    void load(); return () => { current = false; };
  // Asset identity includes the selected baseline and every referenced content hash.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api,projectId,baselineId,references]);
  return state;
}
