interface IsolationState {
  count: number;
  readonly hadInert: boolean;
  readonly ariaHidden: string | null;
}

interface IsolationLayer {
  readonly root: HTMLElement;
  isolated: HTMLElement[];
}

const isolationStates = new WeakMap<HTMLElement, IsolationState>();
const isolationLayers: IsolationLayer[] = [];
const modalLayers: HTMLElement[] = [];

function isolate(element: HTMLElement): void {
  const existing = isolationStates.get(element);
  if (existing) {
    existing.count += 1;
  } else {
    isolationStates.set(element, {
      count: 1,
      hadInert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    });
  }
  element.setAttribute('inert', '');
  element.setAttribute('aria-hidden', 'true');
}

function release(element: HTMLElement): void {
  const state = isolationStates.get(element);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  isolationStates.delete(element);

  if (!state.hadInert) element.removeAttribute('inert');
  if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', state.ariaHidden);
}

function collectBackgroundBranches(modalRoot: HTMLElement): HTMLElement[] {
  const background: HTMLElement[] = [];
  let branch: HTMLElement = modalRoot;
  let parent = branch.parentElement;

  while (parent) {
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      background.push(sibling);
    }
    if (parent === document.body) break;
    branch = parent;
    parent = parent.parentElement;
  }

  return background;
}

function applyTopIsolationLayer(): void {
  for (const layer of isolationLayers) {
    for (const element of layer.isolated) release(element);
    layer.isolated = [];
  }

  const top = isolationLayers[isolationLayers.length - 1];
  if (!top) return;
  top.isolated = collectBackgroundBranches(top.root);
  for (const element of top.isolated) isolate(element);
}

/**
 * Makes every branch outside a modal unavailable to keyboard, pointer and
 * accessibility-tree navigation, whether the modal is inline or portaled.
 *
 * Isolation is layered: only the newest modal branch remains interactive.
 * When it closes, the previous modal's isolation is recomputed so a nested
 * dialog cannot leave its owning sidebar or the page background exposed.
 */
export function isolateModalBackground(modalRoot: HTMLElement): () => void {
  const layer: IsolationLayer = { root: modalRoot, isolated: [] };
  isolationLayers.push(layer);
  applyTopIsolationLayer();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const element of layer.isolated) release(element);
    layer.isolated = [];
    const index = isolationLayers.lastIndexOf(layer);
    if (index >= 0) isolationLayers.splice(index, 1);
    applyTopIsolationLayer();
  };
}

/** Registers a modal in visual stacking order and removes it idempotently. */
export function registerModalLayer(element: HTMLElement): () => void {
  modalLayers.push(element);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = modalLayers.lastIndexOf(element);
    if (index >= 0) modalLayers.splice(index, 1);
  };
}

/** Keyboard and backdrop dismissal belong exclusively to the topmost modal. */
export function isTopModalLayer(element: HTMLElement | null): boolean {
  return element !== null && modalLayers[modalLayers.length - 1] === element;
}
