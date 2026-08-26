import { z } from 'zod';

export const PROJECT_MAP_SCHEMA_VERSION = 2 as const;
export const PROJECT_MAP_QUALITY_GATE_VERSION = 3 as const;
export const MAX_PROJECT_MAP_SOURCE_BYTES = 256 * 1024;
export const MAX_PROJECT_MAPS = 16;
export const MAX_PROJECT_MAP_ROOTS = 32;
export const MAX_PROJECT_MAP_CHAPTERS = 5;
export const MAX_PROJECT_MAP_PRIMARY_ITEMS = 16;

export const PROJECT_MAP_TYPES = [
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
] as const;

export type ProjectMapType = (typeof PROJECT_MAP_TYPES)[number];
export type ProjectMapQualityProfile = 'draft' | 'production';
export type ProjectMapContentLocale = 'ko' | 'en';

export interface ProjectMapInputVersionRecord {
  readonly rootAlias: string;
  readonly relativePath: string;
  readonly version: string;
}

export function normalizeProjectMapInputText(content: string): string {
  return content.replace(/\r\n?/gu, '\n');
}

function compareProjectMapInputText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function serializeProjectMapInputVersions(
  records: readonly ProjectMapInputVersionRecord[],
): string {
  return [...records]
    .sort((left, right) => compareProjectMapInputText(left.rootAlias, right.rootAlias)
      || compareProjectMapInputText(left.relativePath, right.relativePath))
    .map((record) => `${record.rootAlias}\u0000${record.relativePath}\u0000${record.version}`)
    .join('\n');
}

export interface ProjectMapAuthoringGuide {
  readonly type: ProjectMapType;
  readonly source: {
    readonly manifest: '.ezterminal/project-map/manifest.json';
    readonly maps: '.ezterminal/project-map/maps/<map-id>.<type>.json';
  };
  readonly invariants: readonly string[];
  readonly evidenceDigest: string;
  readonly inputDigest: string;
  readonly modeContract: readonly string[];
  readonly checklist: readonly string[];
}

export function projectMapAuthoringGuide(type: ProjectMapType): ProjectMapAuthoringGuide {
  const modeContract: Readonly<Record<ProjectMapType, readonly string[]>> = {
    architecture: [
      'Declare bounded groups, ranked nodes, explicit relations, and one connected mainPath.',
      'Use architecture for stable ownership and dependency boundaries, not chronological events.',
    ],
    workflow: [
      'Declare actor lanes, ranked actions/decisions/reviews/results, transitions, and one connected mainPath.',
      'Use workflow for human or system work and decision ownership.',
    ],
    sequence: [
      'Declare 2..8 participants and messages with unique order values.',
      'Use sequence for chronological calls, returns, events, and failure responses.',
    ],
    dataflow: [
      'Declare processing stages, ordered data entities, flows, and one connected primaryPath.',
      'Use dataflow for data shape/movement/transformation, not component ownership.',
    ],
    lifecycle: [
      'Declare phases, ordered states, an initialState, and event-labelled transitions.',
      'Use lifecycle for state changes and recovery/terminal behavior.',
    ],
  };
  return {
    type,
    source: {
      manifest: '.ezterminal/project-map/manifest.json',
      maps: '.ezterminal/project-map/maps/<map-id>.<type>.json',
    },
    invariants: [
      'Repository source is authoritative; EZTerminal never writes or merges it.',
      'Use only manifest root aliases and portable POSIX-style relative paths.',
      'Do not add pixel coordinates, executable content, HTML, CSS, remote URLs, or app-local IDs.',
      'Declare contentLocale and semantic layoutIntent only; the native renderer owns geometry and routing.',
      `Keep semantic primary elements at or below ${String(MAX_PROJECT_MAP_PRIMARY_ITEMS)} and chapters at or below ${String(MAX_PROJECT_MAP_CHAPTERS)}.`,
      'Every semantic item and relation/message/transition needs 1..3 evidence anchors.',
    ],
    evidenceDigest: 'sha256 of the exact inclusive line range after CRLF/CR is normalized to LF, with selected lines joined by LF and no added trailing newline.',
    inputDigest: 'sha256 of sorted rootAlias\\0relativePath\\0fileVersion records joined by LF; fileVersion is sha256 of UTF-8 source after CRLF/CR is normalized to LF.',
    modeContract: modeContract[type],
    checklist: [
      'Read the current manifest, the target map, every authoritative input, and every evidence range.',
      'Update claims and anchors; then update each anchor lineDigest.',
      'Recompute review.inputDigest and choose map-updated, or no-semantic-impact with a concrete reason.',
      'Run ezterminal-agent map check <map-id> --quality draft, then --quality production, and resolve every diagnostic.',
      'Report source changes and verification to the human; do not commit or merge automatically.',
    ],
  };
}

const PortableIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const TitleSchema = z.string().trim().min(1).max(96);
const SummarySchema = z.string().trim().min(1).max(280);
function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
const RelativePathSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'must not have leading or trailing whitespace')
  .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\'), 'must be relative')
  .refine((value) => !/^[a-zA-Z]:/.test(value), 'must not contain a drive prefix')
  .refine((value) => !value.includes('\\'), 'must use POSIX separators')
  .refine((value) => !value.split('/').includes('..'), 'must not traverse outside the root')
  .refine(
    (value) => value.split('/').every((segment) => segment.length > 0 && segment !== '.'),
    'must not contain empty or current-directory segments',
  );
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ProjectMapEvidenceSchema = z.strictObject({
  rootAlias: PortableIdSchema,
  relativePath: RelativePathSchema,
  startLine: z.number().int().min(1).max(10_000_000),
  endLine: z.number().int().min(1).max(10_000_000),
  lineDigest: Sha256Schema,
  claim: z.string().trim().min(1).max(240),
});

export type ProjectMapEvidence = z.infer<typeof ProjectMapEvidenceSchema>;

const EvidenceListSchema = z.array(ProjectMapEvidenceSchema).min(1).max(3);
const ChapterSchema = z.strictObject({
  id: PortableIdSchema,
  title: TitleSchema,
  summary: SummarySchema,
  focusIds: z.array(PortableIdSchema).min(1).max(8),
});

const LayoutIntentSchema = z.strictObject({
  density: z.enum(['balanced', 'compact']),
  emphasisIds: z.array(PortableIdSchema).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
});

const CommonMapFields = {
  schemaVersion: z.literal(PROJECT_MAP_SCHEMA_VERSION),
  id: PortableIdSchema,
  title: TitleSchema,
  summary: SummarySchema,
  contentLocale: z.enum(['ko', 'en']),
  layoutIntent: LayoutIntentSchema,
  chapters: z.array(ChapterSchema).max(MAX_PROJECT_MAP_CHAPTERS).default([]),
};

const RelationSchema = z.strictObject({
  id: PortableIdSchema,
  from: PortableIdSchema,
  to: PortableIdSchema,
  label: z.string().trim().min(1).max(64),
  kind: z.enum(['primary', 'secondary', 'optional', 'error']),
  evidence: EvidenceListSchema,
});

export const ArchitectureMapSpecSchema = z.strictObject({
  ...CommonMapFields,
  type: z.literal('architecture'),
  groups: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
  })).min(1).max(8),
  nodes: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
    detail: z.string().trim().min(1).max(180).optional(),
    kind: z.enum(['surface', 'service', 'store', 'boundary', 'runtime']),
    group: PortableIdSchema,
    rank: z.number().int().min(0).max(15),
    order: z.number().int().min(0).max(15),
    evidence: EvidenceListSchema,
  })).min(1).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
  relations: z.array(RelationSchema).max(32),
  mainPath: z.array(PortableIdSchema).min(2).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
});

export const WorkflowMapSpecSchema = z.strictObject({
  ...CommonMapFields,
  type: z.literal('workflow'),
  lanes: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
  })).min(1).max(8),
  steps: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
    detail: z.string().trim().min(1).max(180).optional(),
    kind: z.enum(['action', 'decision', 'review', 'result']),
    lane: PortableIdSchema,
    rank: z.number().int().min(0).max(15),
    order: z.number().int().min(0).max(15),
    evidence: EvidenceListSchema,
  })).min(1).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
  transitions: z.array(RelationSchema).max(32),
  mainPath: z.array(PortableIdSchema).min(2).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
});

export const SequenceMapSpecSchema = z.strictObject({
  ...CommonMapFields,
  type: z.literal('sequence'),
  participants: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
    kind: z.enum(['person', 'surface', 'service', 'runtime', 'system']),
    evidence: EvidenceListSchema,
  })).min(2).max(8),
  messages: z.array(z.strictObject({
    id: PortableIdSchema,
    from: PortableIdSchema,
    to: PortableIdSchema,
    label: TitleSchema,
    detail: z.string().trim().min(1).max(180).optional(),
    kind: z.enum(['call', 'return', 'event', 'error']),
    order: z.number().int().min(0).max(31),
    evidence: EvidenceListSchema,
  })).min(1).max(32),
});

export const DataflowMapSpecSchema = z.strictObject({
  ...CommonMapFields,
  type: z.literal('dataflow'),
  stages: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
  })).min(1).max(8),
  entities: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
    detail: z.string().trim().min(1).max(180).optional(),
    kind: z.enum(['source', 'transform', 'store', 'sink', 'boundary']),
    stage: PortableIdSchema,
    order: z.number().int().min(0).max(15),
    evidence: EvidenceListSchema,
  })).min(1).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
  flows: z.array(RelationSchema).max(32),
  primaryPath: z.array(PortableIdSchema).min(2).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
});

export const LifecycleMapSpecSchema = z.strictObject({
  ...CommonMapFields,
  type: z.literal('lifecycle'),
  phases: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
  })).min(1).max(8),
  states: z.array(z.strictObject({
    id: PortableIdSchema,
    label: TitleSchema,
    detail: z.string().trim().min(1).max(180).optional(),
    kind: z.enum(['initial', 'steady', 'transient', 'terminal', 'error']),
    phase: PortableIdSchema,
    order: z.number().int().min(0).max(15),
    evidence: EvidenceListSchema,
  })).min(1).max(MAX_PROJECT_MAP_PRIMARY_ITEMS),
  transitions: z.array(RelationSchema.extend({
    event: z.string().trim().min(1).max(64),
  })).max(32),
  initialState: PortableIdSchema,
});

