import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Plus, Save, Trash2, Upload } from 'lucide-react';
import {
  PlanningComponentSchema, ScreenSceneSchema, validatePlanningDraft,
  type PlanningComponent, type PlanningDraft, type PlanningOperation, type PlanningSnapshot, type SceneElement, type ScreenScene,
} from '../../shared/planning';
import type { PlanningEntityDrafts } from '../../shared/planning-draft';
import type { PlanningAssetApi } from '../../shared/planning-asset';
import { packageSceneAssets, readAssetFile, stageSceneAssets, useSceneAssetData, validateSceneAssetBinary } from './scene-assets';
import { useAppTranslation } from '../i18n';
import { Button, Field, Input, Select, Tab, TabList, TabPanel, Tabs } from '../ui';
import { ScenePreview } from './ScenePreview';
import { PlanningAiPanel, type PlanningAiPanelProps } from './PlanningAiPanel';
import {
  SCENE_KINDS, STATE_KINDS, PROPERTY_KEYS, deleteSceneElement, descendantIds, exportScenePackage, instanceOwner,
  instantiateComponent, moveElement, newElement, newScene, parseScenePackage, sceneIdentity, sceneImportOperations, type ScenePackage,
} from './scene-model';
import './scene-designer.css';

export interface SceneDesignerProps {
  readonly snapshot: PlanningSnapshot;
  readonly sceneDrafts: PlanningEntityDrafts['scenes'];
  readonly componentDrafts: PlanningEntityDrafts['components'];
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly mobile?: boolean;
  readonly onSceneDraftChange: (value: ScreenScene) => void;
  readonly onComponentDraftChange: (value: PlanningComponent) => void;
  readonly onPatch: (operations: PlanningOperation[], summary: string) => void;
  readonly onExportScene?: (name: string, content: string) => Promise<void>;
  readonly ai?: Omit<PlanningAiPanelProps, 'snapshot' | 'target' | 'disabled' | 'disabledReason'>;
  readonly assetApi?: PlanningAssetApi;
}

function overlay<T extends { id: string }>(saved: readonly T[], drafts: Record<string, { value: T; dirty: boolean }>): T[] {
  const result = new Map(saved.map((value) => [value.id, value]));
  for (const entry of Object.values(drafts)) result.set(entry.value.id, entry.value);
  return [...result.values()];
}
function componentScene(component: PlanningComponent): ScreenScene {
  return { id: component.id, revision: component.revision, title: component.title, platform: 'windows', width: 800, height: 450,
    featureIds: [], elements: component.elements, states: [{ id: 'default', title: 'Default', kind: 'default' }], transitions: [], status: 'draft' };
}
function boundedNumber(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : minimum;
}

