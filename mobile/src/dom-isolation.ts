interface IsolationState {
  readonly ariaHidden: string | null;
  readonly inert: boolean;
  readonly inertAttribute: boolean;
  readonly owners: Set<symbol>;
}

const isolationStates = new WeakMap<HTMLElement, IsolationState>();

/**
 * Applies modal/page isolation without allowing one overlay owner to clear
 * another owner's `inert` and `aria-hidden` state.
 */
export function setElementIsolated(
  element: HTMLElement,
  owner: symbol,
  isolated: boolean,
): void {
  let state = isolationStates.get(element);

  if (isolated) {
    if (!state) {
      state = {
        ariaHidden: element.getAttribute('aria-hidden'),
        inert: element.inert,
        inertAttribute: element.hasAttribute('inert'),
        owners: new Set<symbol>(),
      };
      isolationStates.set(element, state);
    }
    state.owners.add(owner);
    element.inert = true;
    element.toggleAttribute('inert', true);
    element.setAttribute('aria-hidden', 'true');
    return;
  }

  if (!state) return;
  state.owners.delete(owner);
  if (state.owners.size > 0) return;

  element.inert = state.inert;
  element.toggleAttribute('inert', state.inertAttribute);
  if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', state.ariaHidden);
  isolationStates.delete(element);
}
