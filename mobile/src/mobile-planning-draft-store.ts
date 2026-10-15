import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

import { PlanningWorkspaceDraftSchema, type PlanningDraftStorage, type PlanningWorkspaceDraft } from '../../src/renderer/planning-draft-state';
import { mobileAgentCreateAuthorityFingerprint, type SecureStorageLike } from './mobile-agent-create-recovery-store';

/** Planning content shares Android's encrypted device boundary with chat drafts. */
export function mobilePlanningDraftStorage(projectId: string, getToken: () => Promise<string>, secure: SecureStorageLike = SecureStoragePlugin, subprojectId?: string): PlanningDraftStorage {
  const key = async (): Promise<string> => {
    if ((await secure.getPlatform()).value !== 'android') throw new Error('Android secure planning storage is unavailable.');
    const authority = await mobileAgentCreateAuthorityFingerprint(await getToken());
    return `ezterminal-planning-draft-v1:${authority.slice(7)}:${encodeURIComponent(projectId)}${subprojectId ? `:${encodeURIComponent(subprojectId)}` : ''}`;
  };
  const validate = (input: unknown): PlanningWorkspaceDraft => {
    const value = PlanningWorkspaceDraftSchema.parse(input);
    if (value.subprojectId !== subprojectId) throw new Error('Planning draft subproject mismatch.');
    if (value.projectId !== projectId || value.snapshot && value.snapshot.projectId !== projectId
      || value.uncertain && value.uncertain.projectId !== projectId) throw new Error('Planning draft project mismatch.');
    return value;
  };
  return {
    async loadDraft() {
      const storageKey = await key();
      if (!(await secure.keys()).value.includes(storageKey)) return null;
      const raw = (await secure.get({ key: storageKey })).value;
      if (new TextEncoder().encode(raw).byteLength > 8 * 1024 * 1024) throw new Error('Planning draft is too large.');
      const saved = JSON.parse(raw) as { scope?: unknown; state?: unknown };
      if (saved?.scope !== storageKey) throw new Error('Planning draft PC scope mismatch.');
      return validate(saved.state);
    },
    async saveDraft(state) {
      const storageKey = await key();
      const value = JSON.stringify({ scope: storageKey, state: validate(state) });
      if (new TextEncoder().encode(value).byteLength > 8 * 1024 * 1024) throw new Error('Planning draft is too large.');
      if (!(await secure.set({ key: storageKey, value })).value
        || (await secure.get({ key: storageKey })).value !== value) throw new Error('Planning draft secure write could not be verified.');
    },
  };
}
