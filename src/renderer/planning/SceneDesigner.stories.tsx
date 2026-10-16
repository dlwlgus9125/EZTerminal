import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { PlanningEntityDrafts } from '../../shared/planning-draft';
import { AppI18nProvider } from '../i18n';
import { SceneDesigner, type SceneDesignerProps } from './SceneDesigner';
import { sceneSnapshot } from './scene-fixtures';
import '../index.css';
import assetImageUrl from '../../../docs/ux/reference/v2/screens/wireframe/D03.png?url';
import assetFontUrl from '../fonts/jetbrains-mono-latin.woff2?url';
import type { PlanningAssetApi } from '../../shared/planning-asset';
import type { PlanningAsset } from '../../shared/planning';

function ControlledSceneDesigner(args: SceneDesignerProps): JSX.Element {
  const [scenes, setScenes] = useState<PlanningEntityDrafts['scenes']>({});
  const [components, setComponents] = useState<PlanningEntityDrafts['components']>({});
  return <SceneDesigner {...args} sceneDrafts={scenes} componentDrafts={components}
    onSceneDraftChange={(value) => setScenes((current) => ({ ...current, [value.id]: { value, dirty: true } }))}
    onComponentDraftChange={(value) => setComponents((current) => ({ ...current, [value.id]: { value, dirty: true } }))} />;
}
const meta: Meta<typeof SceneDesigner> = {
  title: 'Production/Planning/Scene designer', component: SceneDesigner, parameters: { layout: 'fullscreen' },
  args: { snapshot: sceneSnapshot, sceneDrafts: {}, componentDrafts: {}, onSceneDraftChange: fn(), onComponentDraftChange: fn(), onPatch: fn() },
  decorators: [(Story) => <AppI18nProvider locale="ko" languages={['ko']}><div style={{ width: '100%', height: '100vh' }}><Story /></div></AppI18nProvider>],
  render: (args) => <ControlledSceneDesigner {...args} />,
};
export default meta;
type Story = StoryObj<typeof SceneDesigner>;
export const Desktop: Story = {};
export const Android: Story = { args: { mobile: true } };
export const OfflineEditing: Story = { args: { mobile: true, disabled: true } };
export const Empty: Story = { args: { snapshot: { ...sceneSnapshot, draft: { ...sceneSnapshot.draft, scenes: [] } } } };
export const WithFrozenBaseline: Story = { args: { snapshot: { ...sceneSnapshot, baselines: [{ id: 'baseline-1', title: '승인된 설계', sourceRevision: 2, createdAt: '2026-10-13T08:00:00.000Z', createdBy: { kind: 'user', id: 'desktop' }, hash: 'a'.repeat(64), draft: structuredClone(sceneSnapshot.draft) }] } } };
export const ActualAssets: Story = {
  loaders: [async () => {
    const binaries = await Promise.all([{id:'story-image',title:'승인 화면 와이어프레임',url:assetImageUrl,mimeType:'image/png'},{id:'story-font',title:'JetBrains Mono',url:assetFontUrl,mimeType:'font/woff2'}].map(async(source) => {
      const data = new Uint8Array(await (await fetch(source.url)).arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      const asset: PlanningAsset = {id:source.id,title:source.title,revision:2,relativePath:`.ezterminal/assets/${source.id}`,mimeType:source.mimeType,byteLength:data.length,hash};
      return {asset,dataBase64:btoa(Array.from(data,(byte)=>String.fromCharCode(byte)).join(''))};
    }));
    const snapshot = structuredClone(sceneSnapshot); snapshot.draft.assets = binaries.map(entry=>entry.asset);
    snapshot.draft.scenes[0].elements[0].properties.assetId = 'story-image';
    snapshot.draft.scenes[0].elements[1].properties = {...snapshot.draft.scenes[0].elements[1].properties,assetId:'story-font',text:'Asset preview · Aa Bb 0123'};
    const assetApi: PlanningAssetApi = {executePlanningAsset:async(request) => {const entry=binaries.find(item=>item.asset.id===request.assetId);return entry ? {ok:true,...entry} : {ok:false,message:'Unknown story asset'};}};
    return {snapshot,assetApi};
  }],
  render: (args,context) => <ControlledSceneDesigner {...args} snapshot={context.loaded.snapshot} assetApi={context.loaded.assetApi} />,
};
