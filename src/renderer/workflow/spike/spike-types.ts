import type { WorkflowGraph } from '../../../shared/workflow-graph';
import type { WorkflowRunOverlay } from '../workflow-canvas-model';
import type { WorkflowCopy } from '../workflow-copy';

/** Spike-only contract both A/B canvas prototypes implement. Removed once the user picks one. */
export type CanvasSelection = { readonly kind: 'node' | 'edge'; readonly id: string } | null;
export interface WorkflowCanvasRendererProps {
  readonly graph: WorkflowGraph;
  readonly overlay: WorkflowRunOverlay | null;
  readonly editable: boolean;
  readonly selection: CanvasSelection;
  readonly onSelect: (selection: CanvasSelection) => void;
  readonly onGraphChange: (graph: WorkflowGraph) => void;
  readonly text: WorkflowCopy;
}
