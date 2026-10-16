import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningAssetApi } from '../../shared/planning-asset';
import type { PlanningAsset } from '../../shared/planning';
import { packageSceneAssets, stageSceneAssets } from './scene-assets';
import { exportScenePackage, parseScenePackage } from './scene-model';
import { sceneSnapshot } from './scene-fixtures';

const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXc8AAAAASUVORK5CYII=';
const bytes = Buffer.from(dataBase64,'base64');
const asset: PlanningAsset = {id:'asset-test',revision:2,title:'Image',relativePath:'.ezterminal/assets/original.png',hash:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png',byteLength:bytes.length};
function fixture() {
  const draft = structuredClone(sceneSnapshot.draft);
  draft.assets = [asset];
  draft.scenes[0].elements[1].properties.assetId = asset.id;
  return exportScenePackage(draft,draft.scenes[0].id);
}
describe('scene binary portability', () => {
  it('exports reachable binary content from the exact baseline and verifies the checksum', async () => {
    const executePlanningAsset = vi.fn<PlanningAssetApi['executePlanningAsset']>(async()=>({ok:true,asset,dataBase64}));
    const value = await packageSceneAssets(fixture(),'project-test',{executePlanningAsset},'baseline-test');
    expect(executePlanningAsset).toHaveBeenCalledWith({type:'read',projectId:'project-test',assetId:asset.id,baselineId:'baseline-test'});
    expect(parseScenePackage(value).binaries).toEqual([{assetId:asset.id,hash:asset.hash,mimeType:'image/png',dataBase64}]);
  });
  it('rejects corrupted bytes before staging any import', async () => {
    const value = {...fixture(),binaries:[{assetId:asset.id,hash:asset.hash,mimeType:'image/png' as const,dataBase64:Buffer.alloc(bytes.length).toString('base64')}]};
    const executePlanningAsset = vi.fn<PlanningAssetApi['executePlanningAsset']>();
    await expect(stageSceneAssets(value,'project-test',{executePlanningAsset})).rejects.toThrow('checksum');
    expect(executePlanningAsset).not.toHaveBeenCalled();
  });
  it('uses destination-owned staged paths when constructing the import bundle', async () => {
    const value = {...fixture(),binaries:[{assetId:asset.id,hash:asset.hash,mimeType:'image/png' as const,dataBase64}]};
    const staged = {...asset,relativePath:`.ezterminal/assets/${asset.hash}.png`,revision:0};
    const executePlanningAsset = vi.fn<PlanningAssetApi['executePlanningAsset']>(async()=>({ok:true,asset:staged}));
    const result = await stageSceneAssets(value,'destination',{executePlanningAsset});
    expect(result.assets).toEqual([staged]);
    expect(executePlanningAsset).toHaveBeenCalledWith(expect.objectContaining({type:'stage',projectId:'destination',assetId:asset.id,dataBase64}));
  });
  it('continues to parse legacy packages without binary entries', () => {
    expect(parseScenePackage(fixture()).binaries).toBeUndefined();
  });
  it('rejects duplicate or metadata-mismatched binary entries', () => {
    const binary = {assetId:asset.id,hash:asset.hash,mimeType:'image/png',dataBase64};
    expect(()=>parseScenePackage({...fixture(),binaries:[binary,binary]})).toThrow('duplicate');
    expect(()=>parseScenePackage({...fixture(),binaries:[{...binary,assetId:'unknown'}]})).toThrow('metadata');
  });
});
