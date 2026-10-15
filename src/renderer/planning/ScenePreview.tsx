import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import type { PlanningAsset, SceneElement, ScreenScene } from '../../shared/planning';
import { Button, Input } from '../ui';
import './scene-designer.css';
import type { SceneAssetData } from './scene-assets';

export interface ScenePreviewProps {
  readonly scene: ScreenScene;
  readonly stateId: string;
  readonly width: number;
  readonly prototype?: boolean;
  readonly selectedElementId?: string | null;
  readonly assets: readonly PlanningAsset[];
  readonly assetData?: SceneAssetData;
  readonly onSelectElement?: (id: string) => void;
  readonly onTransition?: (target: { sceneId?: string; stateId?: string }) => void;
  readonly korean?: boolean;
}

function sceneStyle(element: SceneElement): CSSProperties {
  const { layout } = element;
  return {
    display: layout.direction === 'grid' ? 'grid' : 'flex', flexDirection: layout.direction === 'row' ? 'row' : 'column',
    ...(layout.direction === 'grid' ? { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))' } : {}),
    width: layout.width === 'fixed' ? layout.fixedWidth : layout.width === 'fill' ? '100%' : 'fit-content',
    height: layout.height === 'fixed' ? layout.fixedHeight : layout.height === 'fill' ? '100%' : 'auto',
    minWidth: layout.minWidth ?? 0, maxWidth: layout.maxWidth, gap: layout.gap, padding: layout.padding,
    overflow: layout.overflow === 'scroll' ? 'auto' : layout.overflow, boxSizing: 'border-box',
  };
}