export const ProjectMapSpecSchema = z.discriminatedUnion('type', [
  ArchitectureMapSpecSchema,
  WorkflowMapSpecSchema,
  SequenceMapSpecSchema,
  DataflowMapSpecSchema,
  LifecycleMapSpecSchema,
]);

const AuthoritativeInputSchema = z.strictObject({
  rootAlias: PortableIdSchema,
  relativePath: RelativePathSchema,
});

export const ProjectMapManifestSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_MAP_SCHEMA_VERSION),
  collectionId: PortableIdSchema,
  ownerRootAlias: PortableIdSchema,
  overviewMapId: PortableIdSchema,
  roots: z.array(z.strictObject({
    alias: PortableIdSchema,
    label: TitleSchema,
  })).min(1).max(MAX_PROJECT_MAP_ROOTS),
  maps: z.array(z.strictObject({
    id: PortableIdSchema,
    type: z.enum(PROJECT_MAP_TYPES),
    path: RelativePathSchema,
    authoritativeInputs: z.array(AuthoritativeInputSchema).min(1).max(64),
    review: z.strictObject({
      inputDigest: Sha256Schema,
      decision: z.enum(['map-updated', 'no-semantic-impact']),
      reason: z.string().trim().min(1).max(280).optional(),
    }),
  })).min(1).max(MAX_PROJECT_MAPS),
});

export type ProjectMapManifest = z.infer<typeof ProjectMapManifestSchema>;
export type ArchitectureMapSpec = z.infer<typeof ArchitectureMapSpecSchema>;
export type WorkflowMapSpec = z.infer<typeof WorkflowMapSpecSchema>;
export type SequenceMapSpec = z.infer<typeof SequenceMapSpecSchema>;
export type DataflowMapSpec = z.infer<typeof DataflowMapSpecSchema>;
export type LifecycleMapSpec = z.infer<typeof LifecycleMapSpecSchema>;
export type ProjectMapSpec = z.infer<typeof ProjectMapSpecSchema>;

export type ProjectMapDiagnosticSeverity = 'error' | 'warning';

export interface ProjectMapDiagnostic {
  severity: ProjectMapDiagnosticSeverity;
  code: string;
  subject: string;
  message: string;
}

export interface ProjectMapValidationResult<T> {
  value?: T;
  diagnostics: ProjectMapDiagnostic[];
}

function formatZodDiagnostics(error: z.ZodError): ProjectMapDiagnostic[] {
  return error.issues.map((issue) => ({
    severity: 'error',
    code: 'schema.invalid',
    subject: issue.path.length > 0 ? issue.path.join('.') : '$',
    message: issue.message,
  }));
}

function parseBoundedJson(input: string): ProjectMapValidationResult<unknown> {
  if (new TextEncoder().encode(input).byteLength > MAX_PROJECT_MAP_SOURCE_BYTES) {
    return {
      diagnostics: [{
        severity: 'error',
        code: 'source.too-large',
        subject: '$',
        message: `Project Map source exceeds ${MAX_PROJECT_MAP_SOURCE_BYTES} bytes.`,
      }],
    };
  }
  try {
    return { value: JSON.parse(input) as unknown, diagnostics: [] };
  } catch (error) {
    return {
      diagnostics: [{
        severity: 'error',
        code: 'source.invalid-json',
        subject: '$',
        message: error instanceof Error ? error.message : 'Invalid JSON.',
      }],
    };
  }
}

function duplicateDiagnostics(ids: string[], subject: string): ProjectMapDiagnostic[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort().map((id) => ({
    severity: 'error',
    code: 'semantic.duplicate-id',
    subject,
    message: `Duplicate id: ${id}`,
  }));
}

function unknownReference(
  value: string,
  validIds: Set<string>,
  subject: string,
): ProjectMapDiagnostic | undefined {
  if (validIds.has(value)) return undefined;
  return {
    severity: 'error',
    code: 'semantic.unknown-reference',
    subject,
    message: `Unknown reference: ${value}`,
  };
}

