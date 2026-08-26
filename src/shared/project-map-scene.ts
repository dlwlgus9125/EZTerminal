import type {
  ProjectMapDiff,
  ProjectMapDocument,
  ProjectMapEvidence,
  ProjectMapSemanticChange,
  ProjectMapSpec,
} from './project-map';

export interface ProjectMapExportPalette {
  readonly background: string;
  readonly surface: string;
  readonly band: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly warning: string;
  readonly danger: string;
}

export const PROJECT_MAP_EXPORT_PALETTES = {
  dark: {
    background: '#07110d',
    surface: '#101c17',
    band: '#0b1712',
    border: '#315344',
    text: '#e8f3ed',
    muted: '#9ab5a7',
    accent: '#56d694',
    warning: '#d6b45a',
    danger: '#e06c75',
  },
  light: {
    background: '#eef4f0',
    surface: '#ffffff',
    band: '#e3ede7',
    border: '#769487',
    text: '#15231c',
    muted: '#526b60',
    accent: '#147a4b',
    warning: '#8a6515',
    danger: '#a33b43',
  },
} as const satisfies Readonly<Record<'dark' | 'light', ProjectMapExportPalette>>;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function semanticRecords(spec: ProjectMapSpec): ReadonlyMap<string, Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [{
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    contentLocale: spec.contentLocale,
    layoutIntent: spec.layoutIntent,
    chapters: spec.chapters,
  }];
  switch (spec.type) {
    case 'architecture': values.push(...spec.nodes, ...spec.relations); break;
    case 'workflow': values.push(...spec.steps, ...spec.transitions); break;
    case 'sequence': values.push(...spec.participants, ...spec.messages); break;
    case 'dataflow': values.push(...spec.entities, ...spec.flows); break;
    case 'lifecycle': values.push(...spec.states, ...spec.transitions); break;
  }
  return new Map(values.map((value) => [String(value.id), value]));
}

function changedFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  includeEvidence: boolean,
): readonly string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => includeEvidence ? field === 'evidence' : field !== 'evidence')
    .filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]))
    .sort();
}

function diffRecords(
  from: ReadonlyMap<string, Record<string, unknown>>,
  to: ReadonlyMap<string, Record<string, unknown>>,
  evidence: boolean,
): ProjectMapSemanticChange[] {
  const changes: ProjectMapSemanticChange[] = [];
  for (const id of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const left = from.get(id);
    const right = to.get(id);
    if (!left) changes.push({ kind: 'added', id, fields: evidence ? ['evidence'] : Object.keys(right!).filter((key) => key !== 'evidence').sort() });
    else if (!right) changes.push({ kind: 'removed', id, fields: evidence ? ['evidence'] : Object.keys(left).filter((key) => key !== 'evidence').sort() });
    else {
      const fields = changedFields(left, right, evidence);
      if (fields.length > 0) changes.push({ kind: 'changed', id, fields });
    }
  }
  return changes;
}

export function diffProjectMapDocuments(
  from: ProjectMapDocument,
  to: ProjectMapDocument,
): ProjectMapDiff {
  const left = semanticRecords(from.spec);
  const right = semanticRecords(to.spec);
  return {
    fromFingerprint: from.verification.fingerprint,
    toFingerprint: to.verification.fingerprint,
    semantic: diffRecords(left, right, false),
    evidence: diffRecords(left, right, true),
  };
}

function shapeMarkup(
  node: ProjectMapDocument['layout']['nodes'][number],
  palette: ProjectMapExportPalette,
): string {
  const stroke = node.emphasized ? palette.accent : palette.border;
  const common = `fill="${palette.surface}" stroke="${stroke}" stroke-width="${node.emphasized ? '2.5' : '1.5'}"`;
  if (node.shape === 'diamond') {
    return `<path d="M ${node.x + node.width / 2} ${node.y} L ${node.x + node.width} ${node.y + node.height / 2} L ${node.x + node.width / 2} ${node.y + node.height} L ${node.x} ${node.y + node.height / 2} Z" ${common}/>`;
  }
  const radius = node.shape === 'pill' ? node.height / 2 : node.shape === 'rounded' ? 12 : 5;
  return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${radius}" ${common}/>`;
}

