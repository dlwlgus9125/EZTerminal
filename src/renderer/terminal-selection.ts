export function selectedTextWithin(
  root: Element | null,
  selection: Selection | null = window.getSelection(),
): string {
  if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return '';
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return '';
  return selection.toString();
}
