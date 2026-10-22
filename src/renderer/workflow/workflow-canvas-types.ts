import type { WorkflowGraph } from '../../shared/workflow-graph';
import type { WorkflowRunOverlay } from './workflow-canvas-model';
import type { WorkflowCopy } from './workflow-copy';

/** What is selected on the canvas. Shared by every renderer and the side panel. */
export type CanvasSelection = { readonly kind: 'node' | 'edge'; readonly id: string } | null;

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
}