function commonMapDiagnostics(spec: ProjectMapSpec, semanticIds: Set<string>): ProjectMapDiagnostic[] {
  const diagnostics: ProjectMapDiagnostic[] = [];
  diagnostics.push(...duplicateDiagnostics(spec.layoutIntent.emphasisIds, 'layoutIntent.emphasisIds'));
  for (const [index, emphasisId] of spec.layoutIntent.emphasisIds.entries()) {
    const diagnostic = unknownReference(
      emphasisId,
      semanticIds,
      `layoutIntent.emphasisIds.${index}`,
    );
    if (diagnostic) diagnostics.push(diagnostic);
  }
  for (const [chapterIndex, chapter] of spec.chapters.entries()) {
    for (const [focusIndex, focusId] of chapter.focusIds.entries()) {
      const diagnostic = unknownReference(
        focusId,
        semanticIds,
        `chapters.${chapterIndex}.focusIds.${focusIndex}`,
      );
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }
  for (const evidence of projectMapEvidence(spec)) {
    if (evidence.startLine > evidence.endLine) {
      diagnostics.push({
        severity: 'error',
        code: 'evidence.invalid-range',
        subject: `${evidence.rootAlias}:${evidence.relativePath}`,
        message: 'Evidence startLine must be less than or equal to endLine.',
      });
    }
  }
  return diagnostics;
}

function relationDiagnostics(
  relations: Array<{ id: string; from: string; to: string }>,
  nodeIds: Set<string>,
  subject: string,
): ProjectMapDiagnostic[] {
  const diagnostics: ProjectMapDiagnostic[] = [];
  for (const [index, relation] of relations.entries()) {
    const from = unknownReference(relation.from, nodeIds, `${subject}.${index}.from`);
    const to = unknownReference(relation.to, nodeIds, `${subject}.${index}.to`);
    if (from) diagnostics.push(from);
    if (to) diagnostics.push(to);
  }
  return diagnostics;
}

function pathDiagnostics(
  path: string[],
  relations: Array<{ from: string; to: string }>,
  nodeIds: Set<string>,
  subject: string,
): ProjectMapDiagnostic[] {
  const diagnostics: ProjectMapDiagnostic[] = duplicateDiagnostics(path, subject).map((item) => ({
    ...item,
    code: 'semantic.repeated-path-item',
    message: item.message.replace('Duplicate id', 'Repeated path item'),
  }));
  for (const [index, id] of path.entries()) {
    const diagnostic = unknownReference(id, nodeIds, `${subject}.${index}`);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    if (!relations.some((relation) => relation.from === from && relation.to === to)) {
      diagnostics.push({
        severity: 'error',
        code: 'semantic.disconnected-path',
        subject: `${subject}.${index}`,
        message: `No forward relation connects ${from} to ${to}.`,
      });
    }
  }
  return diagnostics;
}

export function projectMapEvidence(spec: ProjectMapSpec): ProjectMapEvidence[] {
  switch (spec.type) {
    case 'architecture':
      return [...spec.nodes.flatMap((node) => node.evidence), ...spec.relations.flatMap((edge) => edge.evidence)];
    case 'workflow':
      return [...spec.steps.flatMap((step) => step.evidence), ...spec.transitions.flatMap((edge) => edge.evidence)];
    case 'sequence':
      return [...spec.participants.flatMap((participant) => participant.evidence), ...spec.messages.flatMap((message) => message.evidence)];
    case 'dataflow':
      return [...spec.entities.flatMap((entity) => entity.evidence), ...spec.flows.flatMap((edge) => edge.evidence)];
    case 'lifecycle':
      return [...spec.states.flatMap((state) => state.evidence), ...spec.transitions.flatMap((edge) => edge.evidence)];
  }
}

export function projectMapSemanticDiagnostics(spec: ProjectMapSpec): ProjectMapDiagnostic[] {
  const diagnostics: ProjectMapDiagnostic[] = [];
  switch (spec.type) {
    case 'architecture': {
      const groupIds = new Set(spec.groups.map((group) => group.id));
      const nodeIds = new Set(spec.nodes.map((node) => node.id));
      diagnostics.push(...duplicateDiagnostics([
        ...spec.chapters.map((chapter) => chapter.id),
        ...spec.groups.map((group) => group.id),
        ...spec.nodes.map((node) => node.id),
        ...spec.relations.map((relation) => relation.id),
      ], 'identifiers'));
      for (const [index, node] of spec.nodes.entries()) {
        const diagnostic = unknownReference(node.group, groupIds, `nodes.${index}.group`);
        if (diagnostic) diagnostics.push(diagnostic);
      }
      diagnostics.push(...relationDiagnostics(spec.relations, nodeIds, 'relations'));
      diagnostics.push(...pathDiagnostics(spec.mainPath, spec.relations, nodeIds, 'mainPath'));
      diagnostics.push(...commonMapDiagnostics(spec, new Set([
        ...nodeIds,
        ...spec.relations.map((relation) => relation.id),
      ])));
      break;
    }
    case 'workflow': {
      const laneIds = new Set(spec.lanes.map((lane) => lane.id));
      const stepIds = new Set(spec.steps.map((step) => step.id));
      diagnostics.push(...duplicateDiagnostics([
        ...spec.chapters.map((chapter) => chapter.id),
        ...spec.lanes.map((lane) => lane.id),
        ...spec.steps.map((step) => step.id),
        ...spec.transitions.map((transition) => transition.id),
      ], 'identifiers'));
      for (const [index, step] of spec.steps.entries()) {
        const diagnostic = unknownReference(step.lane, laneIds, `steps.${index}.lane`);
        if (diagnostic) diagnostics.push(diagnostic);
      }
      diagnostics.push(...relationDiagnostics(spec.transitions, stepIds, 'transitions'));
      diagnostics.push(...pathDiagnostics(spec.mainPath, spec.transitions, stepIds, 'mainPath'));
      diagnostics.push(...commonMapDiagnostics(spec, new Set([
        ...stepIds,
        ...spec.transitions.map((transition) => transition.id),
      ])));
      break;
    }
    case 'sequence': {
      const participantIds = new Set(spec.participants.map((participant) => participant.id));
      diagnostics.push(...duplicateDiagnostics([
        ...spec.chapters.map((chapter) => chapter.id),
        ...spec.participants.map((participant) => participant.id),
        ...spec.messages.map((message) => message.id),
      ], 'identifiers'));
      for (const [index, message] of spec.messages.entries()) {
        const from = unknownReference(message.from, participantIds, `messages.${index}.from`);
        const to = unknownReference(message.to, participantIds, `messages.${index}.to`);
        if (from) diagnostics.push(from);
        if (to) diagnostics.push(to);
      }
      const orders = spec.messages.map((message) => message.order);
      if (new Set(orders).size !== orders.length) {
        diagnostics.push({
          severity: 'error',
          code: 'semantic.duplicate-order',
          subject: 'messages',
          message: 'Sequence message order values must be unique.',
        });
      }
      diagnostics.push(...commonMapDiagnostics(spec, new Set([
        ...participantIds,
        ...spec.messages.map((message) => message.id),
      ])));
      break;
    }
    case 'dataflow': {
      const stageIds = new Set(spec.stages.map((stage) => stage.id));
      const entityIds = new Set(spec.entities.map((entity) => entity.id));
      diagnostics.push(...duplicateDiagnostics([
        ...spec.chapters.map((chapter) => chapter.id),
        ...spec.stages.map((stage) => stage.id),
        ...spec.entities.map((entity) => entity.id),
        ...spec.flows.map((flow) => flow.id),
      ], 'identifiers'));
      for (const [index, entity] of spec.entities.entries()) {
        const diagnostic = unknownReference(entity.stage, stageIds, `entities.${index}.stage`);
        if (diagnostic) diagnostics.push(diagnostic);
      }
      diagnostics.push(...relationDiagnostics(spec.flows, entityIds, 'flows'));
      diagnostics.push(...pathDiagnostics(spec.primaryPath, spec.flows, entityIds, 'primaryPath'));
      diagnostics.push(...commonMapDiagnostics(spec, new Set([
        ...entityIds,
        ...spec.flows.map((flow) => flow.id),
      ])));
      break;
    }
    case 'lifecycle': {
      const phaseIds = new Set(spec.phases.map((phase) => phase.id));
      const stateIds = new Set(spec.states.map((state) => state.id));
      diagnostics.push(...duplicateDiagnostics([
        ...spec.chapters.map((chapter) => chapter.id),
        ...spec.phases.map((phase) => phase.id),
        ...spec.states.map((state) => state.id),
        ...spec.transitions.map((transition) => transition.id),
      ], 'identifiers'));
      for (const [index, state] of spec.states.entries()) {
        const diagnostic = unknownReference(state.phase, phaseIds, `states.${index}.phase`);
        if (diagnostic) diagnostics.push(diagnostic);
      }
      diagnostics.push(...relationDiagnostics(spec.transitions, stateIds, 'transitions'));
      const initial = unknownReference(spec.initialState, stateIds, 'initialState');
      if (initial) diagnostics.push(initial);
      const initialStates = spec.states.filter((state) => state.kind === 'initial');
      if (initialStates.length !== 1) {
        diagnostics.push({
          severity: 'error',
          code: 'semantic.invalid-initial-state-count',
          subject: 'states',
          message: 'Lifecycle maps must declare exactly one state with kind initial.',
        });
      } else if (initialStates[0]?.id !== spec.initialState) {
        diagnostics.push({
          severity: 'error',
          code: 'semantic.initial-state-mismatch',
          subject: 'initialState',
          message: 'initialState must identify the state whose kind is initial.',
        });
      }
      diagnostics.push(...commonMapDiagnostics(spec, new Set([
        ...stateIds,
        ...spec.transitions.map((transition) => transition.id),
      ])));
      break;
    }
  }
  return diagnostics;
}

export function validateProjectMapSpec(value: unknown): ProjectMapValidationResult<ProjectMapSpec> {
  const parsed = ProjectMapSpecSchema.safeParse(value);
  if (!parsed.success) return { diagnostics: formatZodDiagnostics(parsed.error) };
  const diagnostics = projectMapSemanticDiagnostics(parsed.data);
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? { diagnostics }
    : { value: parsed.data, diagnostics };
}

export function validateProjectMapSpecText(input: string): ProjectMapValidationResult<ProjectMapSpec> {
  const json = parseBoundedJson(input);
  if (json.value === undefined) return { diagnostics: json.diagnostics };
  const version = typeof json.value === 'object' && json.value !== null && !Array.isArray(json.value)
    ? (json.value as { readonly schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== PROJECT_MAP_SCHEMA_VERSION) {
    return {
      diagnostics: [{
        severity: 'error',
        code: 'schema.unsupported-version',
        subject: 'schemaVersion',
        message: `Project Map schemaVersion ${String(version)} is unsupported; migrate the source to version ${String(PROJECT_MAP_SCHEMA_VERSION)}.`,
      }],
    };
  }
  return validateProjectMapSpec(json.value);
}

export function projectMapManifestSemanticDiagnostics(
  manifest: ProjectMapManifest,
): ProjectMapDiagnostic[] {
  const diagnostics = [
    ...duplicateDiagnostics(manifest.roots.map((root) => root.alias), 'roots'),
    ...duplicateDiagnostics(manifest.maps.map((map) => map.id), 'maps'),
    ...duplicateDiagnostics(manifest.maps.map((map) => map.path), 'map paths'),
  ];
  const rootAliases = new Set(manifest.roots.map((root) => root.alias));
  const mapIds = new Set(manifest.maps.map((map) => map.id));
  const owner = unknownReference(manifest.ownerRootAlias, rootAliases, 'ownerRootAlias');
  const overview = unknownReference(manifest.overviewMapId, mapIds, 'overviewMapId');
  if (owner) diagnostics.push(owner);
  if (overview) diagnostics.push(overview);
  for (const [mapIndex, map] of manifest.maps.entries()) {
    if (map.path === 'manifest.json' || !map.path.startsWith('maps/')) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.invalid-map-path',
        subject: `maps.${mapIndex}.path`,
        message: 'Map source paths must be beneath maps/.',
      });
    }
    if (map.review.decision === 'no-semantic-impact' && !map.review.reason) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.missing-review-reason',
        subject: `maps.${mapIndex}.review.reason`,
        message: 'A no-semantic-impact decision requires a reason.',
      });
    }
    const inputKeys = map.authoritativeInputs.map((input) => JSON.stringify([
      input.rootAlias,
      input.relativePath,
    ]));
    diagnostics.push(...duplicateDiagnostics(inputKeys, `maps.${mapIndex}.authoritativeInputs`));
    for (const [inputIndex, input] of map.authoritativeInputs.entries()) {
      const diagnostic = unknownReference(
        input.rootAlias,
        rootAliases,
        `maps.${mapIndex}.authoritativeInputs.${inputIndex}.rootAlias`,
      );
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

export function validateProjectMapManifest(value: unknown): ProjectMapValidationResult<ProjectMapManifest> {
  const parsed = ProjectMapManifestSchema.safeParse(value);
  if (!parsed.success) return { diagnostics: formatZodDiagnostics(parsed.error) };
  const diagnostics = projectMapManifestSemanticDiagnostics(parsed.data);
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? { diagnostics }
    : { value: parsed.data, diagnostics };
}

export function validateProjectMapManifestText(
  input: string,
): ProjectMapValidationResult<ProjectMapManifest> {
  const json = parseBoundedJson(input);
  if (json.value === undefined) return { diagnostics: json.diagnostics };
  const version = typeof json.value === 'object' && json.value !== null && !Array.isArray(json.value)
    ? (json.value as { readonly schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== PROJECT_MAP_SCHEMA_VERSION) {
    return {
      diagnostics: [{
        severity: 'error',
        code: 'schema.unsupported-version',
        subject: 'schemaVersion',
        message: `Project Map manifest schemaVersion ${String(version)} is unsupported; migrate the collection to version ${String(PROJECT_MAP_SCHEMA_VERSION)}.`,
      }],
    };
  }
  return validateProjectMapManifest(json.value);
}

export interface ProjectMapCollectionRequest {
  readonly projectId: string;
  readonly ownerRootId: string;
  readonly ownerWorkspaceId: string;
}

export interface ProjectMapReadRequest extends ProjectMapCollectionRequest {
  readonly mapId?: string;
  readonly quality?: ProjectMapQualityProfile;
}

export interface ProjectMapRootBinding {
  readonly rootAlias: string;
  readonly rootId: string;
  readonly workspaceId: string;
}

export interface ProjectMapBindingRequest extends ProjectMapCollectionRequest {
  readonly bindings: readonly ProjectMapRootBinding[];
}

export type ProjectMapCollectionState =
  | 'empty'
  | 'binding-required'
  | 'valid'
  | 'stale'
  | 'invalid-with-last-good'
  | 'invalid';

export interface ProjectMapSummary {
  readonly id: string;
  readonly type: ProjectMapType;
  readonly title?: string;
}

export interface ProjectMapCollectionDescriptor {
  readonly projectId: string;
  readonly collectionId?: string;
  readonly state: ProjectMapCollectionState;
  readonly overviewMapId?: string;
  readonly ownerRootAlias?: string;
  readonly roots: readonly { readonly alias: string; readonly label: string }[];
  readonly bindings: readonly ProjectMapRootBinding[];
  readonly maps: readonly ProjectMapSummary[];
  readonly diagnostics: readonly ProjectMapDiagnostic[];
}

export interface ProjectMapRootProvenance {
  readonly rootAlias: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly snapshotHash?: string;
}

export interface ProjectMapProvenance {
  readonly kind: 'commit-pinned' | 'worktree-snapshot';
  readonly roots: readonly ProjectMapRootProvenance[];
}

export interface ProjectMapVerification {
  readonly quality: ProjectMapQualityProfile;
  readonly fingerprint: string;
  readonly verifiedAt: string;
  readonly manifestHash: string;
  readonly specHash: string;
  readonly inputHash: string;
  readonly layoutHash: string;
  readonly checks: readonly {
    readonly name:
      | 'schema'
      | 'semantics'
      | 'evidence'
      | 'inputs'
      | 'layout'
      | 'routes'
      | 'labels'
      | 'containment'
      | 'accessibility'
      | 'provenance';
    readonly status: 'passed' | 'warning' | 'failed';
  }[];
  readonly diagnostics: readonly ProjectMapDiagnostic[];
}

export interface ProjectMapDocument {
  readonly collectionId: string;
  readonly mapId: string;
  readonly mapPath: string;
  readonly state: 'valid' | 'stale' | 'invalid-with-last-good';
  readonly spec: ProjectMapSpec;
  readonly layout: import('./project-map-layout').ProjectMapLayout;
  readonly provenance: ProjectMapProvenance;
  readonly verification: ProjectMapVerification;
  readonly fromLastGood: boolean;
}

export interface ProjectMapApproval {
  readonly mapId: string;
  readonly fingerprint: string;
  readonly approvedAt: string;
}

export type ProjectMapJobPhase =
  | 'queued'
  | 'analyzing'
  | 'authoring'
  | 'validating-draft'
  | 'validating-production'
  | 'awaiting-review'
  | 'completed'
  | 'failed'
  | 'cancel-requested'
  | 'canceled';

export type ProjectMapJobDispatch = 'existing-session' | 'dedicated-session';

export interface ProjectMapJob {
  readonly id: string;
  readonly projectId: string;
  readonly ownerRootId: string;
  readonly ownerWorkspaceId: string;
  readonly mapId?: string;
  readonly type: ProjectMapType;
  readonly intent: 'create' | 'update';
  readonly activityId: string;
  /** Omitted only for jobs restored from versions that predate dispatch tracking. */
  readonly dispatch?: ProjectMapJobDispatch;
  readonly agentLabel?: string;
  readonly phase: ProjectMapJobPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly message?: string;
}

export interface ProjectMapSemanticChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly id: string;
  readonly fields: readonly string[];
}

export interface ProjectMapDiff {
  readonly fromFingerprint: string;
  readonly toFingerprint: string;
  readonly semantic: readonly ProjectMapSemanticChange[];
  readonly evidence: readonly ProjectMapSemanticChange[];
}

export type ProjectMapDisplaySource = 'approved' | 'candidate-preview' | 'last-approved';

export interface ProjectMapSnapshot {
  readonly collection: ProjectMapCollectionDescriptor;
  readonly map?: ProjectMapDocument;
  readonly candidate?: ProjectMapDocument;
  readonly displaySource?: ProjectMapDisplaySource;
  readonly freshness: 'cache' | 'verified' | 'empty';
  readonly approval?: ProjectMapApproval;
  readonly verificationPending: boolean;
  readonly activeJob?: ProjectMapJob;
  readonly diff?: ProjectMapDiff;
}

export type ProjectMapOpenResult =
  | { readonly ok: true; readonly snapshot: ProjectMapSnapshot }
  | { readonly ok: false; readonly error: string; readonly snapshot: ProjectMapSnapshot };

export interface ProjectMapApprovalRequest extends ProjectMapReadRequest {
  readonly fingerprint: string;
}

export interface ProjectMapStartJobRequest extends ProjectMapReadRequest {
  readonly type: ProjectMapType;
  readonly intent: 'create' | 'update';
  readonly activityId: string;
  readonly dispatch?: ProjectMapJobDispatch;
  readonly agentLabel?: string;
}

/** Runtime-only request carried into a freshly opened Agent terminal. */
export interface ProjectMapAgentLaunchRequest extends ProjectMapReadRequest {
  readonly type: ProjectMapType;
  readonly intent: 'create' | 'update';
  readonly brief: string;
}

export function projectMapJobPrompt(brief: string, jobId: string): string {
  return [
    `EZTerminal Project Map job: ${jobId}`,
    `Report progress with: ezterminal-agent map job ${jobId} <phase>`,
    'Use phases in order: analyzing, authoring, validating-draft, validating-production, then awaiting-review. Stop there; EZTerminal marks the job completed only after human approval. Report failed if the work cannot finish; report canceled if cancellation is requested.',
    '',
    brief.trim(),
  ].join('\n');
}

export interface ProjectMapJobRequest extends ProjectMapCollectionRequest {
  readonly jobId: string;
}

export interface ProjectMapExportRequest extends ProjectMapReadRequest {
  readonly fingerprint: string;
  readonly parentDirectory: string;
  readonly theme: 'current' | 'light' | 'dark';
}

export interface ProjectMapExportResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly directory?: string;
  readonly files?: readonly string[];
}

