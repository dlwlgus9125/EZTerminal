import { useEffect, useRef, type ReactNode } from 'react';

import { Glyph, Led, type LedTone } from '../ui';
import { SHELL_TOP_BAR_ID } from '../workbench/SidebarShell';
import type { ShellMode, ProjectTabCandidate } from './navigation-store';
import { useShellText } from './shell-text';

export interface ShellTopBarProps {
  readonly mode: ShellMode;
  /** Shown as the wordmark's tooltip (the version moved out of the bar). */
  readonly appVersion?: string | null;
  /** The tabs to show (already limited, see projectTabs). */
  readonly projects: readonly ProjectTabCandidate[];
  readonly selectedProjectId: string | null;
  readonly waitingByProject: Readonly<Record<string, number>>;
  /** Projects with a conversation stopped on an error: a red lamp on the tab. */
  readonly stoppedProjects: ReadonlySet<string>;
  readonly waitingTotal: number;
  readonly host: { readonly label: string; readonly tone: LedTone };
  readonly updateAvailable?: boolean;
  readonly settingsActive?: boolean;
  readonly onSelectProject: (projectId: string) => void;
  readonly onAddProject: () => void;
  readonly onWaits: () => void;
  readonly onFind: () => void;
  readonly onHost: () => void;
  readonly onSettings: () => void;
  /** Work mode: the one place for work sets, saved layouts and splits. */
  readonly layoutMenu?: ReactNode;
  readonly windowControls?: ReactNode;
}

/** One bar: wordmark, project tabs, what waits, find, the PC, settings. */
export function ShellTopBar(props: ShellTopBarProps): JSX.Element {
  const { text } = useShellText();
  const board = props.mode === 'board';
  // The tab list scrolls sideways when narrow; the selected project is always brought into view.
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return undefined;
    const reveal = (): void => tabs.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    // Narrowing the window can push the selected tab out of the strip: bring it back.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null;
    observer?.observe(tabs);
    return () => observer?.disconnect();
  }, [props.selectedProjectId, props.projects.length]);
  return (
    <header id={SHELL_TOP_BAR_ID} className="ez-shell-top" data-testid="workbench-header">
      <h1 className="ez-shell-mark" title={props.appVersion ? `EZTerminal ${props.appVersion}` : undefined} data-testid="workbench-brand-mark"><i aria-hidden="true" />EZTerminal</h1>
      <nav ref={tabsRef} className="ez-shell-projects" aria-label={text('프로젝트', 'Projects')}>
        {props.projects.map((project) => {
          const current = project.projectId === props.selectedProjectId;
          const waiting = props.waitingByProject[project.projectId] ?? 0;
          const stopped = props.stoppedProjects.has(project.projectId);
          return (
            <button key={project.projectId} type="button" className="ez-shell-ptab" aria-current={current ? 'page' : undefined}
              onClick={() => props.onSelectProject(project.projectId)} data-testid="shell-project-tab" data-project={project.projectId} title={project.name}>
              {current && <Glyph name="proj" size={16} />}
              <span>{project.name}</span>
              {waiting > 0 && <span className="ez-shell-count" aria-label={text(`기다리는 것 ${waiting}`, `${waiting} waiting`)}>{waiting}</span>}
              {stopped && <><Led tone="red" /><span className="ez-ui-visually-hidden">{text('멈춤', 'stopped')}</span></>}
            </button>
          );
        })}
      </nav>
      {/* Outside the tab list so it never scrolls away with the tabs. */}
      <button type="button" className="ez-shell-ptab ez-shell-ptab--add" aria-label={text('프로젝트 추가', 'Add project')} aria-haspopup="dialog"
        title={text('프로젝트 추가', 'Add project')} onClick={props.onAddProject} data-testid="shell-add-project">+</button>
      <div className="ez-shell-top__right">
        {!board && props.waitingTotal > 0 && (
          <button type="button" className="ez-shell-waits" onClick={props.onWaits} data-testid="shell-top-waits">
            <Glyph name="req" size={16} />{text(`기다리는 것 ${props.waitingTotal}`, `${props.waitingTotal} waiting`)}
          </button>
        )}
        <button type="button" className="ez-shell-find" data-compact={!board || undefined} aria-label={text('무엇이든 찾기 (Ctrl K)', 'Find anything (Ctrl K)')}
          onClick={props.onFind} data-testid="btn-command-center">
          <Glyph name="search" size={15} />{board ? text('무엇이든 찾기', 'Find anything') : text('찾기', 'Find')}<kbd>Ctrl K</kbd>
        </button>
        {props.layoutMenu}
        <button type="button" className="ez-shell-host" onClick={props.onHost} title={props.host.label} data-testid="shell-host">
          <Led tone={props.host.tone} />{board ? props.host.label : <span className="ez-ui-visually-hidden">{props.host.label}</span>}
        </button>
        <button type="button" className="ez-shell-iconbtn" aria-label={text('설정', 'Settings')} aria-pressed={props.settingsActive || undefined}
          onClick={props.onSettings} data-testid="btn-toggle-settings">
          <Glyph name="set" />
          {props.updateAvailable && <span className="ez-shell-dot" data-testid="settings-update-badge"><span className="ez-ui-visually-hidden">{text('업데이트 있음', 'Update available')}</span></span>}
        </button>
        {props.windowControls}
      </div>
    </header>
  );
}
