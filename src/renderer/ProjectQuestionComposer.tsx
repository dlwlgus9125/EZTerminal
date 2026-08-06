import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  PROJECT_REFERENCE_MAX_COUNT,
  type ProjectQuestionReference,
} from '../shared/project-workspace';
import {
  EMPTY_AGENT_ACTIVITY_SNAPSHOT,
  type AgentActivitySnapshot,
} from '../shared/agent';
import { useAppTranslation } from './i18n';

interface QuestionDraft {
  readonly message: string;
  readonly references: readonly ProjectQuestionReference[];
}

interface QuestionStoreSnapshot {
  readonly activeTarget: string;
  readonly drafts: ReadonlyMap<string, QuestionDraft>;
  readonly revision: number;
}

const EMPTY_DRAFT: QuestionDraft = Object.freeze({ message: '', references: [] });
let snapshot: QuestionStoreSnapshot = {
  activeTarget: 'copy',
  drafts: new Map([['copy', EMPTY_DRAFT]]),
  revision: 0,
};
const listeners = new Set<() => void>();

function publish(next: Omit<QuestionStoreSnapshot, 'revision'>): void {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

function updateActiveDraft(update: (draft: QuestionDraft) => QuestionDraft): void {
  const drafts = new Map(snapshot.drafts);
  drafts.set(snapshot.activeTarget, update(drafts.get(snapshot.activeTarget) ?? EMPTY_DRAFT));
  publish({ activeTarget: snapshot.activeTarget, drafts });
}

export function addProjectQuestionReference(reference: ProjectQuestionReference): boolean {
  const current = snapshot.drafts.get(snapshot.activeTarget) ?? EMPTY_DRAFT;
  const duplicate = current.references.some((candidate) =>
    candidate.projectId === reference.projectId
    && candidate.rootId === reference.rootId
    && candidate.relativePath === reference.relativePath
    && candidate.startLine === reference.startLine
    && candidate.endLine === reference.endLine);
  if (duplicate) return true;
  if (current.references.length >= PROJECT_REFERENCE_MAX_COUNT) return false;
  updateActiveDraft((draft) => ({ ...draft, references: [...draft.references, reference] }));
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QuestionStoreSnapshot {
  return snapshot;
}

async function referenceLabel(reference: ProjectQuestionReference): Promise<string> {
  const described = await window.ezterminalDesktop?.describeProjectWorkspace(reference.projectId);
  const root = described?.ok
    ? described.project.roots.find((candidate) => candidate.rootId === reference.rootId)
    : undefined;
  const pathLabel = root && !root.primary
    ? `${root.displayPath.replace(/[\\/]+$/u, '')}/${reference.relativePath}`
    : `./${reference.relativePath}`;
  const range = reference.startLine === reference.endLine
    ? `L${String(reference.startLine)}`
    : `L${String(reference.startLine)}-L${String(reference.endLine)}`;
  return `@${pathLabel}:${range}${reference.snippet ? ` snippet=${JSON.stringify(reference.snippet)}` : ''}`;
}

async function serializeDraft(draft: QuestionDraft): Promise<string> {
  const message = draft.message.replace(/\s*\r?\n\s*/gu, ' ').trim();
  const labels = await Promise.all(draft.references.map(referenceLabel));
  return [message, ...labels].filter(Boolean).join(' ');
}

export function ProjectQuestionComposer(): JSX.Element | null {
  const { t } = useAppTranslation();
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [activities, setActivities] = useState<AgentActivitySnapshot>(EMPTY_AGENT_ACTIVITY_SNAPSHOT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false);
  const draft = store.drafts.get(store.activeTarget) ?? EMPTY_DRAFT;
  const waiting = useMemo(
    () => activities.items.filter((activity) => activity.status === 'waiting'),
    [activities],
  );
  const sensitive = draft.references.some((reference) => reference.sensitive);

  useEffect(() => {
    let alive = true;
    const apply = (next: AgentActivitySnapshot): void => {
      if (alive) setActivities(next);
    };
    const unsubscribe = window.ezterminal.onAgentActivitySnapshot(apply);
    void window.ezterminal.getAgentActivitySnapshot().then(apply).catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setSensitiveConfirmed(false);
  }, [draft.references]);

  if (draft.references.length === 0) return null;

  const chooseTarget = (target: string): void => {
    const drafts = new Map(store.drafts);
    const targetDraft = drafts.get(target);
    if ((!targetDraft || targetDraft.references.length === 0) && draft.references.length > 0) {
      drafts.set(target, draft);
      drafts.set(store.activeTarget, EMPTY_DRAFT);
    } else if (!targetDraft) {
      drafts.set(target, EMPTY_DRAFT);
    }
    publish({ activeTarget: target, drafts });
    setError(null);
  };

  const removeReference = (index: number): void => {
    updateActiveDraft((current) => ({
      ...current,
      references: current.references.filter((_reference, candidate) => candidate !== index),
    }));
  };

  const validate = async (): Promise<boolean> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return false;
    for (const reference of draft.references) {
      const result = await desktop.validateProjectText(reference);
      if (!result.ok) {
        setError(result.error === 'stale'
          ? `${reference.relativePath} changed after the reference was selected.`
          : `Could not validate ${reference.relativePath}: ${result.error}`);
        return false;
      }
    }
    return true;
  };

  const copy = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const payload = await serializeDraft(draft);
      await navigator.clipboard.writeText(payload);
    } catch {
      setError('Could not copy the question reference.');
    } finally {
      setBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    const target = activities.items.find((activity) => activity.id === store.activeTarget);
    if (!target || target.status !== 'waiting') {
      setError('The selected agent is no longer waiting. Keep the draft or copy it.');
      return;
    }
    if (sensitive && !sensitiveConfirmed) {
      setError('Confirm the sensitive-file warning before sending.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!await validate()) return;
      const payload = await serializeDraft(draft);
      if (new TextEncoder().encode(payload).length > 8192) {
        setError('The follow-up exceeds the 8 KiB live-session limit. Remove references or copy it.');
        return;
      }
      const result = await window.ezterminal.sendAgentFollowup(target.id, payload);
      if (!result.ok) {
        setError(`The agent did not accept the follow-up: ${result.error}`);
        return;
      }
      const drafts = new Map(store.drafts);
      drafts.set(store.activeTarget, EMPTY_DRAFT);
      publish({ activeTarget: store.activeTarget, drafts });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-question-composer" aria-label={t('projectWorkbench.ask')} data-testid="project-question-composer">
      <div className="project-question-composer__header">
        <strong>{t('projectWorkbench.ask')}</strong>
        <select
          aria-label={t('projectWorkbench.destination')}
          value={store.activeTarget}
          onChange={(event) => chooseTarget(event.target.value)}
        >
          <option value="copy">{t('projectWorkbench.clipboardOnly')}</option>
          {store.activeTarget !== 'copy' && !waiting.some((activity) => activity.id === store.activeTarget) && (
            <option value={store.activeTarget}>{t('projectWorkbench.unavailableDraft')}</option>
          )}
          {waiting.map((activity) => (
            <option key={activity.id} value={activity.id}>
              {activity.provider} · {activity.cwd}
            </option>
          ))}
        </select>
      </div>
      <div className="project-question-composer__references">
        {draft.references.map((reference, index) => (
          <span key={`${reference.rootId}:${reference.relativePath}:${String(reference.startLine)}:${String(index)}`}>
            {reference.relativePath}:L{reference.startLine}{reference.endLine === reference.startLine ? '' : `-L${reference.endLine}`}
            <button type="button" onClick={() => removeReference(index)} aria-label={`Remove ${reference.relativePath} reference`}>×</button>
          </span>
        ))}
      </div>
      <textarea
        value={draft.message}
        rows={2}
        placeholder={t('projectWorkbench.questionPlaceholder')}
        aria-label={t('projectWorkbench.question')}
        onChange={(event) => updateActiveDraft((current) => ({ ...current, message: event.target.value }))}
      />
      {sensitive && (
        <label className="project-question-composer__warning">
          <input
            type="checkbox"
            checked={sensitiveConfirmed}
            onChange={(event) => setSensitiveConfirmed(event.target.checked)}
          />
          {t('projectWorkbench.sensitiveConfirm')}
        </label>
      )}
      {error && <div role="alert" className="project-question-composer__error">{error}</div>}
      <div className="project-question-composer__actions">
        <button type="button" disabled={busy} onClick={() => void copy()}>{t('projectWorkbench.copy')}</button>
        {store.activeTarget !== 'copy' && (
          <button type="button" disabled={busy} onClick={() => void send()}>{t('projectWorkbench.sendWaiting')}</button>
        )}
      </div>
    </section>
  );
}