export interface ProjectMapChangeNotice extends ProjectMapCollectionRequest {
  readonly reason: 'source-changed' | 'bindings-changed' | 'verification-complete' | 'approval-changed' | 'job-changed';
  readonly impactedMapIds?: readonly string[];
}

export type ProjectMapDescribeResult =
  | { readonly ok: true; readonly collection: ProjectMapCollectionDescriptor }
  | { readonly ok: false; readonly error: string; readonly collection: ProjectMapCollectionDescriptor };

export type ProjectMapReadResult =
  | { readonly ok: true; readonly map: ProjectMapDocument }
  | {
      readonly ok: false;
      readonly error: string;
      readonly state: ProjectMapCollectionState;
      readonly diagnostics: readonly ProjectMapDiagnostic[];
      readonly lastGood?: ProjectMapDocument;
    };

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 128
    && !hasControlCharacters(value);
}

export function isProjectMapCollectionRequest(value: unknown): value is ProjectMapCollectionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return Object.keys(request).every((key) => ['projectId', 'ownerRootId', 'ownerWorkspaceId'].includes(key))
    && validOpaqueId(request.projectId)
    && validOpaqueId(request.ownerRootId)
    && validOpaqueId(request.ownerWorkspaceId);
}

export function isProjectMapReadRequest(value: unknown): value is ProjectMapReadRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return Object.keys(request).every((key) => [
    'projectId', 'ownerRootId', 'ownerWorkspaceId', 'mapId', 'quality',
  ].includes(key))
    && validOpaqueId(request.projectId)
    && validOpaqueId(request.ownerRootId)
    && validOpaqueId(request.ownerWorkspaceId)
    && (request.mapId === undefined || PortableIdSchema.safeParse(request.mapId).success)
    && (request.quality === undefined || request.quality === 'draft' || request.quality === 'production');
}

