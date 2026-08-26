import type {
  ProjectMapDiagnostic,
  ProjectMapEvidence,
  ProjectMapSpec,
  ProjectMapType,
} from './project-map';

export interface ProjectMapPoint {
  x: number;
  y: number;
}

export interface ProjectMapLayoutBand {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectMapLayoutNode {
  id: string;
  label: string;
  detail?: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: 'rectangle' | 'rounded' | 'pill' | 'diamond';
  textLines: readonly string[];
  emphasized: boolean;
  evidence: ProjectMapEvidence[];
}

export interface ProjectMapLayoutEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: string;
  points: ProjectMapPoint[];
  labelPoint: ProjectMapPoint;
  labelLines: readonly string[];
  labelWidth: number;
  labelHeight: number;
  emphasized: boolean;
  evidence: ProjectMapEvidence[];
}

export interface ProjectMapLayout {
  sceneVersion: 2;
  type: ProjectMapType;
  width: number;
  height: number;
  bands: ProjectMapLayoutBand[];
  nodes: ProjectMapLayoutNode[];
  edges: ProjectMapLayoutEdge[];
}

/** Canonical, deterministic scene consumed by both the native reader and export serializers. */
export type ProjectMapScene = ProjectMapLayout;

export interface ProjectMapLayoutResult {
  layout: ProjectMapLayout;
  diagnostics: ProjectMapDiagnostic[];
}

const CANVAS_PADDING = 32;
const BAND_LABEL_WIDTH = 110;
const BAND_GAP = 18;
const NODE_MIN_WIDTH = 176;
const NODE_MAX_WIDTH = 236;
const NODE_MIN_HEIGHT = 72;
const COLUMN_GAP = 48;
const ROW_GAP = 18;

function glyphWidth(character: string): number {
  return /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af]/u.test(character) ? 14 : 7.4;
}

function measuredWidth(value: string): number {
  return [...value].reduce((total, character) => total + glyphWidth(character), 0);
}

export function wrapProjectMapLabel(label: string, maximumWidth = NODE_MAX_WIDTH - 34): readonly string[] {
  const tokens = label.includes(' ') ? label.split(/\s+/u) : [...label];
  const separator = label.includes(' ') ? ' ' : '';
  const lines: string[] = [];
  for (const token of tokens) {
    const current = lines.at(-1) ?? '';
    const candidate = current ? `${current}${separator}${token}` : token;
    if (current && measuredWidth(candidate) > maximumWidth) lines.push(token);
    else if (lines.length === 0) lines.push(candidate);
    else lines[lines.length - 1] = candidate;
  }
  if (lines.length <= 3) return lines;
  const third = lines.slice(2).join(separator);
  let clipped = '';
  for (const character of third) {
    if (measuredWidth(`${clipped}${character}…`) > maximumWidth) break;
    clipped += character;
  }
  return [lines[0], lines[1], `${clipped}…`];
}

function nodeMetrics(label: string, density: ProjectMapSpec['layoutIntent']['density']): {
  readonly width: number;
  readonly height: number;
  readonly textLines: readonly string[];
} {
  const padding = density === 'compact' ? 28 : 36;
  const width = Math.max(NODE_MIN_WIDTH, Math.min(NODE_MAX_WIDTH, Math.ceil(measuredWidth(label) + padding)));
  const textLines = wrapProjectMapLabel(label, width - 30);
  return {
    width,
    height: Math.max(NODE_MIN_HEIGHT, 42 + textLines.length * 18),
    textLines,
  };
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function shapeFor(kind: string): ProjectMapLayoutNode['shape'] {
  if (kind === 'decision') return 'diamond';
  if (kind === 'initial' || kind === 'terminal') return 'pill';
  if (kind === 'store' || kind === 'boundary') return 'rounded';
  return 'rectangle';
}

function byNumberThenId<T>(numberOf: (value: T) => number): (left: T, right: T) => number {
  return (left, right) => numberOf(left) - numberOf(right)
    || compareText(String((left as { id?: string }).id), String((right as { id?: string }).id));
}

function center(node: ProjectMapLayoutNode): ProjectMapPoint {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

type RouteDirection = 'horizontal' | 'vertical' | 'start';

interface RouteCandidate {
  readonly point: ProjectMapPoint;
  readonly direction: RouteDirection;
  readonly cost: number;
  readonly score: number;
  readonly key: string;
}

function routeStateKey(xIndex: number, yIndex: number, direction: RouteDirection): string {
  return `${String(xIndex)}:${String(yIndex)}:${direction}`;
}

function heapPush(heap: RouteCandidate[], value: RouteCandidate): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentValue = heap[parent];
    if (!parentValue || parentValue.score <= value.score) break;
    heap[index] = parentValue;
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap: RouteCandidate[]): RouteCandidate | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    const left = index * 2 + 1;
    const right = left + 1;
    const leftValue = heap[left];
    const rightValue = heap[right];
    if (!leftValue) break;
    const child = rightValue && rightValue.score < leftValue.score ? right : left;
    const childValue = heap[child];
    if (!childValue || childValue.score >= last.score) break;
    heap[index] = childValue;
    index = child;
  }
  heap[index] = last;
  return first;
}