export function serializeProjectMapSvg(
  document: ProjectMapDocument,
  theme: 'light' | 'dark',
  viewport = { width: 1600, height: 900 },
): { readonly svg: string; readonly palette: ProjectMapExportPalette } {
  const palette = PROJECT_MAP_EXPORT_PALETTES[theme];
  const scene = document.layout;
  const headerHeight = 104;
  const availableWidth = viewport.width - 96;
  const availableHeight = viewport.height - headerHeight - 52;
  const scale = Math.min(1.45, availableWidth / scene.width, availableHeight / scene.height);
  const offsetX = (viewport.width - scene.width * scale) / 2;
  const offsetY = headerHeight + Math.max(0, (availableHeight - scene.height * scale) / 2);
  const marker = `pm-arrow-${document.mapId}`;
  const bands = scene.bands.map((band) => band.width <= 1
    ? `<line x1="${band.x}" y1="${band.y}" x2="${band.x}" y2="${band.y + band.height}" stroke="${palette.border}" stroke-dasharray="5 7"/>`
    : `<g><rect x="${band.x}" y="${band.y}" width="${band.width}" height="${band.height}" rx="12" fill="${palette.band}" stroke="${palette.border}" stroke-opacity=".75"/><text x="${band.x + 16}" y="${band.y + 28}" fill="${palette.muted}" font-size="14" font-weight="600">${escapeXml(band.label)}</text></g>`)
    .join('');
  const edges = scene.edges.map((edge) => {
    const points = edge.points.map((point) => `${point.x},${point.y}`).join(' ');
    const color = edge.kind === 'error' ? palette.danger : edge.emphasized ? palette.accent : palette.border;
    const labelStart = edge.labelPoint.y - ((edge.labelLines.length - 1) * 7) + 4;
    const label = edge.labelLines.map((line, index) => `<tspan x="${edge.labelPoint.x}" dy="${index === 0 ? '0' : '14'}">${escapeXml(line)}</tspan>`).join('');
    return `<g><polyline points="${points}" fill="none" stroke="${color}" stroke-width="${edge.emphasized ? '2.5' : '1.7'}" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${marker})"/><rect x="${edge.labelPoint.x - edge.labelWidth / 2}" y="${edge.labelPoint.y - edge.labelHeight / 2}" width="${edge.labelWidth}" height="${edge.labelHeight}" rx="4" fill="${palette.background}" fill-opacity=".94"/><text x="${edge.labelPoint.x}" y="${labelStart}" fill="${palette.muted}" font-size="12" text-anchor="middle">${label}</text></g>`;
  }).join('');
  const nodes = scene.nodes.map((node) => {
    const lineStart = node.y + node.height / 2 - ((node.textLines.length - 1) * 9);
    const labels = node.textLines.map((line, index) => `<tspan x="${node.x + node.width / 2}" dy="${index === 0 ? '0' : '18'}">${escapeXml(line)}</tspan>`).join('');
    return `<g>${shapeMarkup(node, palette)}<text x="${node.x + node.width / 2}" y="${lineStart}" fill="${palette.text}" font-size="14" font-weight="600" text-anchor="middle" dominant-baseline="middle">${labels}</text></g>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}" role="img" aria-labelledby="pm-title pm-desc"><title id="pm-title">${escapeXml(document.spec.title)}</title><desc id="pm-desc">${escapeXml(document.spec.summary)}</desc><rect width="100%" height="100%" fill="${palette.background}"/><text x="48" y="48" fill="${palette.text}" font-family="system-ui, sans-serif" font-size="24" font-weight="700">${escapeXml(document.spec.title)}</text><text x="48" y="76" fill="${palette.muted}" font-family="system-ui, sans-serif" font-size="14">${escapeXml(document.spec.summary)}</text><text x="1552" y="48" fill="${palette.accent}" font-family="ui-monospace, monospace" font-size="12" text-anchor="end">VERIFIED ${escapeXml(document.verification.fingerprint.slice(7, 19))}</text><defs><marker id="${marker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="${palette.accent}"/></marker></defs><g transform="translate(${offsetX} ${offsetY}) scale(${scale})" font-family="system-ui, sans-serif">${bands}${edges}${nodes}</g></svg>`;
  return { svg, palette };
}

export function projectMapEvidenceById(spec: ProjectMapSpec): ReadonlyMap<string, readonly ProjectMapEvidence[]> {
  return new Map([...semanticRecords(spec)].map(([id, value]) => [id, (value.evidence ?? []) as ProjectMapEvidence[]]));
}