function PreviewInput({ element, disabled, prototype, activate }: {
  readonly element: SceneElement; readonly disabled: boolean; readonly prototype: boolean; readonly activate: (trigger: 'activate' | 'submit') => void;
}): JSX.Element {
  const id = useId();
  const [value, setValue] = useState('');
  return <label htmlFor={id} className="scene-preview__input">
    <span>{element.properties.accessibleName || element.properties.text || 'Input'}</span>
    <Input id={id} value={value} placeholder={element.properties.placeholder} required={element.properties.required}
      disabled={disabled} readOnly={!prototype} onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => { if (prototype && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (event.currentTarget.checkValidity()) activate('submit'); else event.currentTarget.reportValidity(); } }} />
  </label>;
}
function PreviewTabs({ element, disabled, prototype, children, activate }: {
  readonly element: SceneElement; readonly disabled: boolean; readonly prototype: boolean; readonly children: ReactNode; readonly activate: () => void;
}): JSX.Element {
  const id = useId(); const [selected, setSelected] = useState(0);
  const titles = (element.properties.text || 'First|Second').split('|').slice(0, 12);
  return <div><div role="tablist" aria-label={element.properties.accessibleName || 'Preview tabs'}>
    {titles.map((title, index) => <button key={index} type="button" role="tab" id={`${id}-${index}`} aria-selected={selected === index} aria-controls={`${id}-panel`}
      disabled={disabled} tabIndex={selected === index ? 0 : -1}
      onClick={() => { if (prototype) { setSelected(index); activate(); } }}
      onKeyDown={(event) => { if (!prototype || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? titles.length - 1 : (selected + (event.key === 'ArrowRight' ? 1 : -1) + titles.length) % titles.length;
        setSelected(next); document.getElementById(`${id}-${next}`)?.focus(); }}>
      {title}
    </button>)}
  </div><div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${selected}`}>{children}</div></div>;
}

/** Native semantic preview: project text never becomes executable HTML or CSS. */
export function ScenePreview({ scene, stateId, width, prototype = false, selectedElementId, assets, assetData, onSelectElement, onTransition, korean = false }: ScenePreviewProps): JSX.Element {
  const [failedFonts, setFailedFonts] = useState<readonly string[]>([]);
  useEffect(() => {
    if (typeof FontFace === 'undefined' || !document.fonts) return;
    setFailedFonts([]);
    let active = true; const loaded: FontFace[] = [];
    for (const binary of Object.values(assetData ?? {})) {
      if (!binary.mimeType.startsWith('font/')) continue;
      const fontBytes = Uint8Array.from(atob(binary.dataBase64), (character) => character.charCodeAt(0));
      const font = new FontFace(`EZSceneAsset_${binary.hash}`, fontBytes);
      void font.load().then(() => { if (active) { document.fonts.add(font); loaded.push(font); } }).catch(() => { if (active) setFailedFonts((current)=>[...current,binary.assetId]); });
    }
    return () => { active = false; loaded.forEach((font)=>document.fonts.delete(font)); };
  }, [assetData]);
  const state = scene.states.find((entry) => entry.id === stateId);
  const activate = (elementId: string, trigger: ScreenScene['transitions'][number]['trigger']): void => {
    if (!prototype) return;
    const transition = scene.transitions.find((entry) => entry.elementId === elementId && entry.fromStateId === stateId && entry.trigger === trigger);
    if (transition) onTransition?.({ ...(transition.toSceneId ? { sceneId: transition.toSceneId } : {}), ...(transition.toStateId ? { stateId: transition.toStateId } : {}) });
  };
  const render = (element: SceneElement, ancestry: ReadonlySet<string>): ReactNode => {
    if (ancestry.has(element.id) || ancestry.size >= 64 || (element.stateIds.length > 0 && !element.stateIds.includes(stateId))) return null;
    const path = new Set([...ancestry, element.id]);
    const children = scene.elements.filter((child) => child.parentId === element.id).sort((a, b) => a.order - b.order).map((child) => render(child, path));
    const disabled = element.properties.disabled === true || state?.kind === 'disabled';
    const text = element.properties.text ?? '';
    let content: ReactNode;
    switch (element.kind) {
      case 'frame': content = <>{text && <p>{text}</p>}{children}</>; break;
      case 'dialog': content = <section role="region" aria-label={element.properties.accessibleName || text || 'Dialog preview'} className="scene-preview__dialog"><strong>{text}</strong>{children}</section>; break;
      case 'text': content = <><p>{text || (korean ? '텍스트' : 'Text')}</p>{children}</>; break;
      case 'input': content = <><PreviewInput key={`${element.id}:${stateId}`} element={element} disabled={disabled} prototype={prototype} activate={(trigger) => activate(element.id, trigger)} />{children}</>; break;
      case 'button': content = <><Button variant={element.properties.variant === 'primary' ? 'primary' : 'secondary'} disabled={disabled} aria-label={element.properties.accessibleName || undefined}
        onClick={() => activate(element.id, 'activate')}>{text || (korean ? '버튼' : 'Button')}</Button>{children}</>; break;
      case 'list': content = <><ul>{text.split('\n').filter(Boolean).map((line, index) => <li key={index}>{line}</li>)}</ul>{children}</>; break;
      case 'table': { const rows = text.split('\n').filter(Boolean).map((row) => row.split('|'));
        content = <><table><caption>{element.properties.accessibleName || (korean ? '미리보기 표' : 'Preview table')}</caption><thead><tr>{rows[0]?.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>{children}</>; break; }
      case 'tabs': content = <PreviewTabs element={element} disabled={disabled} prototype={prototype} activate={() => activate(element.id, 'activate')}>{children}</PreviewTabs>; break;
    }
    const asset = element.properties.assetId ? assets.find((entry) => entry.id === element.properties.assetId) : undefined;
    const binary = asset && assetData?.[asset.id]?.hash === asset.hash ? assetData[asset.id] : undefined;
    const isFont = binary?.mimeType.startsWith('font/');
    return <div key={element.id} data-scene-element={element.id} data-kind={element.kind} data-selected={selectedElementId === element.id || undefined} data-asset-font={isFont || undefined}
      className="scene-preview__element" style={{...sceneStyle(element), ...(isFont && binary ? {'--scene-asset-font': `EZSceneAsset_${binary.hash}`} : {})} as CSSProperties}>
      {binary?.mimeType.startsWith('image/') && <img className="scene-preview__image" src={`data:${binary.mimeType};base64,${binary.dataBase64}`} alt={element.properties.accessibleName || asset?.title || ''} />}
      {content}
      {asset && failedFonts.includes(asset.id) && <span role="alert" className="scene-preview__asset">{korean ? '글꼴 파일을 표시할 수 없습니다.' : 'The font file could not be displayed.'}</span>}
      {element.properties.assetId && !binary && <span className="scene-preview__asset" role="note">{asset ? `${asset.title} · ${asset.mimeType}` : korean ? '자산을 찾을 수 없음' : 'Asset missing'}<small>{korean ? '자산 파일을 불러오지 못했습니다.' : 'Asset file could not be loaded.'}</small></span>}
    </div>;
  };
  return <div className="scene-preview__viewport" data-testid="scene-preview-viewport">
    <div className="scene-preview" data-prototype={prototype || undefined} style={{ width, minHeight: scene.height }} aria-label={scene.title || (korean ? '화면 미리보기' : 'Scene preview')} aria-busy={state?.kind === 'loading'}
      onPointerDown={(event) => { if (prototype) return; const target = event.target as HTMLElement; const id = target.closest<HTMLElement>('[data-scene-element]')?.dataset.sceneElement; if (id) onSelectElement?.(id); }}>
      {scene.elements.filter((element) => element.parentId === null).sort((a, b) => a.order - b.order).map((element) => render(element, new Set()))}
      {scene.elements.length === 0 && <p className="scene-preview__empty">{korean ? '요소를 추가해 화면을 구성하세요.' : 'Add an element to start this screen.'}</p>}
    </div>
  </div>;
}