function routeSegmentClear(
  start: ProjectMapPoint,
  end: ProjectMapPoint,
  obstacles: readonly ProjectMapLayoutNode[],
  padding = 8,
): boolean {
  return !obstacles.some((node) => {
    const expanded: ProjectMapLayoutNode = {
      ...node,
      x: node.x - padding,
      y: node.y - padding,
      width: node.width + padding * 2,
      height: node.height + padding * 2,
    };
    return segmentCrossesNode(start, end, expanded)
      || pointInsideNode(start, expanded)
      || pointInsideNode(end, expanded);
  });
}

function simplifyRoute(points: readonly ProjectMapPoint[]): ProjectMapPoint[] {
  const deduplicated = points.filter((point, index) => index === 0
    || point.x !== points[index - 1]?.x
    || point.y !== points[index - 1]?.y);
  return deduplicated.filter((point, index) => {
    const previous = deduplicated[index - 1];
    const next = deduplicated[index + 1];
    if (!previous || !next) return true;
    return !((previous.x === point.x && point.x === next.x)
      || (previous.y === point.y && point.y === next.y));
  });
}

function obstacleAvoidingRoute(
  start: ProjectMapPoint,
  end: ProjectMapPoint,
  obstacles: readonly ProjectMapLayoutNode[],
): ProjectMapPoint[] | undefined {
  const outerRight = Math.max(start.x, end.x, ...obstacles.map((node) => node.x + node.width)) + 18;
  const outerBottom = Math.max(start.y, end.y, ...obstacles.map((node) => node.y + node.height)) + 18;
  const xs = [...new Set([
    14,
    start.x,
    end.x,
    outerRight,
    ...obstacles.flatMap((node) => [Math.max(14, node.x - 12), node.x + node.width + 12]),
  ])].sort((left, right) => left - right);
  const ys = [...new Set([
    14,
    start.y,
    end.y,
    outerBottom,
    ...obstacles.flatMap((node) => [Math.max(14, node.y - 12), node.y + node.height + 12]),
  ])].sort((left, right) => left - right);
  const startX = xs.indexOf(start.x);
  const startY = ys.indexOf(start.y);
  const endX = xs.indexOf(end.x);
  const endY = ys.indexOf(end.y);
  if (startX < 0 || startY < 0 || endX < 0 || endY < 0) return undefined;

  const startKey = routeStateKey(startX, startY, 'start');
  const heap: RouteCandidate[] = [];
  const best = new Map<string, number>([[startKey, 0]]);
  const previous = new Map<string, string>();
  const statePoint = new Map<string, ProjectMapPoint>([[startKey, start]]);
  heapPush(heap, { point: start, direction: 'start', cost: 0, score: 0, key: startKey });
  let finalKey: string | undefined;

  while (heap.length > 0) {
    const current = heapPop(heap);
    if (!current || current.cost !== best.get(current.key)) continue;
    const [xText, yText] = current.key.split(':');
    const xIndex = Number(xText);
    const yIndex = Number(yText);
    if (xIndex === endX && yIndex === endY) {
      finalKey = current.key;
      break;
    }
    for (const [nextX, nextY, direction] of [
      [xIndex - 1, yIndex, 'horizontal'],
      [xIndex + 1, yIndex, 'horizontal'],
      [xIndex, yIndex - 1, 'vertical'],
      [xIndex, yIndex + 1, 'vertical'],
    ] as const) {
      if (nextX < 0 || nextX >= xs.length || nextY < 0 || nextY >= ys.length) continue;
      const point = { x: xs[nextX] ?? 0, y: ys[nextY] ?? 0 };
      if (!routeSegmentClear(current.point, point, obstacles)) continue;
      const distance = Math.abs(point.x - current.point.x) + Math.abs(point.y - current.point.y);
      const turn = current.direction !== 'start' && current.direction !== direction ? 24 : 0;
      const cost = current.cost + distance + turn;
      const key = routeStateKey(nextX, nextY, direction);
      if (cost >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(key, cost);
      previous.set(key, current.key);
      statePoint.set(key, point);
      const heuristic = Math.abs(point.x - end.x) + Math.abs(point.y - end.y);
      heapPush(heap, { point, direction, cost, score: cost + heuristic, key });
    }
  }
  if (!finalKey) return undefined;
  const reversed: ProjectMapPoint[] = [];
  let cursor: string | undefined = finalKey;
  while (cursor) {
    const point = statePoint.get(cursor);
    if (point) reversed.push(point);
    cursor = previous.get(cursor);
  }
  return simplifyRoute(reversed.reverse());
}

function routedPoints(
  from: ProjectMapLayoutNode,
  to: ProjectMapLayoutNode,
  edgeIndex: number,
  obstacles: readonly ProjectMapLayoutNode[],
): ProjectMapPoint[] {
  const fromCenter = center(from);
  const toCenter = center(to);
  if (from.id === to.id) {
    const laneX = from.x + from.width + 42 + (edgeIndex % 3) * 10;
    return [
      { x: from.x + from.width, y: fromCenter.y - 12 },
      { x: laneX, y: fromCenter.y - 12 },
      { x: laneX, y: fromCenter.y + 12 },
      { x: from.x + from.width, y: fromCenter.y + 12 },
    ];
  }
  const horizontal = Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y) * 0.75;
  const start = horizontal
    ? { x: toCenter.x >= fromCenter.x ? from.x + from.width : from.x, y: fromCenter.y }
    : { x: fromCenter.x, y: toCenter.y >= fromCenter.y ? from.y + from.height : from.y };
  const end = horizontal
    ? { x: toCenter.x >= fromCenter.x ? to.x : to.x + to.width, y: toCenter.y }
    : { x: toCenter.x, y: toCenter.y >= fromCenter.y ? to.y : to.y + to.height };
  const blockers = obstacles.filter((obstacle) => obstacle.id !== from.id && obstacle.id !== to.id);
  return obstacleAvoidingRoute(start, end, blockers) ?? [start, end];
}

interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxesOverlap(left: LabelBox, right: LabelBox, padding = 4): boolean {
  return left.x < right.x + right.width + padding
    && left.x + left.width + padding > right.x
    && left.y < right.y + right.height + padding
    && left.y + left.height + padding > right.y;
}

function edgeLabelMetrics(label: string): {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
} {
  const lines = wrapProjectMapLabel(label, 132);
  return {
    lines,
    width: Math.max(32, Math.ceil(Math.max(...lines.map(measuredWidth)) * 0.8 + 14)),
    height: lines.length * 14 + 10,
  };
}

function edgeLabelPoint(
  points: readonly ProjectMapPoint[],
  labelWidth: number,
  labelHeight: number,
  obstacles: readonly ProjectMapLayoutNode[],
  occupied: readonly LabelBox[],
): ProjectMapPoint {
  const segments = points.slice(1).map((point, index) => {
    const start = points[index] ?? point;
    const horizontal = Math.abs(start.y - point.y) < 0.001;
    return {
      start,
      end: point,
      horizontal,
      length: horizontal ? Math.abs(start.x - point.x) : Math.abs(start.y - point.y),
    };
  });
  const candidates = segments.flatMap((segment) => [0.5, 0.25, 0.75].flatMap((fraction) => {
    const x = segment.start.x + (segment.end.x - segment.start.x) * fraction;
    const y = segment.start.y + (segment.end.y - segment.start.y) * fraction;
    return segment.horizontal
      ? [
          { point: { x, y: y - labelHeight / 2 - 6 }, length: segment.length },
          { point: { x, y: y + labelHeight / 2 + 6 }, length: segment.length },
        ]
      : [
          { point: { x: x - labelWidth / 2 - 6, y }, length: segment.length },
          { point: { x: x + labelWidth / 2 + 6, y }, length: segment.length },
        ];
  }));
  const score = (candidate: { point: ProjectMapPoint; length: number }): number => {
    const box = {
      x: candidate.point.x - labelWidth / 2,
      y: candidate.point.y - labelHeight / 2,
      width: labelWidth,
      height: labelHeight,
    };
    const nodePenalty = obstacles.filter((node) => boxesOverlap(box, node, 2)).length * 100_000;
    const labelPenalty = occupied.filter((other) => boxesOverlap(box, other, 7)).length * 60_000;
    const boundaryPenalty = box.x < 8 || box.y < 8 ? 30_000 : 0;
    return nodePenalty + labelPenalty + boundaryPenalty - candidate.length;
  };
  return candidates.sort((left, right) => score(left) - score(right))[0]?.point
    ?? (points[0] ?? { x: 0, y: 0 });
}

