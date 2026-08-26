import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCode2,
  Focus,
  GitCommitHorizontal,
  LocateFixed,
  Map,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

import type {
  AgentHistoryProvider,
  AgentLaunchBootstrap,
  AgentProjectLauncherSummary,
} from '../shared/agent-history';
import { isSafeAgentPromptText } from '../shared/agent-coordination';
import {
  PROJECT_MAP_TYPES,
  projectMapJobPrompt,
  type ProjectMapCollectionDescriptor,
  type ProjectMapCollectionRequest,
  type ProjectMapDocument,
  type ProjectMapEvidence,
  type ProjectMapJob,
  type ProjectMapJobPhase,
  type ProjectMapRootBinding,
  type ProjectMapSnapshot,
  type ProjectMapType,
} from '../shared/project-map';
import type {
  ProjectSessionPanelMetadata,
  ProjectWorkspaceDescriptor,
} from '../shared/project-workspace';
import { useAppTranslation } from './i18n';
import { useDockPanelHost } from './use-dock-panel-host';

interface ProjectMapPanelParams extends ProjectMapCollectionRequest {
  readonly mapId?: string;
}

export interface ProjectMapEvidenceTarget {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly line: number;
}

export interface ProjectMapPanelProps extends IDockviewPanelProps {
  readonly onOpenEvidence?: (target: ProjectMapEvidenceTarget) => void;
  readonly onLaunchAgent?: (
    bootstrap: AgentLaunchBootstrap,
    projectSession: ProjectSessionPanelMetadata,
  ) => boolean | void;
}

function isParams(value: unknown): value is ProjectMapPanelParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const params = value as Record<string, unknown>;
  return typeof params.projectId === 'string'
    && params.projectId.length > 0
    && typeof params.ownerRootId === 'string'
    && params.ownerRootId.length > 0
    && typeof params.ownerWorkspaceId === 'string'
    && params.ownerWorkspaceId.length > 0
    && (params.mapId === undefined || typeof params.mapId === 'string');
}

function bindingValue(rootId: string, workspaceId: string): string {
  return `${rootId}\u0000${workspaceId}`;
}

function splitBindingValue(value: string): { readonly rootId: string; readonly workspaceId: string } | undefined {
  const separator = value.indexOf('\u0000');
  if (separator < 1 || separator === value.length - 1) return undefined;
  return { rootId: value.slice(0, separator), workspaceId: value.slice(separator + 1) };
}

function projectMapCreationBrief(type: ProjectMapType): string {
  return [
    'Create the initial EZTerminal-native Project Map collection for this repository.',
    `First map type: ${type}`,
    '',
    'Create `.ezterminal/project-map/manifest.json` and one typed map under `.ezterminal/project-map/maps/`.',
    `First run "ezterminal-agent map guide ${type}" and follow the schemaVersion 2 local contract exactly.`,
    'Inspect the authoritative implementation before writing claims. Every semantic item and relation/message/transition needs verified source evidence.',
    'Set contentLocale to the language used for authored prose. Add only semantic layoutIntent (density and stable emphasisIds), never coordinates or routes.',
    'Keep IDs and paths portable: no absolute paths, app-local IDs, pixel coordinates, external HTML, CSS, scripts, or remote URLs.',
    'Do not copy or import Archify code, schemas, assets, runtime, CLI output, or generated HTML. It is research context only; this repository contract is authoritative.',
    'After writing, run "ezterminal-agent map check --quality draft", then "ezterminal-agent map check --quality production" and fix every diagnostic before reporting back.',
    'Do not commit or merge automatically. Summarize the created maps, evidence, and verification for human review.',
  ].join('\n');
}

interface ProjectMapLauncher {
  readonly launcherId: string;
  readonly provider: AgentHistoryProvider;
  readonly name: string;
}

interface ProjectMapLauncherState {
  readonly launchers: readonly ProjectMapLauncher[];
  readonly loading: boolean;
  readonly error: boolean;
}

function isSupportedProjectMapLauncher(
  launcher: AgentProjectLauncherSummary,
): launcher is AgentProjectLauncherSummary & { readonly provider: AgentHistoryProvider } {
  return launcher.provider === 'codex' || launcher.provider === 'claude';
}

function useProjectMapLaunchers(): ProjectMapLauncherState {
  const [state, setState] = useState<ProjectMapLauncherState>({
    launchers: [],
    loading: true,
    error: false,
  });

  useEffect(() => {
    let alive = true;
    void window.ezterminal.listAgentProjectLaunchers().then((launchers) => {
      if (!alive) return;
      setState({
        launchers: launchers.filter(isSupportedProjectMapLauncher).map((launcher) => ({
          launcherId: launcher.launcherId,
          provider: launcher.provider,
          name: launcher.name,
        })),
        loading: false,
        error: false,
      });
    }).catch(() => {
      if (alive) setState({ launchers: [], loading: false, error: true });
    });
    return () => { alive = false; };
  }, []);

  return state;
}

function projectMapBriefIsSafe(brief: string): boolean {
  if (!brief.trim()) return false;
  return isSafeAgentPromptText(projectMapJobPrompt(
    brief.trim(),
    '00000000-0000-4000-8000-000000000000',
  ));
}

const PROJECT_MAP_TERMINAL_JOB_PHASES = new Set<ProjectMapJobPhase>(['completed', 'failed', 'canceled']);

const PROJECT_MAP_JOB_PHASE_DEFAULTS: Readonly<Record<ProjectMapJobPhase, string>> = {
  queued: 'Queued',
  analyzing: 'Inspecting repository',
  authoring: 'Writing map source',
  'validating-draft': 'Validating draft',
  'validating-production': 'Validating production',
  'awaiting-review': 'Waiting for review',
  completed: 'Completed',
  failed: 'Failed',
  'cancel-requested': 'Cancel requested',
  canceled: 'Canceled',
};

const PROJECT_MAP_JOB_DETAIL_DEFAULTS: Readonly<Record<Exclude<ProjectMapJobPhase, 'queued'>, string>> = {
  analyzing: 'The Agent is inspecting authoritative implementation and evidence.',
  authoring: 'The Agent is updating repository-owned map sources.',
  'validating-draft': 'Draft checks are running.',
  'validating-production': 'Production checks are running.',
  'awaiting-review': 'Agent work is ready for human review and approval.',
  completed: 'The verified candidate was approved.',
  failed: 'The Agent reported that this job could not finish.',
  'cancel-requested': 'Waiting for the Agent to stop safely.',
  canceled: 'This request was canceled.',
};

function isActiveProjectMapJob(job: ProjectMapJob | undefined): boolean {
  return Boolean(job && !PROJECT_MAP_TERMINAL_JOB_PHASES.has(job.phase));
}

