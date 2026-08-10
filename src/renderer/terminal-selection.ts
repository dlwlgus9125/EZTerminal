export function selectedTextWithin(
  root: Element | null,
  selection?: Selection | null,
): string {
  if (!root) return '';
  const resolvedSelection = selection === undefined
    ? root.ownerDocument.defaultView?.getSelection() ?? null
    : selection;
  if (
    !resolvedSelection
    || resolvedSelection.isCollapsed
    || !resolvedSelection.anchorNode
    || !resolvedSelection.focusNode
  ) {
    return '';
  }
  if (
    !root.contains(resolvedSelection.anchorNode)
    || !root.contains(resolvedSelection.focusNode)
  ) {
    return '';
  }
  return resolvedSelection.toString();
}