function createEdges(
  rawEdges: Array<{
    id: string;
    from: string;
    to: string;
    label: string;
    kind: string;
    evidence: ProjectMapEvidence[];
  }>,
  nodes: ProjectMapLayoutNode[],
  emphasisIds: ReadonlySet<string>,
): ProjectMapLayoutEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const occupied: LabelBox[] = [];
  return [...rawEdges]
    .sort((left, right) => compareText(left.id, right.id))
    .flatMap((edge, edgeIndex) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) return [];
      const points = routedPoints(from, to, edgeIndex, nodes);
      const label = edgeLabelMetrics(edge.label);
      const labelPoint = edgeLabelPoint(points, label.width, label.height, nodes, occupied);
      occupied.push({
        x: labelPoint.x - label.width / 2,
        y: labelPoint.y - label.height / 2,
        width: label.width,
        height: label.height,
      });
      return [{
        ...edge,
        points,
        labelPoint,
        labelLines: label.lines,
        labelWidth: label.width,
        labelHeight: label.height,
        emphasized: emphasisIds.has(edge.id) || (emphasisIds.has(edge.from) && emphasisIds.has(edge.to)),
      }];
    });
}

interface RankedItem {
  id: string;
  label: string;
  detail?: string;
  kind: string;
  bandId: string;
  rank: number;
  order: number;
  evidence: ProjectMapEvidence[];
}