/** Authoring drafts stay controlled by the project recovery store; Save uses planning.patch. */
export function SceneDesigner({ snapshot, sceneDrafts, componentDrafts, disabled = false, readOnly = false, mobile = false, onSceneDraftChange, onComponentDraftChange, onPatch, onExportScene, assetApi, ai }: SceneDesignerProps): JSX.Element {
  const { i18n } = useAppTranslation(); const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const copy = (ko: string, en: string): string => korean ? ko : en;
  const [baselineId, setBaselineId] = useState('draft');
  const [mode, setMode] = useState<'scenes' | 'components'>('scenes');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [elementId, setElementId] = useState<string | null>(null);
  const [stateId, setStateId] = useState('default');
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const [pane, setPane] = useState('preview');
  const [prototype, setPrototype] = useState(false);
  const [addKind, setAddKind] = useState<SceneElement['kind']>('text');
  const [componentToInsert, setComponentToInsert] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<ScenePackage | null>(null);
  const [exporting, setExporting] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [importSubmitted, setImportSubmitted] = useState<number | null>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(mobile);
  const [availableWidth, setAvailableWidth] = useState(390);
  useEffect(() => {
    const measure = (): void => { const width = container.current?.getBoundingClientRect().width ?? 0; if (width > 0) { setCompact(mobile || width < 1000); setAvailableWidth(width); } else setCompact(mobile); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (container.current) observer?.observe(container.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [mobile]);
  const fileInput = useRef<HTMLInputElement>(null);
  const baseline = snapshot.baselines.find((entry) => entry.id === baselineId);
  // The baseline shown was cleaned up (기획 기준본 정리): not silently the draft; nothing is edited until the person picks one.
  const baselineGone = baselineId !== 'draft' && !baseline;
  const base = baseline?.draft ?? snapshot.draft;
  const scenes = useMemo(() => baseline ? base.scenes : overlay(base.scenes, sceneDrafts), [base.scenes, baseline, sceneDrafts]);
  const components = useMemo(() => baseline ? base.components : overlay(base.components, componentDrafts), [base.components, baseline, componentDrafts]);
  const entity = (mode === 'scenes' ? scenes : components).find((value) => value.id === selectedId)
    ?? (mode === 'scenes' ? scenes[0] : components[0]);
  const scene = entity ? mode === 'scenes' ? entity as ScreenScene : componentScene(entity as PlanningComponent) : undefined;
  const loadedAssets = useSceneAssetData(assetApi, snapshot.projectId, scene, base.assets, baseline?.id);
  const previewWidth = viewportWidth ?? (compact ? Math.max(240, Math.min(scene?.width ?? 390, availableWidth - 32)) : scene?.width ?? 800);
  const component = mode === 'components' ? entity as PlanningComponent | undefined : undefined;
  const selection = scene?.elements.find((element) => element.id === elementId);
  const activeState = scene?.states.find((state) => state.id === stateId) ?? scene?.states[0];
  const editBlocked = readOnly || !!baseline || baselineGone;
  const saveBlocked = disabled || editBlocked || assetBusy || importSubmitted !== null;
  const previousDisabled = useRef(disabled);
  useEffect(() => {
    if (importSubmitted !== null && snapshot.revision > importSubmitted) {
      if (imported?.scenes.every((entry) => snapshot.draft.scenes.some((saved) => saved.id === entry.id && saved.revision > importSubmitted))) { setImported(null); setImportSubmitted(null); }
    } else if (importSubmitted !== null && previousDisabled.current && !disabled) setImportSubmitted(null);
    previousDisabled.current = disabled;
  }, [disabled, imported, importSubmitted, snapshot]);
  const owner = scene && selection ? instanceOwner(scene.elements, selection.id) : undefined;
  const sourceComponent = owner?.component ? components.find((entry) => entry.id === owner.component!.componentId) : undefined;
  const allowedProperties = owner ? owner.id === selection?.id ? sourceComponent?.allowedOverrides ?? [] : [] : PROPERTY_KEYS;
  const structuralBlocked = editBlocked || !!owner;
  const draft: PlanningDraft = { ...base, scenes, components };
  const updateScene = (value: ScreenScene): void => {
    if (editBlocked) return;
    setError(null);
    if (component) onComponentDraftChange({ ...component, title: value.title, elements: value.elements });
    else onSceneDraftChange(value);
  };
  const updateElement = (patch: Partial<SceneElement>): void => {
    if (!scene || !selection || editBlocked) return;
    updateScene({ ...scene, elements: scene.elements.map((element) => element.id === selection.id ? { ...element, ...patch } : element) });
  };
  const updateProperty = <K extends keyof SceneElement['properties']>(key: K, value: SceneElement['properties'][K]): void => {
    if (!selection || !allowedProperties.includes(key)) return;
    updateElement({ properties: { ...selection.properties, [key]: value },
      ...(selection.component ? { component: { ...selection.component, overrides: { ...selection.component.overrides, [key]: value } } } : {}) });
  };
  const choose = (id: string): void => { setSelectedId(id); setElementId(null); setStateId('default'); setViewportWidth(null); setError(null); setPrototype(false); };
  const create = (): void => {
    if (editBlocked) return;
    if (mode === 'scenes') { const value = newScene(mobile ? 'android' : 'windows'); onSceneDraftChange(value); choose(value.id); }
    else { const value: PlanningComponent = { id: sceneIdentity('component'), revision: 0, title: '', elements: [newElement('frame', null, 0)], allowedOverrides: ['text', 'accessibleName', 'disabled'] }; onComponentDraftChange(value); choose(value.id); }
    setPane('properties');
  };
  const save = (): void => {
    if (!entity || saveBlocked) return;
    const parsed = mode === 'scenes' ? ScreenSceneSchema.safeParse(entity) : PlanningComponentSchema.safeParse(entity);
    if (!parsed.success) { setError(copy('이름과 속성을 확인한 뒤 저장하세요.', 'Check the name and properties before saving.')); return; }
    if (component && component.elements.filter((element) => element.parentId === null).length !== 1) { setError(copy('공통 요소는 최상위 요소가 하나여야 합니다.', 'A reusable component needs exactly one root.')); return; }
    const issues = validatePlanningDraft(draft);
    if (issues.length) { setError(issues.slice(0, 4).join('\n')); return; }
    onPatch(mode === 'scenes' ? [{ op: 'scene.put', value: entity as ScreenScene }] : [{ op: 'component.put', value: entity as PlanningComponent }], `${mode === 'scenes' ? 'Scene' : 'Component'}: ${entity.title}`);
  };
  const add = (): void => {
    if (!scene || editBlocked || owner) return;
    const parentId = selection?.id ?? null;
    const value = newElement(addKind, parentId, scene.elements.filter((entry) => entry.parentId === parentId).length);
    updateScene({ ...scene, elements: [...scene.elements, value] }); setElementId(value.id); setPane('properties');
  };
  const insertComponent = (): void => {
    if (!scene || editBlocked || owner) return;
    // Only published component versions can become a linked instance.
    const source = base.components.find((entry) => entry.id === componentToInsert);
    if (!source || source.id === component?.id) return;
    try { const parentId = selection?.id ?? null; const elements = instantiateComponent(source, parentId, scene.elements.filter((entry) => entry.parentId === parentId).length);
      updateScene({ ...scene, elements: [...scene.elements, ...elements] }); setElementId(elements.find((entry) => entry.component?.componentId === source.id)?.id ?? null);
    } catch (reason) { setError(String(reason)); }
  };
  const exportFile = async (): Promise<void> => {
    if (!scene || component || exporting) return;
    setExporting(true);
    try {
      let value = exportScenePackage(draft, scene.id);
      if (value.assets.length) {
        if (!assetApi) throw new Error(copy('자산 파일을 읽을 연결이 필요합니다.', 'Connect to read the asset files before export.'));
        value = await packageSceneAssets(value, snapshot.projectId, assetApi, baseline?.id);
      }
      const name = `${scene.id}.ezscene.json`; const content = JSON.stringify(value, null, 2);
      if (new Blob([content]).size > 8 * 1024 * 1024) throw new Error(copy('자산을 포함한 화면 패키지가 8 MiB를 넘습니다.', 'The scene package with assets exceeds 8 MiB.'));
      if (onExportScene) await onExportScene(name, content);
      else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (reason) { setError(String(reason)); }
    finally { setExporting(false); }
  };
  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file || editBlocked) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error(copy('8 MiB 이하 파일을 선택하세요.', 'Choose a file no larger than 8 MiB.'));
      const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('File could not be read.')); reader.onload = () => resolve(String(reader.result)); reader.readAsText(file); });
      const value = parseScenePackage(JSON.parse(text));
      for (const binary of value.binaries ?? []) await validateSceneAssetBinary(binary, value.assets.find((asset) => asset.id === binary.assetId)!);
      setImported(value); setImportSubmitted(null); setError(null);
    } catch (reason) { setError(String(reason)); }
    finally { if (fileInput.current) fileInput.current.value = ''; }
  };
  const uploadAsset = async (file: File | undefined): Promise<void> => {
    if (!file || !assetApi || saveBlocked) return;
    setAssetBusy(true); setError(null);
    try {
      const binary = await readAssetFile(file);
      const result = await assetApi.executePlanningAsset({type:'stage',projectId:snapshot.projectId,assetId:sceneIdentity('asset'),title:file.name.slice(0,300),...binary});
      if (!result.ok) throw new Error(result.message);
      onPatch([{op:'asset.put',value:result.asset}], copy(`자산 추가: ${result.asset.title}`,`Add asset: ${result.asset.title}`));
    } catch (reason) { setError(String(reason)); }
    finally { setAssetBusy(false); if (assetInput.current) assetInput.current.value = ''; }
  };
  const applyImport = async (): Promise<void> => {
    if (!imported || saveBlocked) return;
    setAssetBusy(true); setError(null);
    try {
      if (imported.binaries?.length && !assetApi) throw new Error(copy('자산을 저장할 연결이 필요합니다.', 'Connect to save the imported asset files.'));
      const value = assetApi ? await stageSceneAssets(imported,snapshot.projectId,assetApi) : imported;
      setImportSubmitted(snapshot.revision);
      onPatch(sceneImportOperations(value,snapshot),'Import scene design'); choose(value.sceneId);
    } catch (reason) { setError(String(reason)); setImportSubmitted(null); }
    finally { setAssetBusy(false); }
  };
  const flattened = useMemo(() => {
    const output: Array<{ element: SceneElement; depth: number }> = []; const seen = new Set<string>();
    const visit = (parentId: string | null, depth: number): void => {
      if (depth >= 64) return;
      for (const element of (scene?.elements ?? []).filter((entry) => entry.parentId === parentId).sort((a, b) => a.order - b.order)) {
        if (seen.has(element.id)) continue; seen.add(element.id); output.push({ element, depth }); visit(element.id, depth + 1);
      }
    }; visit(null, 0); return output;
  }, [scene?.elements]);

  const structure = <section className="scene-designer__structure" aria-label={copy('요소 트리', 'Element tree')}>
    <div className="scene-designer__add"><Field label={copy('추가할 요소', 'Element to add')}><Select value={addKind} disabled={editBlocked} onChange={(event) => setAddKind(event.target.value as SceneElement['kind'])}>{SCENE_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</Select></Field>
      <Button size="sm" disabled={editBlocked || !!owner || !scene} leadingIcon={<Plus />} onClick={add}>{copy('추가', 'Add')}</Button></div>
    <p className="scene-designer__hint">{copy('선택 요소 안에 추가됩니다. 아래에서 최상위를 선택할 수 있습니다.', 'New elements go inside the selection. Choose Screen root for a top-level element.')}</p>
    <Button size="sm" variant="ghost" onClick={() => setElementId(null)} aria-pressed={selection === undefined}>{copy('최상위', 'Screen root')}</Button>
    <div role="tree" aria-label={copy('화면 요소', 'Screen elements')} className="scene-designer__tree" onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement); if (current < 0) return;
      event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      buttons[index]?.focus(); buttons[index]?.click();
    }}>
      {flattened.map(({ element, depth }) => <button type="button" role="treeitem" key={element.id} aria-level={depth + 1} aria-selected={element.id === selection?.id}
        style={{ paddingInlineStart: 12 + depth * 16 }} onClick={() => { setElementId(element.id); if (compact) setPane('properties'); }}>
        <span>{element.kind}</span><strong>{element.properties.accessibleName || element.properties.text?.slice(0, 36) || element.id}</strong>{element.component && <small>{copy('연결', 'Linked')}</small>}
      </button>)}
    </div>
    <div className="scene-designer__add"><Field label={copy('공통 요소 삽입', 'Insert reusable component')}><Select value={componentToInsert} disabled={editBlocked || !!owner} onChange={(event) => setComponentToInsert(event.target.value)}><option value="">{copy('선택', 'Choose')}</option>{base.components.filter((entry) => entry.id !== component?.id).map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · v{entry.revision}</option>)}</Select></Field><Button size="sm" disabled={editBlocked || !!owner || !componentToInsert || !scene} onClick={insertComponent}>{copy('삽입', 'Insert')}</Button></div>
  </section>;

  const properties = scene && <section className="scene-designer__properties" aria-label={copy('속성', 'Properties')}>
    {assetApi && <fieldset><legend>{copy('이미지·글꼴 자산', 'Image and font assets')}</legend><p className="scene-designer__hint">PNG · JPEG · WebP · GIF · WOFF · WOFF2 · {copy('파일당 최대 512 KiB', 'up to 512 KiB per file')}</p><Button size="sm" disabled={saveBlocked} onClick={() => assetInput.current?.click()}>{assetBusy ? copy('자산 준비 중', 'Preparing asset') : copy('자산 파일 추가', 'Add asset file')}</Button><input ref={assetInput} hidden type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.woff,.woff2" onChange={(event) => void uploadAsset(event.target.files?.[0])} /></fieldset>}
    <Field label={copy(mode === 'scenes' ? '화면 이름' : '공통 요소 이름', mode === 'scenes' ? 'Screen name' : 'Component name')}><Input value={scene.title} maxLength={300} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, title: event.target.value })} /></Field>
    {!component && <>
      <Field label={copy('플랫폼', 'Platform')}><Select value={scene.platform} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, platform: event.target.value as ScreenScene['platform'] })}><option value="windows">Windows</option><option value="android">Android</option></Select></Field>
      <div className="scene-designer__pair">{(['width', 'height'] as const).map((key) => <Field key={key} label={key === 'width' ? copy('기준 폭', 'Frame width') : copy('기준 높이', 'Frame height')}><Input type="number" min={240} max={8192} value={scene[key]} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, [key]: Math.max(240, Math.min(8192, Number(event.target.value) || 240)) })} /></Field>)}</div>
      <Field label={copy('검토 상태', 'Review state')}><Select value={scene.status} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, status: event.target.value as ScreenScene['status'] })}><option value="draft">{copy('초안', 'Draft')}</option><option value="review-needed">{copy('재검토 필요', 'Needs review')}</option><option value="ready">{copy('검토 완료', 'Reviewed')}</option></Select></Field>
      <fieldset><legend>{copy('연결된 기능', 'Linked features')}</legend>{base.items.filter((item) => item.kind === 'feature').map((item) => <label key={item.id} className="scene-designer__check"><input type="checkbox" checked={scene.featureIds.includes(item.id)} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, featureIds: event.target.checked ? [...scene.featureIds, item.id] : scene.featureIds.filter((id) => id !== item.id) })} />{item.title}</label>)}</fieldset>
    </>}
    {component && <fieldset><legend>{copy('인스턴스에서 바꿀 수 있는 속성', 'Allowed instance overrides')}</legend>{PROPERTY_KEYS.map((key) => <label key={key} className="scene-designer__check"><input type="checkbox" checked={component.allowedOverrides.includes(key)} disabled={editBlocked} onChange={(event) => onComponentDraftChange({ ...component, allowedOverrides: event.target.checked ? [...component.allowedOverrides, key] : component.allowedOverrides.filter((entry) => entry !== key) })} />{key}</label>)}<p className="scene-designer__hint">{copy('연결된 초안에만 적용됩니다. 기존 예외와 충돌하면 저장이 거절됩니다.', 'Changes affect linked drafts. Conflicting existing overrides cause the entire save to fail.')}</p></fieldset>}
    {selection && <>
      <h3>{copy('선택 요소', 'Selected element')} · {selection.kind}</h3>
      {owner && <div className="scene-designer__notice"><p>{copy('공통 원본 연결', 'Linked source')}: {sourceComponent?.title ?? owner.component?.componentId} · v{owner.component?.version}</p>
        <p>{copy('개별 예외', 'Instance overrides')}: {Object.keys(owner.component?.overrides ?? {}).join(', ') || copy('없음', 'None')}</p>
        {owner.id === selection.id && Object.keys(owner.component?.overrides ?? {}).map((name) => {
          const key = name as keyof SceneElement['properties'];
          return <Button key={key} size="sm" variant="ghost" disabled={editBlocked} onClick={() => {
            if (!selection.component) return;
            const overrides = { ...selection.component.overrides }; delete overrides[key];
            const source = sourceComponent?.elements.find((element) => element.parentId === null);
            updateElement({ properties: { ...selection.properties, [key]: source?.properties[key] }, component: { ...selection.component, overrides } });
          }}>{copy('원본 값 사용', 'Use source value')}: {key}</Button>;
        })}
        <Button size="sm" variant="ghost" disabled={editBlocked} onClick={() => updateScene({ ...scene, elements: scene.elements.map((element) => element.id === owner.id ? { ...element, component: undefined } : element) })}>{copy('원본 연결 해제', 'Detach from source')}</Button></div>}
      <Field label={copy('접근 가능한 이름', 'Accessible name')}><Input value={selection.properties.accessibleName ?? ''} disabled={editBlocked || !allowedProperties.includes('accessibleName')} onChange={(event) => updateProperty('accessibleName', event.target.value)} /></Field>
      <Field label={copy('텍스트 · 목록은 줄바꿈, 표는 |로 구분', 'Text · lines for lists, | for table columns')}><textarea className="scene-designer__textarea" value={selection.properties.text ?? ''} disabled={editBlocked || !allowedProperties.includes('text')} onChange={(event) => updateProperty('text', event.target.value)} rows={3} aria-label={copy('요소 텍스트', 'Element text')} /></Field>
      <Field label={copy('입력 안내', 'Placeholder')}><Input value={selection.properties.placeholder ?? ''} disabled={editBlocked || !allowedProperties.includes('placeholder')} onChange={(event) => updateProperty('placeholder', event.target.value)} /></Field>
      <Field label={copy('표현', 'Variant')}><Select value={selection.properties.variant ?? ''} disabled={editBlocked || !allowedProperties.includes('variant')} onChange={(event) => updateProperty('variant', event.target.value)}><option value="">{copy('기본', 'Default')}</option><option value="primary">Primary</option><option value="secondary">Secondary</option></Select></Field>
      {(['disabled', 'required'] as const).map((key) => <label key={key} className="scene-designer__check"><input type="checkbox" checked={selection.properties[key] === true} disabled={editBlocked || !allowedProperties.includes(key)} onChange={(event) => updateProperty(key, event.target.checked)} />{key === 'disabled' ? copy('비활성', 'Disabled') : copy('필수 입력', 'Required')}</label>)}
      <Field label={copy('프로젝트 자산 참조', 'Project asset reference')}><Select value={selection.properties.assetId ?? ''} disabled={editBlocked || !allowedProperties.includes('assetId')} onChange={(event) => updateProperty('assetId', event.target.value || undefined)}><option value="">{copy('없음', 'None')}</option>{base.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title} · {asset.mimeType}</option>)}</Select></Field>
      {selection.properties.assetId && <p className="scene-designer__hint">{base.assets.find((asset) => asset.id === selection.properties.assetId)?.hash ?? copy('자산 누락', 'Missing asset')}</p>}
      <Field label={copy('부모 요소', 'Parent element')}><Select value={selection.parentId ?? ''} disabled={structuralBlocked} onChange={(event) => updateElement({ parentId: event.target.value || null })}><option value="">{copy('최상위', 'Screen root')}</option>{scene.elements.filter((element) => !descendantIds(scene.elements, selection.id).has(element.id) && !instanceOwner(scene.elements, element.id)).map((element) => <option key={element.id} value={element.id}>{element.properties.accessibleName || element.kind}</option>)}</Select></Field>
      <Field label={copy('배치 방향', 'Layout direction')}><Select value={selection.layout.direction} disabled={structuralBlocked} onChange={(event) => updateElement({ layout: { ...selection.layout, direction: event.target.value as SceneElement['layout']['direction'] } })}><option value="column">Column</option><option value="row">Row</option><option value="grid">Grid</option></Select></Field>
      {(['width', 'height'] as const).map((key) => <div className="scene-designer__pair" key={key}><Field label={key === 'width' ? copy('너비 규칙', 'Width rule') : copy('높이 규칙', 'Height rule')}><Select value={selection.layout[key]} disabled={structuralBlocked} onChange={(event) => updateElement({ layout: { ...selection.layout, [key]: event.target.value, ...(event.target.value === 'fixed' ? { [key === 'width' ? 'fixedWidth' : 'fixedHeight']: key === 'width' ? 240 : 48 } : {}) } })}><option value="fill">Fill</option><option value="hug">Hug</option><option value="fixed">Fixed</option></Select></Field>
        {selection.layout[key] === 'fixed' && <Field label={key === 'width' ? copy('고정 폭', 'Fixed width') : copy('고정 높이', 'Fixed height')}><Input type="number" min={1} max={20000} value={selection.layout[key === 'width' ? 'fixedWidth' : 'fixedHeight'] ?? 48} disabled={structuralBlocked} onChange={(event) => updateElement({ layout: { ...selection.layout, [key === 'width' ? 'fixedWidth' : 'fixedHeight']: boundedNumber(event.target.value, 1, 20000) } })} /></Field>}</div>)}
      <div className="scene-designer__pair">{(['gap', 'padding', 'minWidth', 'maxWidth'] as const).map((key) => <Field key={key} label={key}><Input type="number" min={key === 'maxWidth' ? 1 : 0} max={key === 'gap' || key === 'padding' ? 1000 : 20000} value={selection.layout[key] ?? ''} disabled={structuralBlocked} onChange={(event) => updateElement({ layout: { ...selection.layout, [key]: event.target.value === '' && (key === 'minWidth' || key === 'maxWidth') ? undefined : boundedNumber(event.target.value, key === 'maxWidth' ? 1 : 0, key === 'gap' || key === 'padding' ? 1000 : 20000) } })} /></Field>)}</div>
      <Field label={copy('넘침 처리', 'Overflow')}><Select value={selection.layout.overflow} disabled={structuralBlocked} onChange={(event) => updateElement({ layout: { ...selection.layout, overflow: event.target.value as SceneElement['layout']['overflow'] } })}><option value="visible">Visible</option><option value="scroll">Scroll</option><option value="hidden">Hidden</option></Select></Field>
      {!component && <fieldset><legend>{copy('표시할 상태 · 미선택 시 모든 상태', 'Visible states · none means all')}</legend>{scene.states.map((state) => <label className="scene-designer__check" key={state.id}><input type="checkbox" checked={selection.stateIds.includes(state.id)} disabled={structuralBlocked} onChange={(event) => updateElement({ stateIds: event.target.checked ? [...selection.stateIds, state.id] : selection.stateIds.filter((id) => id !== state.id) })} />{state.title}</label>)}</fieldset>}
      <div className="scene-designer__actions"><Button size="sm" variant="ghost" disabled={structuralBlocked} leadingIcon={<ArrowUp />} onClick={() => updateScene({ ...scene, elements: moveElement(scene.elements, selection.id, -1) })}>{copy('위로', 'Move up')}</Button><Button size="sm" variant="ghost" disabled={structuralBlocked} leadingIcon={<ArrowDown />} onClick={() => updateScene({ ...scene, elements: moveElement(scene.elements, selection.id, 1) })}>{copy('아래로', 'Move down')}</Button>
        <Button size="sm" variant="danger" disabled={editBlocked || (!!owner && owner.id !== selection.id)} leadingIcon={<Trash2 />} onClick={() => { updateScene(deleteSceneElement(scene, selection.id)); setElementId(null); }}>{copy('하위 요소와 함께 제거', 'Remove with children')}</Button></div>
    </>}
    {!component && <details><summary>{copy('상태와 화면 이동', 'States and transitions')}</summary>
      {scene.states.map((state) => <div key={state.id} className="scene-designer__state"><Field label={copy('상태 이름', 'State name')}><Input value={state.title} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, states: scene.states.map((entry) => entry.id === state.id ? { ...entry, title: event.target.value } : entry) })} /></Field>
        <Field label={copy('상태 종류', 'State kind')}><Select value={state.kind} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, states: scene.states.map((entry) => entry.id === state.id ? { ...entry, kind: event.target.value as typeof state.kind } : entry) })}>{STATE_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</Select></Field>
        <Button size="sm" variant="ghost" disabled={editBlocked || scene.states.length === 1} onClick={() => updateScene({ ...scene, states: scene.states.filter((entry) => entry.id !== state.id), elements: scene.elements.map((element) => ({ ...element, stateIds: element.stateIds.filter((id) => id !== state.id) })), transitions: scene.transitions.filter((entry) => entry.fromStateId !== state.id && entry.toStateId !== state.id) })}>{copy('상태 제거', 'Remove state')}</Button></div>)}
      <Button size="sm" variant="secondary" disabled={editBlocked} onClick={() => updateScene({ ...scene, states: [...scene.states, { id: sceneIdentity('state'), title: copy('새 상태', 'New state'), kind: 'default' }] })}>{copy('상태 추가', 'Add state')}</Button>
      {scene.transitions.map((transition) => <fieldset key={transition.id} className="scene-designer__transition"><legend>{copy('상태 이동', 'Transition')}</legend>
        <Field label={copy('동작 요소', 'Trigger element')}><Select value={transition.elementId} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, transitions: scene.transitions.map((entry) => entry.id === transition.id ? { ...entry, elementId: event.target.value } : entry) })}>{scene.elements.map((element) => <option key={element.id} value={element.id}>{element.properties.accessibleName || element.kind}</option>)}</Select></Field>
        <Field label={copy('시작 상태', 'From state')}><Select value={transition.fromStateId} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, transitions: scene.transitions.map((entry) => entry.id === transition.id ? { ...entry, fromStateId: event.target.value } : entry) })}>{scene.states.map((state) => <option key={state.id} value={state.id}>{state.title}</option>)}</Select></Field>
        <Field label={copy('동작', 'Trigger')}><Select value={transition.trigger} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, transitions: scene.transitions.map((entry) => entry.id === transition.id ? { ...entry, trigger: event.target.value as typeof transition.trigger } : entry) })}>{['activate', 'submit', 'back', 'load', 'error'].map((trigger) => <option key={trigger}>{trigger}</option>)}</Select></Field>
        <Field label={copy('대상 화면', 'Target screen')}><Select value={transition.toSceneId ?? ''} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, transitions: scene.transitions.map((entry) => entry.id === transition.id ? { ...entry, toSceneId: event.target.value || undefined, toStateId: undefined } : entry) })}><option value="">{copy('현재 화면', 'This screen')}</option>{scenes.map((target) => <option key={target.id} value={target.id}>{target.title || target.id}</option>)}</Select></Field>
        <Field label={copy('대상 상태', 'Target state')}><Select value={transition.toStateId ?? ''} disabled={editBlocked} onChange={(event) => updateScene({ ...scene, transitions: scene.transitions.map((entry) => entry.id === transition.id ? { ...entry, toStateId: event.target.value || undefined } : entry) })}><option value="">{copy('화면 기본 상태', 'Screen default')}</option>{(transition.toSceneId ? scenes.find((target) => target.id === transition.toSceneId)?.states ?? [] : scene.states).map((state) => <option key={state.id} value={state.id}>{state.title}</option>)}</Select></Field>
        <Button size="sm" variant="ghost" disabled={editBlocked} onClick={() => updateScene({ ...scene, transitions: scene.transitions.filter((entry) => entry.id !== transition.id) })}>{copy('이동 제거', 'Remove transition')}</Button>
      </fieldset>)}
      <Button size="sm" variant="secondary" disabled={editBlocked || !scene.elements.length || !scene.states.length} onClick={() => updateScene({ ...scene, transitions: [...scene.transitions, { id: sceneIdentity('transition'), elementId: selection?.id ?? scene.elements[0]!.id, fromStateId: scene.states[0]!.id, trigger: 'activate', toStateId: scene.states[0]!.id }] })}>{copy('이동 추가', 'Add transition')}</Button>
    </details>}
  </section>;

  const navigate = (target: { sceneId?: string; stateId?: string }): void => {
    if (target.sceneId) setSelectedId(target.sceneId);
    if (target.stateId) setStateId(target.stateId);
    else if (target.sceneId) setStateId(scenes.find((entry) => entry.id === target.sceneId)?.states[0]?.id ?? 'default');
  };
  const preview = scene && <section className="scene-designer__canvas">
    <div className="scene-designer__preview-toolbar"><Field label={copy('미리보기 폭', 'Preview width')}><Input type="number" min={240} max={8192} value={previewWidth} onChange={(event) => setViewportWidth(Math.max(240, Math.min(8192, Number(event.target.value) || 240)))} /></Field>
      <Field label={copy('미리보기 상태', 'Preview state')}><Select value={activeState?.id ?? ''} onChange={(event) => setStateId(event.target.value)}>{scene.states.map((state) => <option key={state.id} value={state.id}>{state.title} · {state.kind}</option>)}</Select></Field>
      <Button size="sm" variant={prototype ? 'primary' : 'secondary'} aria-pressed={prototype} onClick={() => setPrototype(!prototype)}>{prototype ? copy('편집으로', 'Edit view') : copy('프로토타입 체험', 'Try prototype')}</Button>
      {prototype && <Button size="sm" variant="ghost" onClick={() => { setStateId(scene.states[0]?.id ?? 'default'); setViewportWidth(null); }}>{copy('처음으로', 'Reset')}</Button>}
      {prototype && scene.transitions.filter((transition) => transition.fromStateId === activeState?.id && ['back', 'load', 'error'].includes(transition.trigger)).map((transition) => <Button size="sm" variant="ghost" key={transition.id}
        onClick={() => navigate({ sceneId: transition.toSceneId, stateId: transition.toStateId })}>{copy('체험', 'Simulate')}: {transition.trigger} · {scene.elements.find((element) => element.id === transition.elementId)?.properties.accessibleName || transition.elementId}</Button>)}
    </div>
    {loadedAssets.errors.length > 0 && <p className="scene-designer__error" role="alert">{loadedAssets.errors.join('\n')}</p>}
    <ScenePreview scene={scene} stateId={activeState?.id ?? 'default'} width={previewWidth} prototype={prototype} selectedElementId={selection?.id} assets={base.assets} assetData={loadedAssets.data} korean={korean}
      onSelectElement={(id) => { setElementId(id); if (compact) setPane('properties'); }}
      onTransition={navigate} />
  </section>;

  const versionControl = <Field label={copy('설계 버전', 'Design version')}><Select value={baseline ? baseline.id : baselineGone ? baselineId : 'draft'} onChange={(event) => { setBaselineId(event.target.value); choose(''); }}>{baselineGone && <option value={baselineId} disabled>{copy('정리된 실행 기준본', 'Cleaned-up run baseline')}</option>}<option value="draft">{copy('현재 초안', 'Current draft')}</option>{snapshot.baselines.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {copy('확정본', 'Frozen')}</option>)}</Select></Field>;
  const collectionControl = <Field label={copy('편집 대상', 'Edit collection')}><Select value={mode} onChange={(event) => { setMode(event.target.value as typeof mode); choose(''); }}><option value="scenes">{copy('화면', 'Screens')}</option><option value="components">{copy('공통 요소', 'Reusable components')}</option></Select></Field>;
  const chooseControl = <Field label={mode === 'scenes' ? copy('화면 선택', 'Choose screen') : copy('공통 요소 선택', 'Choose component')}><Select value={entity?.id ?? ''} onChange={(event) => choose(event.target.value)}>{!entity && <option value="">{copy('없음', 'None')}</option>}{(mode === 'scenes' ? scenes : components).map((value) => <option key={value.id} value={value.id}>{value.title || copy('이름 없는 초안', 'Untitled draft')}</option>)}</Select></Field>;
  const saveControl = <Button size="sm" disabled={saveBlocked || !entity} leadingIcon={<Save />} onClick={save}>{copy('저장', 'Save')}</Button>;
  const secondaryControls = <><Button size="sm" variant="secondary" disabled={editBlocked} leadingIcon={<Plus />} onClick={create}>{copy('새로 만들기', 'New')}</Button><Button size="sm" variant="ghost" disabled={!scene || !!component || exporting || baselineGone} leadingIcon={<Download />} onClick={() => void exportFile()}>{copy('내보내기', 'Export')}</Button><Button size="sm" variant="ghost" disabled={editBlocked} leadingIcon={<Upload />} onClick={() => fileInput.current?.click()}>{copy('가져오기', 'Import')}</Button></>;

  return <section ref={container} className="scene-designer" data-mobile={mobile || undefined} data-compact={compact || undefined} data-testid="scene-designer">
    <header className="scene-designer__toolbar">
      {compact ? <><div className="scene-designer__primary">{chooseControl}{saveControl}</div><details className="scene-designer__settings"><summary>{copy('설계 도구', 'Design tools')} · {baseline ? copy('확정본', 'Frozen') : copy('초안', 'Draft')}</summary><div className="scene-designer__settings-content">{versionControl}{collectionControl}<div className="scene-designer__actions">{secondaryControls}</div></div></details></> : <>{versionControl}{collectionControl}{chooseControl}<div className="scene-designer__actions">{saveControl}{secondaryControls}</div></>}
      <input ref={fileInput} hidden type="file" accept=".json,.ezscene" onChange={(event) => void importFile(event.target.files?.[0])} />
    </header>
    {baseline && <p className="scene-designer__notice">{copy('확정본은 읽기 전용입니다. 수정하려면 기획에서 이 확정본으로 새 초안을 만드세요.', 'This frozen baseline is read-only. Branch it from Planning before editing.')}</p>}
    {error && <p className="scene-designer__error" role="alert">{error}</p>}
    {imported && <div className="scene-designer__notice"><p>{copy('가져올 화면', 'Imported screens')}: {imported.scenes.length} · {copy('공통 요소', 'Components')}: {imported.components.length} · {copy('자산 참조', 'Asset references')}: {imported.assets.length} · {copy('포함한 자산 파일', 'Included asset files')}: {imported.binaries?.length ?? 0}</p><p>{copy('같은 ID의 현재 초안 항목은 교체됩니다. 확정본은 보존됩니다.', 'Current draft entries with the same IDs will be replaced. Frozen baselines are preserved.')}</p>{imported.assets.length > (imported.binaries?.length ?? 0) && <p>{copy('이전 형식의 자산 참조가 있습니다. 포함되지 않은 파일은 이 PC에 같은 자산이 있어야 표시됩니다.', 'This package contains legacy asset references. Files not included require the matching asset on this PC.')}</p>}
      <details><summary>{copy('가져올 화면 미리보기', 'Preview imported screen')}</summary><ScenePreview scene={imported.scenes.find((entry) => entry.id === imported.sceneId)!} stateId={imported.scenes.find((entry) => entry.id === imported.sceneId)!.states[0]?.id ?? 'default'} width={compact ? Math.max(240,availableWidth - 64) : 640} assets={imported.assets} assetData={Object.fromEntries((imported.binaries ?? []).map((entry) => [entry.assetId,entry]))} korean={korean} /></details>
      {importSubmitted !== null && <p role="status">{copy('가져오기 저장 결과를 확인하는 중입니다.', 'Waiting for the import save result.')}</p>}
      <div className="scene-designer__actions"><Button size="sm" disabled={saveBlocked} onClick={() => void applyImport()}>{copy('검토한 설계 가져오기', 'Apply reviewed import')}</Button><Button size="sm" variant="ghost" disabled={assetBusy || disabled} onClick={() => { setImported(null); setImportSubmitted(null); }}>{copy('닫기', 'Close')}</Button></div></div>}
    {baselineGone ? <p className="scene-designer__notice" role="status" data-testid="scene-designer-baseline-gone">{copy('이 실행 기준본은 정리되었습니다. 설계 버전에서 현재 초안이나 다른 확정본을 고르세요.', 'This run baseline was cleaned up. Choose the current draft or another frozen baseline under Design version.')}</p>
    : !scene ? <div className="scene-designer__empty"><h3>{copy('화면 설계를 시작하세요', 'Start a screen design')}</h3><p>{copy('화면과 요소를 만든 뒤 실제 크기와 상태 전환을 확인할 수 있습니다.', 'Create a screen and elements, then try its layout and state transitions.')}</p><Button disabled={editBlocked} onClick={create}>{copy('첫 화면 만들기', 'Create first screen')}</Button></div> : compact ? <Tabs className="scene-designer__body" value={pane} onValueChange={setPane}>
      <TabList label={copy('설계 패널', 'Design panels')} className="scene-designer__mobile-tabs"><Tab value="structure">{copy('구조', 'Structure')}</Tab><Tab value="preview">{copy('미리보기', 'Preview')}</Tab><Tab value="properties">{copy('속성', 'Properties')}</Tab></TabList>
      <TabPanel value="structure">{structure}</TabPanel><TabPanel value="preview">{preview}</TabPanel><TabPanel value="properties">{properties}</TabPanel>
    </Tabs> : <div className="scene-designer__columns">{structure}{preview}{properties}</div>}
    {ai && entity && !baseline && !baselineGone && <details className="scene-designer__ai"><summary>{selection ? copy('선택한 요소를 AI로 다듬기', 'Refine selected element with AI') : copy('화면을 AI로 다듬기', 'Refine design with AI')}</summary><PlanningAiPanel {...ai} snapshot={snapshot}
      target={{ kind: component ? 'component' : 'scene', id: entity.id, revision: entity.revision, ...(selection ? { elementIds: [selection.id] } : {}) }}
      disabled={saveBlocked || !!(component ? componentDrafts[entity.id]?.dirty : sceneDrafts[entity.id]?.dirty)}
      disabledReason={componentDrafts[entity.id]?.dirty || sceneDrafts[entity.id]?.dirty ? copy('현재 초안을 먼저 저장한 뒤 AI 제안을 요청하세요.', 'Save the current draft before requesting an AI proposal.') : undefined} /></details>}
  </section>;
}