export function isProjectMapBindingRequest(value: unknown): value is ProjectMapBindingRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (!Object.keys(request).every((key) => [
    'projectId', 'ownerRootId', 'ownerWorkspaceId', 'bindings',
  ].includes(key))
    || !validOpaqueId(request.projectId)
    || !validOpaqueId(request.ownerRootId)
    || !validOpaqueId(request.ownerWorkspaceId)
    || !Array.isArray(request.bindings)
    || request.bindings.length > MAX_PROJECT_MAP_ROOTS) return false;
  return request.bindings.every((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    const binding = candidate as Record<string, unknown>;
    return Object.keys(binding).every((key) => ['rootAlias', 'rootId', 'workspaceId'].includes(key))
      && PortableIdSchema.safeParse(binding.rootAlias).success
      && validOpaqueId(binding.rootId)
      && validOpaqueId(binding.workspaceId);
  });
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isProjectMapApprovalRequest(value: unknown): value is ProjectMapApprovalRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as unknown as Record<string, unknown>;
  return hasOnlyKeys(request, ['projectId', 'ownerRootId', 'ownerWorkspaceId', 'mapId', 'fingerprint'])
    && isProjectMapReadRequest({
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
      ...(request.mapId === undefined ? {} : { mapId: request.mapId }),
    })
    && typeof request.fingerprint === 'string'
    && Sha256Schema.safeParse(request.fingerprint).success;
}

