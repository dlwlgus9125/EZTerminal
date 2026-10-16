import { useEffect, useState } from 'react';
import { Maximize2, Plus, X } from 'lucide-react';
import { useAppTranslation } from '../i18n';
import type { WorkbenchViewsController } from '../workbench-views';

export function WorkbenchViewsBar({ controller }: { controller: WorkbenchViewsController }): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = i18n.language.startsWith('ko');
  const [, update] = useState(0);
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState('');
  useEffect(() => controller.subscribe(() => update(value => value + 1)), [controller]);
  const name = (title: string): string => title || (ko ? '기본 작업 공간' : 'Main workspace');
  return <div className="workbench-views" data-testid="workbench-views">
    <div role="tablist" aria-label={ko ? '작업 공간' : 'Workspaces'} className="workbench-views__tabs">
      {controller.views.map(view => <div className="workbench-views__tab" key={view.id} data-active={view.id === controller.activeId}>
        {editing === view.id ? <input autoFocus aria-label={ko ? '작업 공간 이름' : 'Workspace name'} maxLength={80} value={title}
          onChange={event => setTitle(event.currentTarget.value)} onBlur={() => { controller.rename(view.id, title); setEditing(undefined); }}
          onKeyDown={event => { if (event.key === 'Enter') { controller.rename(view.id, title); setEditing(undefined); } if (event.key === 'Escape') setEditing(undefined); }} />
          : <button type="button" role="tab" tabIndex={view.id === controller.activeId ? 0 : -1} aria-selected={view.id === controller.activeId} onClick={() => controller.activate(view.id)}
            onDoubleClick={() => { setEditing(view.id); setTitle(name(view.title)); }} onKeyDown={event => {
              if (event.key === 'F2') { event.preventDefault(); setEditing(view.id); setTitle(name(view.title)); }
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); const index = controller.views.indexOf(view);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? controller.views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + controller.views.length) % controller.views.length;
                controller.activate(controller.views[next].id);
                event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
              }
            }}>{name(view.title)}</button>}
        {controller.views.length > 1 && <button type="button" aria-label={`${ko ? '작업 공간 닫기' : 'Close workspace'}: ${name(view.title)}`} title={ko ? '세션을 기본 작업 공간으로 옮깁니다' : 'Move sessions to the main workspace'} onClick={() => controller.close(view.id)}><X aria-hidden="true" /></button>}
      </div>)}
    </div>
    <button type="button" aria-label={ko ? '새 작업 공간' : 'New workspace'} onClick={() => controller.create(ko ? `작업 공간 ${controller.views.length + 1}` : `Workspace ${controller.views.length + 1}`)}><Plus aria-hidden="true" /></button>
    {controller.views.length > 1 && controller.panels.some(panel => panel.id === controller.api.activePanel?.id) && <select aria-label={ko ? '현재 탭을 작업 공간으로 이동' : 'Move current tab to workspace'} value="" onChange={event => {
      if (controller.api.activePanel && event.currentTarget.value) controller.move(controller.api.activePanel.id, event.currentTarget.value);
    }}><option value="">{ko ? '탭 이동' : 'Move tab'}</option>{controller.views.filter(view => view.id !== controller.activeId).map(view => <option key={view.id} value={view.id}>{name(view.title)}</option>)}</select>}
    {controller.panels.length > 1 && <>
      <select aria-label={ko ? '입력할 영역' : 'Input target'} value={controller.api.activePanel?.id ?? ''} onChange={event => controller.api.getPanel(event.currentTarget.value)?.api.setActive()}>
        {controller.panels.map(panel => <option key={panel.id} value={panel.id}>{panel.title}</option>)}
      </select>
      <button type="button" aria-pressed={controller.isFocused} aria-label={ko ? '집중 보기' : 'Focus pane'} onClick={() => controller.toggleFocus()}><Maximize2 aria-hidden="true" /></button>
    </>}
  </div>;
}
