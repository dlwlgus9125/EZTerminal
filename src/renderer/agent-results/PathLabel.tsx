/**
 * A path whose folder part shortens first, so the file name stays readable in
 * a narrow list. Assistive technology reads the whole path as one piece.
 */
export function PathLabel({ path, className = 'results-file__path' }: { readonly path: string; readonly className?: string }): JSX.Element {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const folder = index >= 0 ? path.slice(0, index + 1) : '';
  const name = index >= 0 ? path.slice(index + 1) : path;
  return (
    <span className={className} title={path}>
      {folder && <span className="results-path__folder" aria-hidden="true">{folder}</span>}
      <span className="results-path__name" aria-hidden="true">{name}</span>
      <span className="results-visually-hidden">{path}</span>
    </span>
  );
}