export function isProjectMapStartJobRequest(value: unknown): value is ProjectMapStartJobRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return hasOnlyKeys(request, [
    'projectId', 'ownerRootId', 'ownerWorkspaceId', 'mapId', 'type', 'intent', 'activityId',
    'dispatch', 'agentLabel',
  ])
    && isProjectMapReadRequest({
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
      ...(request.mapId === undefined ? {} : { mapId: request.mapId }),
    })
    && typeof request.type === 'string'
    && (PROJECT_MAP_TYPES as readonly string[]).includes(request.type)
    && (request.intent === 'create' || request.intent === 'update')
    && validOpaqueId(request.activityId)
    && (request.dispatch === undefined
      || request.dispatch === 'existing-session'
      || request.dispatch === 'dedicated-session')
    && (request.agentLabel === undefined || validOpaqueId(request.agentLabel));
}

export function isProjectMapJobRequest(value: unknown): value is ProjectMapJobRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return hasOnlyKeys(request, ['projectId', 'ownerRootId', 'ownerWorkspaceId', 'jobId'])
    && isProjectMapCollectionRequest({
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
    })
    && validOpaqueId(request.jobId);
}

export function isProjectMapExportRequest(value: unknown): value is ProjectMapExportRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return hasOnlyKeys(request, [
    'projectId', 'ownerRootId', 'ownerWorkspaceId', 'mapId', 'fingerprint', 'parentDirectory', 'theme',
  ])
    && isProjectMapReadRequest({
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
      ...(request.mapId === undefined ? {} : { mapId: request.mapId }),
    })
    && typeof request.fingerprint === 'string'
    && Sha256Schema.safeParse(request.fingerprint).success
    && typeof request.parentDirectory === 'string'
    && request.parentDirectory.length > 0
    && request.parentDirectory.length <= 2_048
    && !hasControlCharacters(request.parentDirectory)
    && (request.theme === 'current' || request.theme === 'light' || request.theme === 'dark');
}