function ProjectMapJobStatus({
  params,
  job,
  onJobChanged,
}: {
  readonly params: ProjectMapPanelParams;
  readonly job: ProjectMapJob;
  readonly onJobChanged: (job: ProjectMapJob) => void;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const dedicatedSession = job.dispatch === 'dedicated-session';
  const agent = job.agentLabel ?? (dedicatedSession
    ? t('projectMap.dedicatedAgentGeneric', 'dedicated Agent')
    : t('projectMap.activeAgentGeneric', 'active Agent'));
  const terminal = PROJECT_MAP_TERMINAL_JOB_PHASES.has(job.phase);
  const phaseAdvanced = job.phase !== 'queued';
  const headline = job.phase === 'queued'
    ? dedicatedSession
      ? t('projectMap.jobDedicatedSessionStarted', '{{agent}} session started', { agent })
      : t('projectMap.jobQueuedFor', 'Queued for {{agent}}', { agent })
    : t(`projectMap.jobPhases.${job.phase}`, PROJECT_MAP_JOB_PHASE_DEFAULTS[job.phase]);
  const detail = job.message || (job.phase === 'queued'
    ? dedicatedSession
      ? t('projectMap.jobWaitingInDedicatedSession', 'Request saved. The brief is queued in the new {{agent}} session; waiting for its first progress report.', { agent })
      : t('projectMap.jobWaitingRecovered', 'Request saved. Waiting for the Agent to accept it or report progress.')
    : t(`projectMap.jobPhaseDetails.${job.phase}`, PROJECT_MAP_JOB_DETAIL_DEFAULTS[job.phase]));
  const updatedDate = new Date(job.updatedAt);
  const updatedAt = Number.isNaN(updatedDate.getTime())
    ? job.updatedAt
    : new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(updatedDate);
  const workMilestoneState = job.phase === 'queued'
    ? 'pending'
    : job.phase === 'failed' || job.phase === 'canceled'
      ? 'error'
      : job.phase === 'completed'
        ? 'complete'
        : 'current';

  return (
    <section
      className="project-map__job"
      data-phase={job.phase}
      data-testid="project-map-delivery-status"
      aria-label={t('projectMap.jobStatus', 'Project Map request status')}
      aria-busy={!terminal}
    >
      <div className="project-map__job-summary" role="status" aria-live="polite">
        <Bot size={17} aria-hidden="true" />
        <div className="project-map__job-copy">
          <strong>{headline}</strong>
          <span>{detail}</span>
          <small>
            {t('projectMap.jobMetadata', '{{intent}} · {{type}} · updated {{time}} · job {{id}}', {
              intent: t(`projectMap.jobIntents.${job.intent}`, job.intent === 'create' ? 'Create' : 'Update'),
              type: t(`projectMap.types.${job.type}`, job.type),
              time: updatedAt,
              id: job.id.slice(0, 8),
            })}
          </small>
        </div>
      </div>
      {!terminal && job.phase !== 'cancel-requested' ? (
        <button
          type="button"
          disabled={canceling}
          onClick={() => {
            const desktop = window.ezterminalDesktop;
            if (!desktop) {
              setCancelError(t('projectMap.cancelJobFailed', 'The request could not be canceled.'));
              return;
            }
            setCanceling(true);
            setCancelError(undefined);
            void desktop.cancelProjectMapJob({
              projectId: params.projectId,
              ownerRootId: params.ownerRootId,
              ownerWorkspaceId: params.ownerWorkspaceId,
              jobId: job.id,
            }).then((result) => {
              if (!result.ok) throw new Error(result.error);
              onJobChanged(result.job);
            }).catch(() => {
              setCancelError(t('projectMap.cancelJobFailed', 'The request could not be canceled.'));
            }).finally(() => setCanceling(false));
          }}
        >
          <X size={13} aria-hidden="true" />
          {canceling ? t('projectMap.cancelingJob', 'Canceling…') : t('projectMap.cancelJob', 'Cancel')}
        </button>
      ) : null}
      <ol className="project-map__job-milestones" aria-label={t('projectMap.jobMilestones', 'Request progress')}>
        <li data-state="complete"><span aria-hidden="true" />{t('projectMap.jobSaved', 'Request saved')}</li>
        <li data-state={dedicatedSession || phaseAdvanced ? 'complete' : terminal ? 'error' : 'current'}>
          <span aria-hidden="true" />
          {dedicatedSession
            ? t('projectMap.jobDedicatedSession', 'Dedicated session')
            : phaseAdvanced
              ? t('projectMap.jobDelivered', 'Agent delivery')
              : t('projectMap.jobDelivering', 'Agent handoff')}
        </li>
        <li data-state={workMilestoneState}>
          <span aria-hidden="true" />
          {phaseAdvanced
            ? t(`projectMap.jobPhases.${job.phase}`, PROJECT_MAP_JOB_PHASE_DEFAULTS[job.phase])
            : t('projectMap.jobAgentWork', 'Agent work')}
        </li>
      </ol>
      {cancelError ? <small className="project-map__job-error" role="alert">{cancelError}</small> : null}
    </section>
  );
}

function statusLabel(state: ProjectMapDocument['state'] | ProjectMapCollectionDescriptor['state']): string {
  switch (state) {
    case 'valid': return 'Verified';
    case 'stale': return 'Review needed';
    case 'invalid-with-last-good': return 'Last good';
    case 'binding-required': return 'Bind roots';
    case 'empty': return 'No maps';
    case 'invalid': return 'Invalid';
  }
}

function projectMapReachable(
  document: ProjectMapDocument,
  startId: string,
  direction: 'upstream' | 'downstream',
): ReadonlySet<string> {
  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of document.layout.edges) {
      const matches = direction === 'downstream' ? edge.from === current : edge.to === current;
      if (!matches) continue;
      const next = direction === 'downstream' ? edge.to : edge.from;
      visited.add(edge.id);
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

function authoredPrimaryIds(document: ProjectMapDocument): ReadonlySet<string> {
  const spec = document.spec;
  if (spec.type === 'architecture' || spec.type === 'workflow') return new Set(spec.mainPath);
  if (spec.type === 'dataflow') return new Set(spec.primaryPath);
  if (spec.type === 'sequence') {
    const messages = [...spec.messages].sort((left, right) => left.order - right.order);
    return new Set(messages.flatMap((message) => [message.from, message.id, message.to]));
  }
  return new Set([
    spec.initialState,
    ...spec.transitions.flatMap((transition) => [transition.from, transition.id, transition.to]),
  ]);
}

function ProjectMapCanvas({
  document,
  selectedId,
  focusedIds,
  onSelect,
}: {
  readonly document: ProjectMapDocument;
  readonly selectedId?: string;
  readonly focusedIds: ReadonlySet<string>;
  readonly onSelect: (id: string) => void;
}): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ readonly x: number; readonly y: number; readonly panX: number; readonly panY: number }>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const layout = document.layout;
  const markerId = `project-map-arrow-${document.mapId.replace(/[^a-z0-9-]/giu, '-')}`;
  const clampZoom = (value: number): number => Math.min(3.2, Math.max(0.55, value));
  const paddedWidth = layout.width + 64;
  const paddedHeight = layout.height + 64;
  const aspect = viewport.width / Math.max(1, viewport.height);
  const fittedWidth = Math.max(paddedWidth, paddedHeight * aspect);
  const fittedHeight = Math.max(paddedHeight, paddedWidth / aspect);
  const viewWidth = fittedWidth / zoom;
  const viewHeight = fittedHeight / zoom;
  const viewX = (layout.width - fittedWidth) / 2 + (fittedWidth - viewWidth) / 2 + pan.x;
  const viewY = (layout.height - fittedHeight) / 2 + (fittedHeight - viewHeight) / 2 + pan.y;

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const update = (): void => {
      const bounds = shell.getBoundingClientRect();
      setViewport({ width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [document.mapId]);

  const fit = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div ref={shellRef} className="project-map__canvas-shell">
      <div className="project-map__zoom" aria-label="Map zoom controls">
        <button type="button" onClick={() => setZoom((value) => clampZoom(value - 0.15))} aria-label="Zoom out">
          <ZoomOut size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={fit} aria-label="Fit map">
          <LocateFixed size={15} aria-hidden="true" />
          <span>Fit</span>
        </button>
        <button type="button" onClick={() => setZoom((value) => clampZoom(value + 0.15))} aria-label="Zoom in">
          <ZoomIn size={15} aria-hidden="true" />
        </button>
      </div>
      <svg
        ref={svgRef}
        className="project-map__canvas"
        viewBox={`${String(viewX)} ${String(viewY)} ${String(viewWidth)} ${String(viewHeight)}`}
        role="group"
        aria-label={`${document.spec.title}. ${document.spec.summary}`}
        onWheel={(event) => {
          event.preventDefault();
          setZoom((value) => clampZoom(value + (event.deltaY < 0 ? 0.1 : -0.1)));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest('[data-map-item]')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const svg = svgRef.current;
          if (!drag || !svg) return;
          const bounds = svg.getBoundingClientRect();
          setPan({
            x: drag.panX - (event.clientX - drag.x) * (viewWidth / Math.max(1, bounds.width)),
            y: drag.panY - (event.clientY - drag.y) * (viewHeight / Math.max(1, bounds.height)),
          });
        }}
        onPointerUp={(event) => {
          dragRef.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => { dragRef.current = undefined; }}
      >
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" className="project-map__arrow" />
          </marker>
        </defs>
        <g>
          {layout.bands.map((band) => band.width <= 1 ? (
            <line
              key={band.id}
              x1={band.x}
              y1={band.y}
              x2={band.x}
              y2={band.y + band.height}
              className="project-map__lifeline"
            />
          ) : (
            <g key={band.id} className="project-map__band">
              <rect x={band.x} y={band.y} width={band.width} height={band.height} rx="10" />
              <text x={band.x + 16} y={band.y + 27}>{band.label}</text>
            </g>
          ))}
          {layout.edges.map((edge) => {
            const points = edge.points.map((point) => `${String(point.x)},${String(point.y)}`).join(' ');
            const midpoint = edge.labelPoint;
            const dimmed = focusedIds.size > 0 && !focusedIds.has(edge.id)
              && !focusedIds.has(edge.from) && !focusedIds.has(edge.to);
            return (
              <g
                key={edge.id}
                data-map-item={edge.id}
                className="project-map__edge"
                data-kind={edge.kind}
                data-emphasized={edge.emphasized ? 'true' : undefined}
                data-selected={selectedId === edge.id ? 'true' : undefined}
                data-dimmed={dimmed ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`${edge.label}: ${edge.from} to ${edge.to}`}
                onClick={() => onSelect(edge.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(edge.id);
                  }
                }}
              >
                <polyline points={points} markerEnd={`url(#${markerId})`} />
                <polyline className="project-map__edge-hit" points={points} />
                {midpoint ? (
                  <>
                    <rect
                      className="project-map__edge-label-background"
                      x={midpoint.x - edge.labelWidth / 2}
                      y={midpoint.y - edge.labelHeight / 2}
                      width={edge.labelWidth}
                      height={edge.labelHeight}
                      rx="4"
                    />
                    <text
                      x={midpoint.x}
                      y={midpoint.y - ((edge.labelLines.length - 1) * 7) + 4}
                      textAnchor="middle"
                    >
                      {edge.labelLines.map((line, index) => (
                        <tspan key={`${String(index)}:${line}`} x={midpoint.x} dy={index === 0 ? 0 : 14}>{line}</tspan>
                      ))}
                    </text>
                  </>
                ) : null}
              </g>
            );
          })}
          {layout.nodes.map((node) => {
            const dimmed = focusedIds.size > 0 && !focusedIds.has(node.id);
            const lines = node.textLines;
            return (
              <g
                key={node.id}
                data-map-item={node.id}
                className="project-map__node"
                data-kind={node.kind}
                data-emphasized={node.emphasized ? 'true' : undefined}
                data-selected={selectedId === node.id ? 'true' : undefined}
                data-dimmed={dimmed ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}. ${node.detail ?? node.kind}`}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
              >
                {node.shape === 'diamond' ? (
                  <path d={`M ${String(node.x + node.width / 2)} ${String(node.y)} L ${String(node.x + node.width)} ${String(node.y + node.height / 2)} L ${String(node.x + node.width / 2)} ${String(node.y + node.height)} L ${String(node.x)} ${String(node.y + node.height / 2)} Z`} />
                ) : (
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx={node.shape === 'pill' ? node.height / 2 : node.shape === 'rounded' ? 12 : 4}
                  />
                )}
                <text x={node.x + node.width / 2} y={node.y + node.height / 2 - (lines.length - 1) * 9}>
                  {lines.map((line, index) => (
                    <tspan key={`${String(index)}:${line}`} x={node.x + node.width / 2} dy={index === 0 ? 0 : 18}>{line}</tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <svg
        className="project-map__minimap"
        viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        aria-hidden="true"
      >
        {layout.bands.filter((band) => band.width > 1).map((band) => (
          <rect key={band.id} x={band.x} y={band.y} width={band.width} height={band.height} rx="10" />
        ))}
        {layout.edges.map((edge) => (
          <polyline key={edge.id} points={edge.points.map((point) => `${String(point.x)},${String(point.y)}`).join(' ')} />
        ))}
        {layout.nodes.map((node) => (
          <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} rx="5" />
        ))}
        <rect className="project-map__minimap-viewport" x={viewX} y={viewY} width={viewWidth} height={viewHeight} />
      </svg>
    </div>
  );
}

function EvidenceList({
  anchors,
  bindings,
  projectId,
  onOpen,
}: {
  readonly anchors: readonly ProjectMapEvidence[];
  readonly bindings: readonly ProjectMapRootBinding[];
  readonly projectId: string;
  readonly onOpen?: (target: ProjectMapEvidenceTarget) => void;
}): JSX.Element {
  return (
    <div className="project-map__evidence-list">
      {anchors.map((anchor, index) => {
        const binding = bindings.find((candidate) => candidate.rootAlias === anchor.rootAlias);
        return (
          <article key={`${anchor.rootAlias}:${anchor.relativePath}:${String(anchor.startLine)}:${String(index)}`}>
            <p>{anchor.claim}</p>
            <button
              type="button"
              disabled={!binding || !onOpen}
              onClick={() => {
                if (!binding || !onOpen) return;
                onOpen({
                  projectId,
                  rootId: binding.rootId,
                  workspaceId: binding.workspaceId,
                  relativePath: anchor.relativePath,
                  line: anchor.startLine,
                });
              }}
            >
              <FileCode2 size={14} aria-hidden="true" />
              <span>{anchor.rootAlias}:{anchor.relativePath}:{anchor.startLine}</span>
              <ExternalLink size={12} aria-hidden="true" />
            </button>
          </article>
        );
      })}
    </div>
  );
}

function BindingEditor({
  params,
  collection,
  project,
  onSaved,
}: {
  readonly params: ProjectMapPanelParams;
  readonly collection: ProjectMapCollectionDescriptor;
  readonly project?: ProjectWorkspaceDescriptor;
  readonly onSaved: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const workspaces = project?.workspaces ?? [];

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const root of collection.roots) {
      const existing = collection.bindings.find((binding) => binding.rootAlias === root.alias);
      if (existing) initial[root.alias] = bindingValue(existing.rootId, existing.workspaceId);
      else if (root.alias === collection.ownerRootAlias) {
        initial[root.alias] = bindingValue(params.ownerRootId, params.ownerWorkspaceId);
      }
    }
    setDraft(initial);
  }, [collection.bindings, collection.ownerRootAlias, collection.roots, params.ownerRootId, params.ownerWorkspaceId]);

  return (
    <section className="project-map__binding" aria-labelledby="project-map-binding-title">
      <Map size={28} aria-hidden="true" />
      <div>
        <h2 id="project-map-binding-title">Bind logical roots</h2>
        <p>The repository keeps portable aliases. Choose the exact local checkout for each alias.</p>
      </div>
      <div className="project-map__binding-grid">
        {collection.roots.map((root) => (
          <label key={root.alias}>
            <span>{root.label}</span>
            <code>{root.alias}</code>
            <select
              value={draft[root.alias] ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, [root.alias]: event.target.value }))}
            >
              <option value="">Choose a workspace...</option>
              {workspaces.map((workspace) => (
                <option
                  key={bindingValue(workspace.rootId, workspace.workspaceId)}
                  value={bindingValue(workspace.rootId, workspace.workspaceId)}
                  disabled={workspace.access !== 'granted'}
                >
                  {workspace.name} - {workspace.branch ?? workspace.kind}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {error ? <p className="project-map__error" role="alert">{error}</p> : null}
      <button
        className="project-map__primary-action"
        type="button"
        disabled={saving || collection.roots.some((root) => !draft[root.alias])}
        onClick={() => {
          const bindings = collection.roots.flatMap((root): ProjectMapRootBinding[] => {
            const value = splitBindingValue(draft[root.alias] ?? '');
            return value ? [{ rootAlias: root.alias, ...value }] : [];
          });
          setSaving(true);
          setError(undefined);
          void window.ezterminalDesktop?.setProjectMapBindings({
            projectId: params.projectId,
            ownerRootId: params.ownerRootId,
            ownerWorkspaceId: params.ownerWorkspaceId,
            bindings,
          }).then((result) => {
            if (!result?.ok) setError(result?.error ?? 'Bindings could not be saved.');
            else onSaved();
          }).catch(() => setError('Bindings could not be saved.')).finally(() => setSaving(false));
        }}
      >
        <ShieldCheck size={16} aria-hidden="true" />
        {saving ? 'Saving...' : 'Save bindings'}
      </button>
    </section>
  );
}

function ProjectMapCreator({
  params,
  project,
  launcherState,
  activeJob,
  onCancel,
  onLaunchAgent,
}: {
  readonly params: ProjectMapPanelParams;
  readonly project?: ProjectWorkspaceDescriptor;
  readonly launcherState: ProjectMapLauncherState;
  readonly activeJob?: ProjectMapJob;
  readonly onCancel: () => void;
  readonly onLaunchAgent?: ProjectMapPanelProps['onLaunchAgent'];
}): JSX.Element {
  const { t } = useAppTranslation();
  const launchers = launcherState.launchers;
  const [type, setType] = useState<ProjectMapType>('architecture');
  const [launcherId, setLauncherId] = useState('');
  const [brief, setBrief] = useState(() => projectMapCreationBrief('architecture'));
  const [sendState, setSendState] = useState<'idle' | 'preparing' | 'launched' | 'failed'>('idle');
  const [sentTo, setSentTo] = useState('');

  useEffect(() => {
    if (!launchers.some((launcher) => launcher.launcherId === launcherId)) {
      setLauncherId(launchers[0]?.launcherId ?? '');
    }
  }, [launcherId, launchers]);

  useEffect(() => {
    if (isActiveProjectMapJob(activeJob) && sendState === 'idle') setSendState('launched');
  }, [activeJob, sendState]);

  const selected = launchers.find((launcher) => launcher.launcherId === launcherId);
  const requestLocked = sendState === 'preparing'
    || sendState === 'launched'
    || isActiveProjectMapJob(activeJob);
  const briefSafe = projectMapBriefIsSafe(brief);
  const workspace = project?.workspaces?.find((candidate) => (
    candidate.rootId === params.ownerRootId
    && candidate.workspaceId === params.ownerWorkspaceId
  ));
  const typeLabels: Readonly<Record<ProjectMapType, string>> = {
    architecture: t('projectMap.types.architecture', 'Architecture'),
    workflow: t('projectMap.types.workflow', 'Workflow'),
    sequence: t('projectMap.types.sequence', 'Sequence'),
    dataflow: t('projectMap.types.dataflow', 'Dataflow'),
    lifecycle: t('projectMap.types.lifecycle', 'Lifecycle'),
  };

  return (
    <section className="project-map__creator" aria-labelledby="project-map-create-title">
      <div className="project-map__creator-heading">
        <Map size={30} aria-hidden="true" />
        <div>
          <h2 id="project-map-create-title">{t('projectMap.createTitle', 'Create Project Map')}</h2>
          <p>{t('projectMap.createDescription', 'Choose the first map type and open a dedicated Agent session in this workspace. The new tab shows the real work and approvals.')}</p>
        </div>
      </div>

      <div className="project-map__creator-fields">
        <label>
          <span>{t('projectMap.firstMapType', 'First map type')}</span>
          <select
            autoFocus
            value={type}
            disabled={requestLocked}
            onChange={(event) => {
              const next = event.target.value as ProjectMapType;
              setType(next);
              setBrief(projectMapCreationBrief(next));
              setSendState('idle');
            }}
            data-testid="project-map-create-type"
          >
            {PROJECT_MAP_TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>{typeLabels[candidate]}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('projectMap.newSessionAgent', 'Agent for new session')}</span>
          <select
            value={launcherId}
            disabled={requestLocked || launcherState.loading}
            onChange={(event) => {
              setLauncherId(event.target.value);
              setSendState('idle');
            }}
            data-testid="project-map-create-participant"
          >
            {launchers.length === 0 ? (
              <option value="">
                {launcherState.loading
                  ? t('projectMap.loadingAgents', 'Loading Agents…')
                  : t('projectMap.noSupportedAgent', 'No configured Codex or Claude Agent')}
              </option>
            ) : null}
            {launchers.map((launcher) => (
              <option key={launcher.launcherId} value={launcher.launcherId}>
                {launcher.name} - {launcher.provider}
              </option>
            ))}
          </select>
        </label>
      </div>

      {workspace ? (
        <p className="project-map__creator-location">
          {t('projectMap.dedicatedSessionLocation', 'A fresh session opens in {{workspace}}.', {
            workspace: workspace.name,
          })}
        </p>
      ) : null}

      <label className="project-map__creator-brief">
        <span>{t('projectMap.creationBrief', 'Editable creation brief')}</span>
        <textarea
          value={brief}
          rows={11}
          disabled={requestLocked}
          aria-invalid={!briefSafe || undefined}
          onChange={(event) => {
            setBrief(event.target.value);
            setSendState('idle');
          }}
        />
      </label>

      {!launcherState.loading && launchers.length === 0 ? (
        <p className="project-map__creator-notice" role="status">
          {launcherState.error
            ? t('projectMap.agentListFailed', 'Configured Agents could not be loaded. Retry by reopening this panel.')
            : t('projectMap.configureAgentFirst', 'Configure Codex or Claude under Settings > Agents, then return here.')}
        </p>
      ) : null}
      {!briefSafe ? (
        <p className="project-map__error" role="alert">
          {brief.trim()
            ? t('projectMap.briefUnsafe', 'The brief is too large or contains unsupported control characters.')
            : t('projectMap.briefRequired', 'Enter a creation brief before opening the Agent session.')}
        </p>
      ) : null}
      {sendState === 'failed' ? (
        <p className="project-map__error" role="alert">
          {t('projectMap.sessionLaunchFailed', 'The dedicated Agent session could not be opened. Check the Agent configuration and try again.')}
        </p>
      ) : null}
      {sendState === 'launched' ? (
        <p className="project-map__creator-success" role="status">
          {t('projectMap.sessionLaunched', 'Opened a dedicated {{agent}} session. Follow the new tab for live work; the map appears only after validation succeeds.', { agent: sentTo || selected?.name || t('projectMap.dedicatedAgentGeneric', 'Agent') })}
        </p>
      ) : null}

      <div className="project-map__creator-actions">
        <button className="project-map__secondary-action" type="button" onClick={onCancel}>
          {requestLocked ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
        </button>
        <button
          className="project-map__primary-action"
          type="button"
          disabled={!selected || !briefSafe || requestLocked || !onLaunchAgent}
          onClick={() => {
            if (!selected || !onLaunchAgent || !briefSafe) return;
            setSendState('preparing');
            const target = {
              kind: 'project' as const,
              projectId: params.projectId,
              rootId: params.ownerRootId,
              workspaceId: params.ownerWorkspaceId,
            };
            void window.ezterminal.prepareAgentLaunch(target, selected.launcherId).then((prepared) => {
              if (!prepared.ok) throw new Error(prepared.reason);
              const opened = onLaunchAgent({
                kind: 'new-chat',
                target: prepared.target,
                launcherId: prepared.launcherId,
                provider: prepared.provider,
                name: prepared.name,
                cwd: prepared.cwd,
                revision: prepared.revision,
                projectMapRequest: {
                  projectId: params.projectId,
                  ownerRootId: params.ownerRootId,
                  ownerWorkspaceId: params.ownerWorkspaceId,
                  type,
                  intent: 'create',
                  brief: brief.trim(),
                },
              }, {
                projectId: params.projectId,
                rootId: params.ownerRootId,
                workspaceId: params.ownerWorkspaceId,
                projectName: project?.name ?? t('projectMap.projectFallback', 'Project'),
                titleMode: 'generated',
              });
              if (opened === false) throw new Error('pane-unavailable');
              setSentTo(prepared.name);
              setSendState('launched');
            }).catch(() => setSendState('failed'));
          }}
          data-testid="project-map-send-creation"
        >
          <Bot size={15} aria-hidden="true" />
          {sendState === 'preparing'
            ? t('projectMap.openingSession', 'Opening dedicated session…')
            : sendState === 'launched' || isActiveProjectMapJob(activeJob)
              ? t('projectMap.sessionOpened', 'Dedicated session opened')
              : t('projectMap.createInNewSession', 'Create in new Agent session')}
        </button>
      </div>
    </section>
  );
}

function AgentAuthoring({
  params,
  project,
  launcherState,
  document,
  activeJob,
  onLaunchAgent,
}: {
  readonly params: ProjectMapPanelParams;
  readonly project?: ProjectWorkspaceDescriptor;
  readonly launcherState: ProjectMapLauncherState;
  readonly document: ProjectMapDocument;
  readonly activeJob?: ProjectMapJob;
  readonly onLaunchAgent?: ProjectMapPanelProps['onLaunchAgent'];
}): JSX.Element {
  const { t } = useAppTranslation();
  const launchers = launcherState.launchers;
  const [launcherId, setLauncherId] = useState('');
  const [brief, setBrief] = useState('');
  const [sendState, setSendState] = useState<'idle' | 'preparing' | 'launched' | 'failed'>('idle');
  const briefMap = useRef('');

  useEffect(() => {
    if (!launchers.some((launcher) => launcher.launcherId === launcherId)) {
      setLauncherId(launchers[0]?.launcherId ?? '');
    }
  }, [launcherId, launchers]);

  useEffect(() => {
    if (briefMap.current === document.mapId) return;
    briefMap.current = document.mapId;
    setBrief([
      `Update the EZTerminal-native Project Map "${document.spec.title}".`,
      `Owned source: ${document.mapPath}`,
      `Map type: ${document.spec.type}`,
      '',
      'First inspect the authoritative implementation and every evidence anchor. Keep the map source portable: no absolute paths, app IDs, or pixel coordinates.',
      `Use "ezterminal-agent map guide ${document.spec.type}" for the local authoring contract, run "ezterminal-agent map check ${document.mapId} --quality draft", then run the production profile before reporting back.`,
      'Do not copy or import Archify code, schemas, assets, runtime, or generated HTML. It is research context only; this repository contract is authoritative.',
      'Do not merge or commit automatically. Summarize changed claims, evidence, and verification for human review.',
    ].join('\n'));
    setSendState('idle');
  }, [document.mapId, document.mapPath, document.spec.title, document.spec.type]);

  useEffect(() => {
    if (isActiveProjectMapJob(activeJob) && sendState === 'idle') setSendState('launched');
  }, [activeJob, sendState]);

  const selected = launchers.find((launcher) => launcher.launcherId === launcherId);
  const requestLocked = sendState === 'preparing'
    || sendState === 'launched'
    || isActiveProjectMapJob(activeJob);
  const briefSafe = projectMapBriefIsSafe(brief);
  return (
    <details className="project-map__authoring">
      <summary><Bot size={15} aria-hidden="true" /> {t('projectMap.updateWithAgent', 'Update in a new Agent session')}</summary>
      <p>{t('projectMap.updateWithAgentDescription', 'Open a dedicated Agent tab in the owning workspace so its work, approvals, and errors remain visible.')}</p>
      <label>
        <span>{t('projectMap.newSessionAgent', 'Agent for new session')}</span>
        <select
          value={launcherId}
          disabled={requestLocked || launcherState.loading}
          onChange={(event) => setLauncherId(event.target.value)}
        >
          {launchers.length === 0 ? (
            <option value="">
              {launcherState.loading
                ? t('projectMap.loadingAgents', 'Loading Agents…')
                : t('projectMap.noSupportedAgent', 'No configured Codex or Claude Agent')}
            </option>
          ) : null}
          {launchers.map((launcher) => (
            <option key={launcher.launcherId} value={launcher.launcherId}>
              {launcher.name} - {launcher.provider}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('projectMap.editableBrief', 'Editable brief')}</span>
        <textarea
          value={brief}
          rows={10}
          disabled={requestLocked}
          aria-invalid={!briefSafe || undefined}
          onChange={(event) => {
            setBrief(event.target.value);
            setSendState('idle');
          }}
        />
      </label>
      <button
        type="button"
        disabled={!selected || !briefSafe || requestLocked || !onLaunchAgent}
        onClick={() => {
          if (!selected || !onLaunchAgent || !briefSafe) return;
          setSendState('preparing');
          const target = {
            kind: 'project' as const,
            projectId: params.projectId,
            rootId: params.ownerRootId,
            workspaceId: params.ownerWorkspaceId,
          };
          void window.ezterminal.prepareAgentLaunch(target, selected.launcherId).then((prepared) => {
            if (!prepared.ok) throw new Error(prepared.reason);
            const opened = onLaunchAgent({
              kind: 'new-chat',
              target: prepared.target,
              launcherId: prepared.launcherId,
              provider: prepared.provider,
              name: prepared.name,
              cwd: prepared.cwd,
              revision: prepared.revision,
              projectMapRequest: {
                projectId: params.projectId,
                ownerRootId: params.ownerRootId,
                ownerWorkspaceId: params.ownerWorkspaceId,
                mapId: document.mapId,
                type: document.spec.type,
                intent: 'update',
                brief: brief.trim(),
              },
            }, {
              projectId: params.projectId,
              rootId: params.ownerRootId,
              workspaceId: params.ownerWorkspaceId,
              projectName: project?.name ?? t('projectMap.projectFallback', 'Project'),
              titleMode: 'generated',
            });
            if (opened === false) throw new Error('pane-unavailable');
            setSendState('launched');
          }).catch(() => setSendState('failed'));
        }}
      >
        <Bot size={14} aria-hidden="true" />
        {sendState === 'preparing'
          ? t('projectMap.openingSession', 'Opening dedicated session…')
          : sendState === 'launched' || isActiveProjectMapJob(activeJob)
            ? t('projectMap.sessionOpened', 'Dedicated session opened')
            : t('projectMap.updateInNewSession', 'Update in new Agent session')}
      </button>
      {!briefSafe ? <small className="project-map__error" role="alert">{brief.trim()
        ? t('projectMap.briefUnsafe', 'The brief is too large or contains unsupported control characters.')
        : t('projectMap.briefRequired', 'Enter a brief before opening the Agent session.')}</small> : null}
      {!launcherState.loading && launchers.length === 0 ? <small>{t('projectMap.configureAgentFirst', 'Configure Codex or Claude under Settings > Agents, then return here.')}</small> : null}
      {sendState === 'launched' ? <small role="status">{t('projectMap.sessionOpenedHint', 'The dedicated Agent tab now owns this update request.')}</small> : null}
      {sendState === 'failed' ? <small className="project-map__error" role="alert">{t('projectMap.sessionLaunchFailed', 'The dedicated Agent session could not be opened. Check the Agent configuration and try again.')}</small> : null}
    </details>
  );
}

export function ProjectMapPanel(props: ProjectMapPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const launcherState = useProjectMapLaunchers();
  const [params, setParams] = useState<ProjectMapPanelParams | null>(() => isParams(props.params) ? props.params : null);
  const [collection, setCollection] = useState<ProjectMapCollectionDescriptor>();
  const [project, setProject] = useState<ProjectWorkspaceDescriptor>();
  const [document, setDocument] = useState<ProjectMapDocument>();
  const [snapshot, setSnapshot] = useState<ProjectMapSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [chapterId, setChapterId] = useState<string>();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [explorationIds, setExplorationIds] = useState<ReadonlySet<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [exportTheme, setExportTheme] = useState<'current' | 'light' | 'dark'>('current');
  const [exportState, setExportState] = useState<{ readonly kind: 'idle' | 'working' | 'done' | 'error'; readonly message?: string }>({ kind: 'idle' });
  const panelRef = useRef<HTMLElement>(null);
  const generation = useRef(0);
  useDockPanelHost(panelRef, props.api);
  const handleJobChanged = useCallback((job: ProjectMapJob): void => {
    setSnapshot((current) => current ? { ...current, activeJob: job } : current);
  }, []);

  useEffect(() => {
    const disposable = props.api.onDidParametersChange((next) => {
      setParams(isParams(next) ? next : null);
    });
    return () => disposable.dispose();
  }, [props.api]);

  useEffect(() => {
    generation.current += 1;
    setCollection(undefined);
    setProject(undefined);
    setDocument(undefined);
    setSnapshot(undefined);
    setError(undefined);
    setCreating(false);
    setLoading(true);
  }, [params?.ownerRootId, params?.ownerWorkspaceId, params?.projectId]);

  const load = useCallback(async (requestedMapId?: string, force = false): Promise<void> => {
    if (!params || !window.ezterminalDesktop) {
      setLoading(false);
      setError('Project Maps are available on desktop only.');
      return;
    }
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const openRequest = {
        projectId: params.projectId,
        ownerRootId: params.ownerRootId,
        ownerWorkspaceId: params.ownerWorkspaceId,
        ...(requestedMapId ?? params.mapId ? { mapId: requestedMapId ?? params.mapId } : {}),
      };
      const [opened, projectResult] = await Promise.all([
        force
          ? window.ezterminalDesktop.refreshProjectMapSnapshot(openRequest)
          : window.ezterminalDesktop.openProjectMap(openRequest),
        window.ezterminalDesktop.describeProjectWorkspace(params.projectId),
      ]);
      if (generation.current !== currentGeneration) return;
      setSnapshot(opened.snapshot);
      setCollection(opened.snapshot.collection);
      setDocument(opened.snapshot.map);
      if (opened.snapshot.collection.state !== 'empty') setCreating(false);
      if (projectResult.ok) setProject(projectResult.project);
      setError(opened.ok ? undefined : opened.error);
    } catch {
      if (generation.current === currentGeneration) setError('Project Map could not be loaded.');
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [params]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !params) return undefined;
    return desktop.onProjectMapChanged((changed) => {
      if (changed.projectId === params.projectId
        && changed.ownerRootId === params.ownerRootId
        && changed.ownerWorkspaceId === params.ownerWorkspaceId) {
        if (!changed.impactedMapIds || !document?.mapId || changed.impactedMapIds.includes(document.mapId)) {
          void load(document?.mapId);
        }
      }
    });
  }, [document?.mapId, load, params]);

  useEffect(() => {
    setSelectedId(undefined);
    setChapterId(undefined);
    setQuery('');
    setExplorationIds(new Set());
    setExportState({ kind: 'idle' });
  }, [document?.mapId]);

  const focusedIds = useMemo(() => new Set([
    ...(document?.spec.chapters.find((chapter) => chapter.id === chapterId)?.focusIds ?? []),
    ...explorationIds,
  ]), [chapterId, document, explorationIds]);
  const selectedItem = document
    ? document.layout.nodes.find((node) => node.id === selectedId)
      ?? document.layout.edges.find((edge) => edge.id === selectedId)
    : undefined;
  const searchResults = useMemo(() => {
    if (!document || !query.trim()) return [];
    const needle = query.trim().toLocaleLowerCase();
    return [...document.layout.nodes, ...document.layout.edges]
      .filter((item) => item.label.toLocaleLowerCase().includes(needle))
      .slice(0, 8);
  }, [document, query]);

  if (!params) {
    return <section ref={panelRef} className="project-map project-map--center"><AlertTriangle />Invalid Project Map panel.</section>;
  }
  const displayedState = document?.state ?? collection?.state ?? 'invalid';
  const candidate = snapshot?.candidate;
  const approvalMatchesCandidate = Boolean(candidate && snapshot?.approval?.fingerprint === candidate.verification.fingerprint);
  const candidateReady = Boolean(candidate
    && candidate.state === 'valid'
    && candidate.verification.quality === 'production'
    && candidate.verification.diagnostics.length === 0
    && candidate.verification.checks.every((check) => check.status === 'passed'));
  const approvedFingerprint = snapshot?.approval?.fingerprint;

  const approveCandidate = (): void => {
    if (!candidate || !candidateReady || !window.ezterminalDesktop) return;
    setApproving(true);
    void window.ezterminalDesktop.approveProjectMap({
      projectId: params.projectId,
      ownerRootId: params.ownerRootId,
      ownerWorkspaceId: params.ownerWorkspaceId,
      mapId: candidate.mapId,
      fingerprint: candidate.verification.fingerprint,
    }).then((result) => {
      setSnapshot(result.snapshot);
      setCollection(result.snapshot.collection);
      setDocument(result.snapshot.map);
      setError(result.ok ? undefined : result.error);
    }).catch(() => setError(t('projectMap.approvalFailed', 'Project Map approval could not be saved.'))).finally(() => setApproving(false));
  };

  const exportApproved = (): void => {
    if (!document || !approvedFingerprint || !window.ezterminalDesktop) return;
    const desktop = window.ezterminalDesktop;
    setExportState({ kind: 'working' });
    void desktop.selectProjectMapExportDirectory().then(async (selected) => {
      if (!selected.ok) {
        setExportState(selected.error === 'canceled' ? { kind: 'idle' } : { kind: 'error', message: selected.error });
        return;
      }
      const result = await desktop.exportProjectMap({
        projectId: params.projectId,
        ownerRootId: params.ownerRootId,
        ownerWorkspaceId: params.ownerWorkspaceId,
        mapId: snapshot?.approval?.mapId ?? document.mapId,
        fingerprint: approvedFingerprint,
        parentDirectory: selected.directory,
        theme: exportTheme,
      });
      setExportState(result.ok
        ? { kind: 'done', message: result.directory }
        : { kind: 'error', message: result.error ?? t('projectMap.exportFailed', 'Export failed.') });
    }).catch(() => setExportState({ kind: 'error', message: t('projectMap.exportFailed', 'Export failed.') }));
  };

  return (
    <section ref={panelRef} className="project-map" data-state={document?.state ?? collection?.state ?? 'loading'}>
      <header className="project-map__toolbar">
        <div className="project-map__identity">
          <Map size={18} aria-hidden="true" />
          <div>
            <strong>{document?.spec.title ?? t('projectMap.title', 'Project Map')}</strong>
            <small>{document?.spec.summary ?? collection?.collectionId ?? 'Repository-owned system maps'}</small>
          </div>
        </div>
        {collection && collection.maps.length > 0 ? (
          <label className="project-map__selector">
            <span className="sr-only">{t('projectMap.mapSelector', 'Map')}</span>
            <select
              value={document?.mapId ?? params.mapId ?? collection.overviewMapId ?? ''}
              onChange={(event) => {
                const mapId = event.target.value;
                props.api.updateParameters({ ...params, mapId });
                void load(mapId);
              }}
            >
              {collection.maps.map((map) => <option key={map.id} value={map.id}>{map.id} - {map.type}</option>)}
            </select>
          </label>
        ) : null}
        <span className="project-map__status" data-state={displayedState}>
          {document?.state === 'valid' ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
          {t(`projectMap.status.${displayedState}`, statusLabel(displayedState))}
        </span>
        {candidate && !approvalMatchesCandidate ? (
          <button
            className="project-map__primary-action project-map__approve"
            type="button"
            disabled={!candidateReady || approving}
            onClick={approveCandidate}
            data-testid="project-map-approve"
          >
            <ShieldCheck size={15} aria-hidden="true" />
            {approving ? t('projectMap.approving', 'Approving…') : t('projectMap.approve', 'Approve map')}
          </button>
        ) : null}
        <div className="project-map__export-controls">
          <label>
            <span className="sr-only">{t('projectMap.exportTheme', 'Export theme')}</span>
            <select value={exportTheme} onChange={(event) => setExportTheme(event.target.value as typeof exportTheme)} disabled={!approvedFingerprint}>
              <option value="current">{t('projectMap.themeCurrent', 'Current theme')}</option>
              <option value="light">{t('projectMap.themeLight', 'Light')}</option>
              <option value="dark">{t('projectMap.themeDark', 'Dark')}</option>
            </select>
          </label>
          <button type="button" disabled={!approvedFingerprint || exportState.kind === 'working'} onClick={exportApproved}>
            <Download size={15} aria-hidden="true" /> {t('projectMap.export', 'Export')}
          </button>
        </div>
        <button className="project-map__icon-action" type="button" onClick={() => void load(document?.mapId, true)} aria-label="Refresh map">
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </header>

      {exportState.kind === 'done' ? <div className="project-map__export-result" role="status">{t('projectMap.exportedTo', 'Exported to {{directory}}', { directory: exportState.message })}</div> : null}
      {exportState.kind === 'error' ? <div className="project-map__export-result project-map__export-result--error" role="alert">{exportState.message}</div> : null}
      {snapshot?.activeJob ? (
        <ProjectMapJobStatus
          params={params}
          job={snapshot.activeJob}
          onJobChanged={handleJobChanged}
        />
      ) : null}

      {loading && !collection ? <div className="project-map__loading"><RefreshCw className="spin" /> {t('projectMap.loading', 'Loading Project Map…')}</div> : null}
      {!loading && collection && !document && snapshot?.verificationPending ? (
        <div className="project-map__loading"><RefreshCw className="spin" /> {t('projectMap.preparing', 'Preparing the first Production snapshot…')}</div>
      ) : null}

      {!loading && collection?.state === 'empty' ? (
        creating ? (
          <ProjectMapCreator
            params={params}
            project={project}
            launcherState={launcherState}
            activeJob={snapshot?.activeJob}
            onCancel={() => setCreating(false)}
            onLaunchAgent={props.onLaunchAgent}
          />
        ) : (
          <div className="project-map__empty">
            <Map size={32} aria-hidden="true" />
            <h2>{t('projectMap.noCollection', 'No Project Map collection')}</h2>
            <p>{t('projectMap.noCollectionDescription', 'Create the first verified map in a dedicated Agent session. EZTerminal opens the workspace and submits the brief; it never invents or writes repository files itself.')}</p>
            <button
              className="project-map__primary-action"
              type="button"
              disabled={isActiveProjectMapJob(snapshot?.activeJob)}
              onClick={() => setCreating(true)}
              data-testid="project-map-create"
            >
              <Plus size={16} aria-hidden="true" />
              {isActiveProjectMapJob(snapshot?.activeJob)
                ? t('projectMap.requestInProgress', 'Request in progress')
                : t('projectMap.create', 'Create Project Map')}
            </button>
            <small>{t('projectMap.manualGuide', 'Manual authoring remains available with:')}</small>
            <code>ezterminal-agent map guide architecture</code>
          </div>
        )
      ) : null}

      {collection?.state === 'binding-required' ? (
        <BindingEditor params={params} collection={collection} project={project} onSaved={() => void load()} />
      ) : null}

      {!document && collection?.state === 'invalid' ? (
        <div className="project-map__empty project-map__empty--error">
          <AlertTriangle size={32} aria-hidden="true" />
          <h2>{t('projectMap.sourceInvalid', 'Project Map source is invalid')}</h2>
          <p>{error ?? t('projectMap.sourceInvalidRecovery', 'Fix the manifest diagnostics and refresh.')}</p>
          <ul>{collection.diagnostics.slice(0, 8).map((item) => <li key={`${item.code}:${item.subject}`}>{item.subject}: {item.message}</li>)}</ul>
        </div>
      ) : null}

      {document ? (
        <div className="project-map__workspace" data-inspector-empty={selectedItem ? undefined : 'true'}>
          <aside className="project-map__rail" aria-label="Map chapters and search">
            <label className="project-map__search">
              <Search size={14} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('projectMap.find', 'Find a node or relation')} />
            </label>
            {searchResults.length > 0 ? (
              <div className="project-map__search-results">
                {searchResults.map((item) => (
                  <button key={item.id} type="button" onClick={() => setSelectedId(item.id)}>{item.label}</button>
                ))}
              </div>
            ) : null}
            <div className="project-map__chapters">
              <span>{t('projectMap.chapters', 'Chapters')}</span>
              <button type="button" data-active={!chapterId ? 'true' : undefined} onClick={() => setChapterId(undefined)}>
                <Focus size={14} aria-hidden="true" /> {t('projectMap.fullMap', 'Full map')}
              </button>
              {document.spec.chapters.map((chapter) => (
                <button
                  key={chapter.id}
                  type="button"
                  data-active={chapter.id === chapterId ? 'true' : undefined}
                  onClick={() => setChapterId(chapter.id)}
                >
                  <span>{chapter.title}</span>
                  <small>{chapter.summary}</small>
                </button>
              ))}
            </div>
            <div className="project-map__provenance">
              <span><GitCommitHorizontal size={14} aria-hidden="true" /> {document.provenance.kind === 'commit-pinned' ? 'Commit pinned' : 'Worktree snapshot'}</span>
              {document.provenance.roots.map((root) => (
                <small key={root.rootAlias}>{root.rootAlias} - {root.dirty ? root.snapshotHash?.slice(7, 17) : root.head.slice(0, 10)}</small>
              ))}
            </div>
          </aside>

          <main className="project-map__main">
            {snapshot?.verificationPending ? <div className="project-map__banner" role="status"><RefreshCw className="spin" size={15} /> {t('projectMap.verifyingBackground', 'Production verification is running in the background. The visible approved map remains interactive.')}</div> : null}
            {snapshot?.displaySource === 'candidate-preview' ? <div className="project-map__banner" role="status"><AlertTriangle size={15} /> {t('projectMap.candidatePreview', 'Candidate preview. Review the checks and approve it before export.')}</div> : null}
            {snapshot?.displaySource === 'last-approved' && snapshot.candidate ? <div className="project-map__banner" role="status"><AlertTriangle size={15} /> {t('projectMap.lastApprovedCandidate', 'Showing the last approved map. A newly verified candidate is waiting for review.')}</div> : null}
            {error ? <div className="project-map__banner" role="status"><AlertTriangle size={15} /> Showing verified last-good data because current source failed: {error}</div> : null}
            {document.state === 'stale' ? <div className="project-map__banner" role="status"><AlertTriangle size={15} /> {t('projectMap.stale', 'Authoritative inputs changed. Review the map or record a no-semantic-impact reason.')}</div> : null}
            {snapshot?.diff ? (
              <details className="project-map__diff">
                <summary>{t('projectMap.candidateChanges', 'Candidate changes · {{semantic}} semantic · {{evidence}} evidence', { semantic: snapshot.diff.semantic.length, evidence: snapshot.diff.evidence.length })}</summary>
                <div>
                  {[...snapshot.diff.semantic, ...snapshot.diff.evidence].slice(0, 20).map((change, index) => (
                    <span key={`${change.kind}:${change.id}:${String(index)}`} data-kind={change.kind}>
                      {change.kind} <code>{change.id}</code> · {change.fields.join(', ')}
                    </span>
                  ))}
                </div>
              </details>
            ) : null}
            <ProjectMapCanvas document={document} selectedId={selectedId} focusedIds={focusedIds} onSelect={setSelectedId} />
            <details className="project-map__outline">
              <summary>{t('projectMap.semanticOutline', 'Semantic outline')}</summary>
              <ul>
                {document.layout.nodes.map((node) => <li key={node.id}><button type="button" onClick={() => setSelectedId(node.id)}>{node.label} - {node.kind}</button></li>)}
                {document.layout.edges.map((edge) => <li key={edge.id}><button type="button" onClick={() => setSelectedId(edge.id)}>{edge.from} - {edge.label} -&gt; {edge.to}</button></li>)}
              </ul>
            </details>
          </main>

          <aside className="project-map__inspector" aria-label="Evidence inspector">
            {selectedItem ? (
              <>
                <div className="project-map__inspector-title">
                  <span>{selectedItem.kind}</span>
                  <h2>{selectedItem.label}</h2>
                  {'detail' in selectedItem && selectedItem.detail ? <p>{selectedItem.detail}</p> : null}
                </div>
                <div className="project-map__exploration" aria-label="Directed map exploration">
                  <button
                    type="button"
                    disabled={!document.layout.nodes.some((node) => node.id === selectedItem.id)}
                    onClick={() => setExplorationIds(projectMapReachable(document, selectedItem.id, 'upstream'))}
                  >
                    {t('projectMap.upstream', 'Upstream')}
                  </button>
                  <button
                    type="button"
                    disabled={!document.layout.nodes.some((node) => node.id === selectedItem.id)}
                    onClick={() => setExplorationIds(projectMapReachable(document, selectedItem.id, 'downstream'))}
                  >
                    {t('projectMap.downstream', 'Downstream')}
                  </button>
                  <button type="button" onClick={() => setExplorationIds(authoredPrimaryIds(document))}>{t('projectMap.authoredRoute', 'Authored route')}</button>
                  {explorationIds.size > 0 ? <button type="button" onClick={() => setExplorationIds(new Set())}>{t('projectMap.clear', 'Clear')}</button> : null}
                </div>
                <h3>{t('projectMap.evidence', 'Evidence')}</h3>
                <EvidenceList anchors={selectedItem.evidence} bindings={collection?.bindings ?? []} projectId={params.projectId} onOpen={props.onOpenEvidence} />
              </>
            ) : (
              <div className="project-map__inspector-empty">
                <LocateFixed size={24} aria-hidden="true" />
                <h2>{t('projectMap.selectItem', 'Select an item')}</h2>
                <p>{t('projectMap.selectItemDescription', 'Inspect the claim and jump to its verified source lines.')}</p>
              </div>
            )}
            <div className="project-map__checks" aria-label={`${String(document.verification.checks.filter((check) => check.status === 'passed').length)} of ${String(document.verification.checks.length)} verification checks passed`}>
              <h3>{t('projectMap.verification', 'Verification')}</h3>
              <span className="project-map__checks-summary">
                <CheckCircle2 size={13} />
                {t('projectMap.checksPassed', '{{passed}}/{{total}} checks passed', {
                  passed: document.verification.checks.filter((check) => check.status === 'passed').length,
                  total: document.verification.checks.length,
                })}
              </span>
              {document.verification.checks.map((check) => (
                <span key={check.name} data-status={check.status}>
                  {check.status === 'passed' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                  {check.name}
                </span>
              ))}
            </div>
            <AgentAuthoring
              params={params}
              project={project}
              launcherState={launcherState}
              document={document}
              activeJob={snapshot?.activeJob}
              onLaunchAgent={props.onLaunchAgent}
            />
          </aside>
        </div>
      ) : null}
    </section>
  );
}