function layoutRankedBands(
  type: ProjectMapType,
  rawBands: Array<{ id: string; label: string }>,
  rawItems: RankedItem[],
  rawEdges: Parameters<typeof createEdges>[0],
  intent: ProjectMapSpec['layoutIntent'],
  maximumColumns = Number.POSITIVE_INFINITY,
): ProjectMapLayout {
  const ranks = [...new Set(rawItems.map((item) => item.rank))].sort((left, right) => left - right);
  const columnOfRank = new Map(ranks.map((rank, index) => [rank, index % maximumColumns]));
  const columns = [...new Set(columnOfRank.values())].sort((left, right) => left - right);
  const metricsById = new Map(rawItems.map((item) => [item.id, nodeMetrics(item.label, intent.density)]));
  const columnWidths = columns.map((column) => Math.max(
    NODE_MIN_WIDTH,
    ...rawItems.filter((item) => columnOfRank.get(item.rank) === column)
      .map((item) => metricsById.get(item.id)?.width ?? NODE_MIN_WIDTH),
  ));
  const columnX = new Map<number, number>();
  let nextX = CANVAS_PADDING + BAND_LABEL_WIDTH;
  for (const [index, column] of columns.entries()) {
    columnX.set(column, nextX);
    nextX += (columnWidths[index] ?? NODE_MIN_WIDTH) + COLUMN_GAP;
  }
  const bandMetrics = rawBands.map((band) => {
    const items = rawItems.filter((item) => item.bandId === band.id);
    const maximumStackHeight = Math.max(NODE_MIN_HEIGHT, ...columns.map((column) => {
      const stack = items.filter((item) => columnOfRank.get(item.rank) === column);
      return stack.reduce((total, item) => total + (metricsById.get(item.id)?.height ?? NODE_MIN_HEIGHT), 0)
        + Math.max(0, stack.length - 1) * ROW_GAP;
    }));
    return { ...band, height: 58 + maximumStackHeight + 18 };
  });
  let nextY = CANVAS_PADDING;
  const width = Math.max(720, nextX - COLUMN_GAP + CANVAS_PADDING);
  const bands = bandMetrics.map((band) => {
    const laidOut = { ...band, x: CANVAS_PADDING, y: nextY, width: width - CANVAS_PADDING * 2, height: band.height };
    nextY += band.height + BAND_GAP;
    return laidOut;
  });
  const bandById = new Map(bands.map((band) => [band.id, band]));
  const nodes = rawItems
    .flatMap((item) => {
      const band = bandById.get(item.bandId);
      const column = columnOfRank.get(item.rank);
      if (!band || column === undefined) return [];
      const peers = rawItems
        .filter((candidate) => candidate.bandId === item.bandId
          && columnOfRank.get(candidate.rank) === column)
        .sort((left, right) => left.rank - right.rank || byNumberThenId<RankedItem>((candidate) => candidate.order)(left, right));
      const slot = peers.findIndex((candidate) => candidate.id === item.id);
      const metrics = metricsById.get(item.id) ?? nodeMetrics(item.label, intent.density);
      const stackOffset = peers.slice(0, slot).reduce((total, peer) =>
        total + (metricsById.get(peer.id)?.height ?? NODE_MIN_HEIGHT) + ROW_GAP, 0);
      return [{
        id: item.id,
        label: item.label,
        detail: item.detail,
        kind: item.kind,
        x: columnX.get(column) ?? CANVAS_PADDING + BAND_LABEL_WIDTH + column * (NODE_MIN_WIDTH + COLUMN_GAP),
        y: band.y + 48 + stackOffset,
        width: metrics.width,
        height: metrics.height,
        shape: shapeFor(item.kind),
        textLines: metrics.textLines,
        emphasized: intent.emphasisIds.includes(item.id),
        evidence: item.evidence,
      } satisfies ProjectMapLayoutNode];
    })
    .sort((left, right) => left.y - right.y || left.x - right.x || compareText(left.id, right.id));
  return {
    sceneVersion: 2,
    type,
    width,
    height: nextY - BAND_GAP + CANVAS_PADDING,
    bands,
    nodes,
    edges: createEdges(rawEdges, nodes, new Set(intent.emphasisIds)),
  };
}

function layoutArchitecture(spec: Extract<ProjectMapSpec, { type: 'architecture' }>): ProjectMapLayout {
  return layoutRankedBands(
    spec.type,
    spec.groups,
    spec.nodes.map((node) => ({ ...node, bandId: node.group })),
    spec.relations,
    spec.layoutIntent,
    4,
  );
}

function layoutWorkflow(spec: Extract<ProjectMapSpec, { type: 'workflow' }>): ProjectMapLayout {
  return layoutRankedBands(
    spec.type,
    spec.lanes,
    spec.steps.map((step) => ({ ...step, bandId: step.lane })),
    spec.transitions,
    spec.layoutIntent,
    4,
  );
}

function layoutDataflow(spec: Extract<ProjectMapSpec, { type: 'dataflow' }>): ProjectMapLayout {
  return layoutRankedBands(
    spec.type,
    spec.stages,
    spec.entities.map((entity) => ({ ...entity, bandId: entity.stage, rank: entity.order })),
    spec.flows,
    spec.layoutIntent,
    4,
  );
}

