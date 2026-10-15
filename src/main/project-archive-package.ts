import { createHash } from 'node:crypto';
import { ARCHIVE_MAX_BYTES, ArchiveSessionSchema, ArchiveTranscriptSchema, ProjectArchivePackageSchema, type ArchiveEntry, type ProjectArchiveManifest, type ProjectArchivePackage } from '../shared/project-archive';
import { PlanningSnapshotSchema } from '../shared/planning';
import { PlanningExecutionSnapshotSchema } from '../shared/planning-execution';
import { WorkflowRegistrySchema } from '../shared/workflow';

export const archiveHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function archiveCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(archiveCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => `${JSON.stringify(key)}:${archiveCanonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const archiveObjectHash = (value: unknown): string => archiveHash(archiveCanonical(value));
export function archiveEntry(id: string, kind: ArchiveEntry['kind'], bytes: Buffer, metadata?: Record<string, string>): ArchiveEntry {
  return { id, kind, hash: archiveHash(bytes), byteLength: bytes.byteLength, content: bytes.toString('base64'), ...(metadata ? { metadata } : {}) };
}
export function decodeArchiveEntry(entry: ArchiveEntry): Buffer {
  const bytes = Buffer.from(entry.content, 'base64');
  if (bytes.toString('base64') !== entry.content || bytes.length !== entry.byteLength || archiveHash(bytes) !== entry.hash) throw new Error(`Archive item integrity failed: ${entry.id}`);
  return bytes;
}
export const parseArchiveJson = (entry: ArchiveEntry): unknown => JSON.parse(decodeArchiveEntry(entry).toString('utf8'));

/** Redacts recognized credentials; arbitrary sensitive prose still requires the user's preview. */
export function redactArchiveValue(value: unknown, exclusions: ProjectArchiveManifest['exclusions'], item: string, secrets: readonly string[] = []): unknown {
  const redactText = (text: string): string => {
    let result = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
      .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/giu, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/gu, '[REDACTED TOKEN]')
      .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*(["']?)[^\s,"'};]+/giu, '$1=[REDACTED]');
    for (const secret of secrets) if (secret.length >= 8) result = result.split(secret).join('[REDACTED]');
    if (result !== text) exclusions.push({ item, reason: 'Recognized credentials were masked; source content was preserved.' });
    return result;
  };
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(child => redactArchiveValue(child, exclusions, item, secrets));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (object.isSensitive === true && typeof object.text === 'string') {
      exclusions.push({ item, reason: 'Sensitive transcript text and attachments were excluded.' });
      // Tool payloads carry commands, paths and targets of the same sensitive turn.
      value = { ...object, text: '[REDACTED SENSITIVE CONTENT]', context: undefined, payload: undefined };
    } else if (object.kind === 'text' && typeof object.data === 'string' && object.data.length >= 16 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(object.data)) {
      const bytes = Buffer.from(object.data, 'base64'); const decoded = bytes.toString('utf8');
      if (Buffer.from(decoded).equals(bytes)) {
        const cleaned = redactText(decoded);
        if (cleaned !== decoded) value = { ...object, data: Buffer.from(cleaned).toString('base64') };
      }
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|authorization|pairingToken)$/iu.test(key)) {
      exclusions.push({ item, reason: `Credential field ${key} excluded.` }); return [key, '[REDACTED]'];
    }
    return [key, redactArchiveValue(child, exclusions, item, secrets)];
    }));
  }
  return value;
}
export function verifyArchive(bytes: Buffer): ProjectArchivePackage {
  if (bytes.byteLength > ARCHIVE_MAX_BYTES) throw new Error('Archive exceeds the 50 MiB transfer limit. Original records were preserved; no partial backup was created.');
  const archive = ProjectArchivePackageSchema.parse(JSON.parse(bytes.toString('utf8')));
  const { integrity, ...manifest } = archive.manifest;
  if (archiveObjectHash(manifest) !== integrity || archive.entries.length !== manifest.entries.length) throw new Error('Archive manifest integrity failed.');
  const seen = new Set<string>();
  for (let index = 0; index < archive.entries.length; index++) {
    const entry = archive.entries[index]; const expected = manifest.entries[index];
    if (seen.has(entry.id) || entry.id !== expected.id || entry.hash !== expected.hash || entry.kind !== expected.kind || entry.byteLength !== expected.byteLength || archiveObjectHash(entry.metadata ?? {}) !== archiveObjectHash(expected.metadata ?? {})) throw new Error('Archive entry identity is invalid.');
    seen.add(entry.id); decodeArchiveEntry(entry);
    const relative = entry.metadata?.relativePath;
    if (relative && (/^(?:[A-Za-z]:|[/\\])/u.test(relative) || relative.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '' || part === '.git') || [...relative].some(character => character.charCodeAt(0) < 32))) throw new Error('An archive asset path escapes its project.');
  }
  const planning = archive.entries.find(entry => entry.kind === 'planning');
  const execution = archive.entries.find(entry => entry.kind === 'execution');
  const daemon = archive.entries.find(entry => entry.kind === 'daemon');
  if (!planning || !execution || !daemon) throw new Error('Archive core records are missing.');
  const snapshot = PlanningSnapshotSchema.parse(parseArchiveJson(planning));
  const runs = PlanningExecutionSnapshotSchema.parse(parseArchiveJson(execution));
  if (snapshot.projectId !== manifest.projectId || runs.projectId !== manifest.projectId || snapshot.baselines.some(baseline => archiveObjectHash(baseline.draft) !== baseline.hash)) throw new Error('Archive project or baseline identity is invalid.');
  const history = parseArchiveJson(daemon) as { project?: { id?: string }; sessions?: unknown[]; workspaces?: { id: string; projectId: string }[]; turns?: { id: string; sessionId: string }[] };
  if (history.project?.id !== manifest.projectId || !Array.isArray(history.sessions) || !Array.isArray(history.workspaces) || !Array.isArray(history.turns)) throw new Error('Archive conversation authority is invalid.');
  const sessions = history.sessions.map(session => ArchiveSessionSchema.parse(session));
  const sessionIds = new Set(sessions.map(session => session.id)); const workspaceIds = new Set(history.workspaces.map(workspace => workspace.id));
  const workflowEntry = archive.entries.find(entry => entry.kind === 'workflow');
  if (archive.entries.filter(entry => entry.kind === 'workflow').length > 1) throw new Error('Archive workflow registry is duplicated.');
  const workflow = workflowEntry ? WorkflowRegistrySchema.parse(parseArchiveJson(workflowEntry)) : undefined;
  if (workflow && (workflow.projectId !== manifest.projectId || workflow.sessionLinks.some(link => !sessionIds.has(link.sessionId)
    || !workflow.subprojects.some(project => project.id === link.subprojectId && (!link.nodeId || [...project.graph.nodes, ...project.archivedNodes].some(node => node.id === link.nodeId)))))) throw new Error('Archive workflow references are invalid.');
  const scopedIds = new Set<string>();
  for (const entry of archive.entries.filter(entry => entry.kind === 'subproject-planning')) {
    const owner = entry.metadata?.subprojectId; const scoped = PlanningSnapshotSchema.parse(parseArchiveJson(entry));
    if (!owner || scopedIds.has(owner) || !workflow?.subprojects.some(project => project.id === owner) || scoped.projectId !== manifest.projectId
      || scoped.baselines.some(baseline => archiveObjectHash(baseline.draft) !== baseline.hash)) throw new Error('Archive subproject planning references are invalid.');
    scopedIds.add(owner);
  }
  const turnIds = new Set(history.turns.map(turn => turn.id));
  if (sessions.some(session => session.projectId !== manifest.projectId || !workspaceIds.has(session.workspaceId)) || history.workspaces.some(workspace => workspace.projectId !== manifest.projectId)
    || history.turns.some(turn => !sessionIds.has(turn.sessionId))) throw new Error('Archive conversation references are incomplete.');
  for (const entry of archive.entries.filter(entry => entry.kind === 'transcript')) {
    const transcript = parseArchiveJson(entry) as { sessionId?: string; items?: unknown[] };
    if (!transcript.sessionId || !sessionIds.has(transcript.sessionId) || !Array.isArray(transcript.items)) throw new Error('Archive transcript ownership is invalid.');
    for (const raw of transcript.items) {
      const item = ArchiveTranscriptSchema.parse(raw);
      if (item.sessionId !== transcript.sessionId || (item.turnId && !turnIds.has(item.turnId))) throw new Error('Archive transcript references are incomplete.');
    }
  }
  if (runs.runs.some(run => run.projectId !== manifest.projectId || run.attempts.some(attempt => !sessionIds.has(attempt.sessionId) || !turnIds.has(attempt.turnId))
    || run.reviews.some(review => !sessionIds.has(review.reviewerSessionId) || !turnIds.has(review.reviewerTurnId)))) throw new Error('Archive execution references are incomplete.');
  return archive;
}
