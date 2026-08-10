import type { ForwardedRef, MutableRefObject, Ref } from 'react';

/**
 * Dockview adopts live nodes into auxiliary documents. Their ownerDocument
 * changes, but their JavaScript prototype can remain in the creating realm,
 * so cross-window DOM guards must be structural rather than instanceof.
 */
export function isDomNode(value: unknown): value is Node {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Node>;
  return typeof candidate.nodeType === 'number' && typeof candidate.nodeName === 'string';
}

export function isDomElement(value: unknown): value is Element {
  return isDomNode(value)
    && value.nodeType === 1
    && typeof (value as Partial<Element>).closest === 'function';
}

export function isFocusableHTMLElement(value: unknown): value is HTMLElement {
  return isDomElement(value) && typeof (value as Partial<HTMLElement>).focus === 'function';
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    (ref as MutableRefObject<T | null>).current = value;
  }
}

export function mergeRefs<T>(...refs: Array<ForwardedRef<T> | undefined>): (value: T | null) => void {
  return (value) => {
    for (const ref of refs) assignRef(ref, value);
  };
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
        'textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not([aria-disabled="true"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}