function layoutLifecycle(spec: Extract<ProjectMapSpec, { type: 'lifecycle' }>): ProjectMapLayout {
  return layoutRankedBands(
    spec.type,
    spec.phases,
    spec.states.map((state) => ({ ...state, bandId: state.phase, rank: state.order })),
    spec.transitions.map((transition) => ({ ...transition, label: transition.event })),
    spec.layoutIntent,
  );
}

function layoutSequence(spec: Extract<ProjectMapSpec, { type: 'sequence' }>): ProjectMapLayout {
  const participantGap = 72;
  const headerY = CANVAS_PADDING;
  const participantMetrics = spec.participants.map((participant) => nodeMetrics(participant.label, spec.layoutIntent.density));
  const headerHeight = Math.max(NODE_MIN_HEIGHT, ...participantMetrics.map((metrics) => metrics.height));
  const messageStartY = headerY + headerHeight + 72;
  const messageGap = 66;
  const participants = [...spec.participants];
  let participantX = CANVAS_PADDING;
  const nodes = participants.map((participant, index) => {
    const metrics = participantMetrics[index] ?? nodeMetrics(participant.label, spec.layoutIntent.density);
    const node = {
      id: participant.id,
      label: participant.label,
      kind: participant.kind,
      x: participantX,
      y: headerY,
      width: metrics.width,
      height: metrics.height,
      shape: shapeFor(participant.kind),
      textLines: metrics.textLines,
      emphasized: spec.layoutIntent.emphasisIds.includes(participant.id),
      evidence: participant.evidence,
    } satisfies ProjectMapLayoutNode;
    participantX += metrics.width + participantGap;
    return node;
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const orderedMessages = [...spec.messages].sort(byNumberThenId((message) => message.order));
  const edges = orderedMessages.flatMap((message, index) => {
    const from = nodeById.get(message.from);
    const to = nodeById.get(message.to);
    if (!from || !to) return [];
    const y = messageStartY + index * messageGap;
    const fromX = from.x + from.width / 2;
    const toX = to.x + to.width / 2;
    const points = message.from === message.to
      ? [
          { x: fromX, y },
          { x: fromX + 64, y },
          { x: fromX + 64, y: y + 32 },
          { x: fromX, y: y + 32 },
        ]
      : [
          { x: fromX, y },
          { x: toX, y },
        ];
    const label = edgeLabelMetrics(message.label);
    return [{
      id: message.id,
      from: message.from,
      to: message.to,
      label: message.label,
      kind: message.kind,
      points,
      labelPoint: message.from === message.to
        ? { x: fromX + 64 + label.width / 2 + 6, y: y + 16 }
        : { x: (fromX + toX) / 2, y: y - label.height / 2 - 6 },
      labelLines: label.lines,
      labelWidth: label.width,
      labelHeight: label.height,
      emphasized: spec.layoutIntent.emphasisIds.includes(message.id),
      evidence: message.evidence,
    } satisfies ProjectMapLayoutEdge];
  });
  const width = Math.max(720, participantX - participantGap + CANVAS_PADDING);
  const height = messageStartY + orderedMessages.length * messageGap + CANVAS_PADDING;
  const bands = nodes.map((node) => ({
    id: `${node.id}-lifeline`,
    label: '',
    x: node.x + node.width / 2,
    y: node.y + node.height,
    width: 1,
    height: height - node.y - node.height - CANVAS_PADDING,
  }));
  return { sceneVersion: 2, type: spec.type, width, height, bands, nodes, edges };
}

function rectanglesOverlap(left: ProjectMapLayoutNode, right: ProjectMapLayoutNode): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function pointInsideNode(point: ProjectMapPoint, node: ProjectMapLayoutNode, padding = 0): boolean {
  return point.x > node.x - padding
    && point.x < node.x + node.width + padding
    && point.y > node.y - padding
    && point.y < node.y + node.height + padding;
}

function segmentCrossesNode(
  start: ProjectMapPoint,
  end: ProjectMapPoint,
  node: ProjectMapLayoutNode,
): boolean {
  if (Math.abs(start.x - end.x) < 0.1) {
    return start.x > node.x && start.x < node.x + node.width
      && Math.max(start.y, end.y) > node.y
      && Math.min(start.y, end.y) < node.y + node.height;
  }
  if (Math.abs(start.y - end.y) < 0.1) {
    return start.y > node.y && start.y < node.y + node.height
      && Math.max(start.x, end.x) > node.x
      && Math.min(start.x, end.x) < node.x + node.width;
  }
  return false;
}

export function projectMapLayoutDiagnostics(layout: ProjectMapLayout): ProjectMapDiagnostic[] {
  const diagnostics: ProjectMapDiagnostic[] = [];
  for (const node of layout.nodes) {
    if (node.textLines.at(-1)?.endsWith('\u2026')) {
      diagnostics.push({
        severity: 'warning',
        code: 'layout.dense-label',
        subject: node.id,
        message: 'Label or detail may be visually dense at the default zoom.',
      });
    }
    if (node.x < 0 || node.y < 0 || node.x + node.width > layout.width || node.y + node.height > layout.height) {
      diagnostics.push({
        severity: 'error',
        code: 'containment.node-outside-scene',
        subject: node.id,
        message: 'A semantic node extends outside the deterministic scene.',
      });
    }
    if (node.textLines.length < 1 || node.textLines.some((line) => line.trim().length === 0)) {
      diagnostics.push({
        severity: 'error',
        code: 'accessibility.empty-label',
        subject: node.id,
        message: 'A semantic node has no readable label.',
      });
    }
  }
  for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex += 1) {
      const left = layout.nodes[leftIndex];
      const right = layout.nodes[rightIndex];
      if (rectanglesOverlap(left, right)) {
        diagnostics.push({
          severity: 'error',
          code: 'layout.node-overlap',
          subject: `${left.id},${right.id}`,
          message: 'Deterministic layout placed two semantic nodes on top of each other.',
        });
      }
    }
  }
  const nodeIds = new Set(layout.nodes.map((node) => node.id));
  for (const edge of layout.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.points.length < 2) {
      diagnostics.push({
        severity: 'error',
        code: 'layout.invalid-edge',
        subject: edge.id,
        message: 'Layout edge has a missing endpoint or route.',
      });
    }
    if (!Number.isFinite(edge.labelPoint.x) || !Number.isFinite(edge.labelPoint.y)) {
      diagnostics.push({
        severity: 'error',
        code: 'labels.invalid-position',
        subject: edge.id,
        message: 'Edge label position is not finite.',
      });
    }
    const crossings = layout.nodes.filter((node) => node.id !== edge.from && node.id !== edge.to
      && edge.points.some((point, index) => index > 0
        && segmentCrossesNode(edge.points[index - 1], point, node)));
    if (crossings.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'routes.node-intersection',
        subject: edge.id,
        message: `Edge route intersects ${crossings.map((node) => node.id).join(', ')}.`,
      });
    }
    const labelBox: LabelBox = {
      x: edge.labelPoint.x - edge.labelWidth / 2,
      y: edge.labelPoint.y - edge.labelHeight / 2,
      width: edge.labelWidth,
      height: edge.labelHeight,
    };
    const labelCollision = layout.nodes.find((node) => node.id !== edge.from && node.id !== edge.to
      && boxesOverlap(labelBox, node, 6));
    if (labelCollision) {
      diagnostics.push({
        severity: 'warning',
        code: 'labels.node-collision',
        subject: edge.id,
        message: `Edge label is close to ${labelCollision.id}.`,
      });
    }
  }
  return diagnostics;
}

export function layoutProjectMap(spec: ProjectMapSpec): ProjectMapLayoutResult {
  let layout: ProjectMapLayout;
  switch (spec.type) {
    case 'architecture':
      layout = layoutArchitecture(spec);
      break;
    case 'workflow':
      layout = layoutWorkflow(spec);
      break;
    case 'sequence':
      layout = layoutSequence(spec);
      break;
    case 'dataflow':
      layout = layoutDataflow(spec);
      break;
    case 'lifecycle':
      layout = layoutLifecycle(spec);
      break;
  }
  return { layout, diagnostics: projectMapLayoutDiagnostics(layout) };
}
