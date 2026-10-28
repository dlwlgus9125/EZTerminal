import type { WorkflowGraph } from '../../shared/workflow-graph';
import type { WorkflowRunOverlay } from './workflow-canvas-model';
import type { WorkflowCopy } from './workflow-copy';

/** What is selected on the canvas. Shared by every renderer and the side panel. */
export type CanvasSelection = { readonly kind: 'node' | 'edge'; readonly id: string } | null;

/**
 * What a stage card shows beyond the stage itself (the agent placed on it, the chain it continues,
 * its checks). Presentational: the workspace derives it; renderers only pass it to the card.
 */
export interface WorkflowNodeDecoration {
  /** The agent placed on the stage (Settings › AI › 에이전트), with the stage's own effort. `missing`: not on this PC. */
  readonly agent?: { readonly name: string; readonly detail: string; readonly effort?: string; readonly tone?: 'codex' | 'claude' | 'other'; readonly missing?: boolean };
  /** Stages one agent does in the same conversation, in order (같은 에이전트 이어서). */
  readonly chain?: { readonly label: string; readonly position: 'first' | 'middle' | 'last' };
  /** Short facts under the title, e.g. 확인 명령 · 검토 끔. */
  readonly badges?: readonly string[];
  /** Replaces the operation label (e.g. 답변 기다림 for a stage that waits for the person's answer). */
  readonly kindLabel?: string;
  /** An agent is being dragged over this stage. */
  readonly dropTarget?: boolean;
  /** The run state in this stage's own words (e.g. 답변 대기 · 조치 필요 for an answer stage). */
  readonly statusLabel?: string;
  /** Waits for the person (an answer stage): amber like an awaiting approval. */
  readonly attention?: boolean;
  /** Port names of this kind of stage (e.g. 답함 for an answer stage) and ports it does not have. */
  readonly portLabels?: Readonly<Partial<Record<'next' | 'passed' | 'failed' | 'approved' | 'rejected', string>>>;
  readonly hiddenPorts?: readonly ('next' | 'passed' | 'failed' | 'approved' | 'rejected')[];
}
/** A connection between two stages of one chain (the same conversation continues). */
export interface WorkflowEdgeDecoration { readonly chain?: boolean; readonly label?: string }

/**
 * The contract both canvas renderers implement: the React Flow canvas (desktop, lazy chunk) and
 * the static graph (Android, tests, and the fallback when the chunk fails). Nothing here imports
 * React Flow, so the shared panel never pulls it into the mobile bundle.
 */
export interface WorkflowCanvasRendererProps {
  readonly graph: WorkflowGraph;
  readonly overlay: WorkflowRunOverlay | null;
  readonly editable: boolean;
  readonly selection: CanvasSelection;
  readonly onSelect: (selection: CanvasSelection) => void;
  readonly onGraphChange: (graph: WorkflowGraph) => void;
  readonly text: WorkflowCopy;
  readonly label: string;
  readonly issueCounts?: Readonly<Record<string, number>>;
  /** Fixed camera for deterministic stories; otherwise the canvas fits once when first visible. */
  readonly initialViewport?: { readonly x: number; readonly y: number; readonly zoom: number };
  /** False while the panel is hidden (an inactive dock tab has no size to fit into). */
  readonly active?: boolean;
  /** Deleting a stage goes through the panel's confirmation, never straight from a key press. */
  readonly onRequestDeleteNode?: (nodeId: string) => void;
  /** Bring this stage into view when the key changes (e.g. the approval chip), keeping the zoom. */
  readonly reveal?: { readonly nodeId: string; readonly key: number };
  /** The camera after the user pans or zooms, so the parent can restore it when the canvas remounts. */
  readonly onViewportChange?: (viewport: { readonly x: number; readonly y: number; readonly zoom: number }) => void;
  /** Tidy the layout (offered next to the zoom controls while editing). */
  readonly onTidy?: () => void;
  /** Called once a reveal request was carried out, so it never replays on a later mount. */
  readonly onRevealed?: () => void;
  /** The largest measured card in graph units (titles wrap), for tidy spacing and overlap checks. */
  readonly onCardSize?: (size: { readonly width: number; readonly height: number }) => void;
  readonly decorations?: Readonly<Record<string, WorkflowNodeDecoration>>;
  readonly edgeDecorations?: Readonly<Record<string, WorkflowEdgeDecoration>>;
}
