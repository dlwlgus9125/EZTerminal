import { isDomElement } from './utils';

interface IsolationState {
  count: number;
  readonly hadInert: boolean;
  readonly ariaHidden: string | null;
}

interface IsolationLayer {
  readonly document: Document;
  readonly foregroundRoots: readonly HTMLElement[];
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

function collectBackgroundBranches(foregroundRoots: readonly HTMLElement[]): HTMLElement[] {
  const primaryRoot = foregroundRoots[0];
  const body = primaryRoot?.ownerDocument.body;
  if (!body) return [];

  const roots = Array.from(new Set(foregroundRoots))
    .filter((root) => root.ownerDocument.body === body && body.contains(root));
  // A passive-effect cleanup can run after React has already detached its
  // modal DOM. Never interpret that transient state as "no foreground" and
  // inert the entire document while the layer is waiting to be released.
  if (!roots.includes(primaryRoot)) return [];
  if (roots.includes(body)) return [];

  const rootSet = new Set(roots);
  const foregroundPaths = new Set<HTMLElement>();
  for (const root of roots) {
    let branch: HTMLElement | null = root;
    while (branch) {
      foregroundPaths.add(branch);
      if (branch === body) break;
      branch = branch.parentElement;
    }
  }

  const background: HTMLElement[] = [];
  const visit = (parent: HTMLElement): void => {
    for (const sibling of parent.children) {
      if (!isDomElement(sibling)) continue;
      const element = sibling as HTMLElement;
      if (rootSet.has(element)) continue;
      if (foregroundPaths.has(element)) visit(element);
      else background.push(element);
    }
  };
  visit(body);

  return background;
}

function getTopIsolationLayer(ownerDocument: Document): IsolationLayer | undefined {
  for (let modalIndex = modalLayers.length - 1; modalIndex >= 0; modalIndex -= 1) {
    const registeredModal = modalLayers[modalIndex];
    if (registeredModal.ownerDocument !== ownerDocument) continue;
    for (let index = isolationLayers.length - 1; index >= 0; index -= 1) {
      const layer = isolationLayers[index];
      if (layer.foregroundRoots.includes(registeredModal)) return layer;
    }
  }
  for (let index = isolationLayers.length - 1; index >= 0; index -= 1) {
    if (isolationLayers[index].document === ownerDocument) return isolationLayers[index];
  }
  return undefined;
}

function applyTopIsolationLayer(ownerDocument: Document): void {
  for (const layer of isolationLayers) {
    if (layer.document !== ownerDocument) continue;
    for (const element of layer.isolated) release(element);
    layer.isolated = [];
  }

  // Registration order normally mirrors visual order, except when an outer
  // responsive layer becomes modal after a portaled child dialog is already
  // open. The registered dialog remains the visual and interaction owner.
  const top = getTopIsolationLayer(ownerDocument);
  if (!top) return;
  top.isolated = collectBackgroundBranches(top.foregroundRoots);
  for (const element of top.isolated) isolate(element);
}

/**
 * Makes every branch outside a modal unavailable to keyboard, pointer and
 * accessibility-tree navigation, whether the modal is inline or portaled.
 *
 * Isolation is layered: only the newest modal branch remains interactive.
 * When it closes, the previous modal's isolation is recomputed so a nested
 * dialog cannot leave its owning sidebar or the page background exposed.
 *
 * `additionalForegroundRoots` supports a composite modal surface whose
 * interactive controls live in sibling DOM branches. A narrow workbench
 * sidebar uses it for the stable Activity Rail; a nested dialog still becomes
 * the sole top layer and temporarily isolates every sidebar branch.
 */
export function isolateModalBackground(
  modalRoot: HTMLElement,
  additionalForegroundRoots: readonly HTMLElement[] = [],
  activeDocument: Document = document,
): () => void {
  const ownerDocument = modalRoot.ownerDocument;
  if (
    ownerDocument !== activeDocument
    ||
    additionalForegroundRoots.some((root) => root.ownerDocument !== ownerDocument)
  ) {
    throw new TypeError('Background isolation roots must belong to the active document.');
  }
  if (!ownerDocument.body.contains(modalRoot)) return () => undefined;
  const layer: IsolationLayer = {
    document: ownerDocument,
    foregroundRoots: [modalRoot, ...additionalForegroundRoots],
    isolated: [],
  };
  isolationLayers.push(layer);
  applyTopIsolationLayer(ownerDocument);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const element of layer.isolated) release(element);
    layer.isolated = [];
    const index = isolationLayers.lastIndexOf(layer);
    if (index >= 0) isolationLayers.splice(index, 1);
    applyTopIsolationLayer(ownerDocument);
  };
}

/** Registers a modal in visual stacking order and removes it idempotently. */
export function registerModalLayer(
  element: HTMLElement,
  activeDocument: Document = document,
): () => void {
  if (element.ownerDocument !== activeDocument) {
    throw new TypeError('Modal layers must belong to the active document.');
  }
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
  if (element === null) return false;
  for (let index = modalLayers.length - 1; index >= 0; index -= 1) {
    const candidate = modalLayers[index];
    if (candidate.ownerDocument === element.ownerDocument) return candidate === element;
  }
  return false;
}
