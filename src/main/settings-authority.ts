import { randomUUID } from 'node:crypto';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import type { ApprovalRequest, ApprovalResponse } from '../shared/approval-request';
import type { ChatAgentPhaseMap, ChatAgentProfile } from '../shared/chat-agent-profiles';
import type { DaemonPrincipal, DaemonSnapshot, PermissionPreset } from '../shared/daemon-protocol';
import {
  MAX_SETTINGS_CHANGES,
  SETTINGS_PROPOSAL_REQUEST_PREFIX,
  SettingsChangeFileSchema,
  SettingsChangeSchema,
  permissionName,
  settingsChangeLine,
  settingsEditLabel,
  type HostSettingKey,
  type SettingsActor,
  type SettingsChangeFile,
  type SettingsChangeRecord,
  type SettingsChangedDomain,
  type SettingsChangedEvent,
  type SettingsConversationView,
  type SettingsDomain,
  type SettingsProposalRow,
  type SettingsProposalView,
  type PhasePatch,
  type SettingsUndoResult,
  type UiSettingsPatch,
} from '../shared/settings-changes';
import type { UiPreferences } from '../shared/ui-preferences';
import type { WorkflowRepeat } from '../shared/workflow';
import { isBuiltinWorkflowTemplateId, type WorkflowTemplate, type WorkflowTemplateInput } from '../shared/workflow-templates';
import { JsonFile } from './json-file';

const HISTORY_FILE = 'settings-changes.json';
const ADVISOR_FILE = 'agent-advisor.json';
const EMPTY_HISTORY: SettingsChangeFile = { version: 1, changes: [] };
/** Proposals one conversation may leave waiting at once. */
const MAX_PENDING_PROPOSALS = 3;
/** What the conversation shows: its latest changes and proposals. */
const SHOWN_PER_CONVERSATION = 20;
const PERMISSION_RANK: Readonly<Record<PermissionPreset, number>> = { plan: 0, standard: 1, 'full-access': 2 };
/** A new agent or stage starts from "ask before running": only something above that is a raise. */
const NEW_ENTRY_PERMISSION: PermissionPreset = 'standard';

export interface UiSettingsValues {
  readonly theme: string;
  readonly uiScale: number;
  readonly font: string | null;
  readonly effects: Readonly<Record<string, boolean>>;
  readonly effectIntensity: number;
  readonly density: UiPreferences['density'];
  readonly locale: UiPreferences['locale'];
  readonly scrollback: number;
}
/** What the Settings screen's own setters write (`effects` is the whole toggle map). */
export type UiSettingsWrite = Partial<Omit<UiSettingsValues, 'effects'>> & { readonly effects?: Readonly<Record<string, boolean>> };

/** The person who pressed a proposal's 적용 (their principal, as the daemon authenticated it). */
export interface SettingsPerson {
  readonly principal: 'desktop' | 'android';
  readonly id: string;
}

/** The conversation an AI changes settings from. */
export interface SettingsAiContext {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly projectId: string;
}

type StoreResult = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly conflict?: true };

export interface SettingsAuthorityOptions {
  readonly dir: string;
  readonly ui: {
    read(): Promise<UiSettingsValues>;
    write(patch: UiSettingsWrite): Promise<void>;
    themes(): Promise<readonly string[]>;
    readonly fonts: readonly { readonly id: string; readonly label: string }[];
    readonly effectIds: readonly string[];
  };
  /** `expect` is checked inside the store's own write, after any save queued before it (a person's too). */
  readonly profiles: {
    list(): readonly ChatAgentProfile[];
    save(raw: unknown, expect?: (current: ChatAgentProfile | undefined) => boolean): Promise<StoreResult>;
    remove(id: unknown, expect?: (current: ChatAgentProfile | undefined) => boolean): Promise<StoreResult>;
    phases(): ChatAgentPhaseMap;
    savePhases(raw: unknown, expect?: (current: ChatAgentPhaseMap) => boolean): Promise<StoreResult>;
  };
  readonly templates: {
    list(): readonly WorkflowTemplate[];
    save(raw: unknown, expect?: (current: WorkflowTemplate | undefined) => boolean): Promise<StoreResult>;
    remove(id: unknown, expect?: (current: WorkflowTemplate | undefined) => boolean): Promise<StoreResult>;
  };
  /** Host switches a person turns on (the 자문 switch is kept here). */
  readonly host: {
    read(key: Exclude<HostSettingKey, 'advisor'>): Promise<boolean>;
    write(key: Exclude<HostSettingKey, 'advisor'>, value: boolean, person: SettingsPerson): Promise<void>;
  };
  /** A workflow's 자동 승인 and 반복 (only a person sets them). */
  readonly workflow?: {
    read(projectId: string, subprojectId: string): Promise<{ readonly title: string; readonly revision: number; readonly autoApprove: boolean; readonly repeat: WorkflowRepeat | null } | undefined>;
    /** Applies at `revision` (the one the proposal showed): a workflow saved since is refused, so 반복 pins what was proposed. */
    write(projectId: string, subprojectId: string, set: { readonly autoApprove?: boolean; readonly repeat?: WorkflowRepeat }, person: SettingsPerson, revision: number): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  };
  /** Raises the proposal as a turn-less approval in the conversation; its approval id, or undefined. */
  /** Where a raised proposal's approval stands now (the person writing again expires it). */
  readonly approvalState?: (approvalId: string) => 'pending' | 'allowed' | 'denied' | 'expired' | undefined;
  readonly raiseApproval: (input: {
    readonly sessionId: string;
    readonly providerRequestId: string;
    readonly risk: 'write' | 'danger';
    readonly title: string;
    readonly detail: string;
    readonly request: ApprovalRequest;
  }) => Promise<string | undefined>;
  /** Whether the host's people read Korean (proposal rows and risk sentences). */
  readonly korean: () => Promise<boolean>;
  readonly onChanged?: (event: SettingsChangedEvent) => void;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** A refused request: the message tells the AI (or the person) exactly why. */
export class SettingsError extends Error {
  constructor(readonly code: 'invalid' | 'needs-person' | 'not-found' | 'limit' | 'unavailable' | 'conflict', message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

interface Edit {
  readonly domain: SettingsDomain;
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
}
interface HostEdit { readonly key: HostSettingKey; readonly before: boolean; readonly after: boolean }
interface WorkflowEdit {
  readonly projectId: string;
  readonly subprojectId: string;
  readonly title: string;
  /** The workflow revision the proposal was made at (applied only at it). */
  readonly revision: number;
  readonly field: 'autoApprove' | 'repeat';
  readonly before: unknown;
  readonly after: unknown;
}
type Reason =
  | { readonly kind: 'agent-permission'; readonly name: string; readonly before: PermissionPreset; readonly after: PermissionPreset }
  | { readonly kind: 'stage-permission'; readonly template: string; readonly stage: string; readonly before: PermissionPreset; readonly after: PermissionPreset }
  | { readonly kind: 'host'; readonly key: HostSettingKey; readonly on: boolean }
  | { readonly kind: 'workflow'; readonly field: 'autoApprove' | 'repeat'; readonly title: string; readonly on: boolean };
interface Plan {
  readonly edits: readonly Edit[];
  readonly host: readonly HostEdit[];
  readonly workflow: readonly WorkflowEdit[];
  readonly reasons: readonly Reason[];
}

interface ProposalRecord {
  view: SettingsProposalView;
  readonly plan: Plan;
  readonly turnId?: string;
}

/** Key-sorted JSON, so equal values compare equal whatever order their keys were written in. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function rank(preset: unknown): number {
  return PERMISSION_RANK[preset as PermissionPreset] ?? 0;
}
function templateContent(template: WorkflowTemplate | WorkflowTemplateInput): WorkflowTemplateInput {
  return { id: template.id, title: template.title, description: template.description, graph: template.graph };
}

function lower(left: PermissionPreset, right: PermissionPreset | undefined): PermissionPreset {
  return right !== undefined && rank(right) < rank(left) ? right : left;
}

/**
 * Who may change a setting is decided by the field that changes: a permission raised above what it is
 * (a new agent or stage starts at 승인 후 실행) needs a person; host switches and a workflow's 자동 승인 or
 * 반복 always do. Everything else applies now. `earlier` is what the same id held before it was removed,
 * so removing and saving it again starts no higher than it was.
 */
function reasonsFor(edit: Edit, earlier?: unknown): Reason[] {
  if (edit.domain === 'agent' && edit.after) {
    const before = edit.before as ChatAgentProfile | null;
    const after = edit.after as ChatAgentProfile;
    const base = before?.permissionPreset ?? lower(NEW_ENTRY_PERMISSION, (earlier as ChatAgentProfile | null | undefined)?.permissionPreset);
    return rank(after.permissionPreset) > rank(base) ? [{ kind: 'agent-permission', name: after.name, before: base, after: after.permissionPreset }] : [];
  }
  if (edit.domain === 'template' && edit.after) {
    const before = edit.before as WorkflowTemplateInput | null;
    const after = edit.after as WorkflowTemplateInput;
    const removed = before ? undefined : (earlier as WorkflowTemplateInput | null | undefined);
    return after.graph.nodes.flatMap((node): Reason[] => {
      const previous = before?.graph.nodes.find((entry) => entry.id === node.id);
      const base = previous?.permissionPreset ?? lower(NEW_ENTRY_PERMISSION, removed?.graph.nodes.find((entry) => entry.id === node.id)?.permissionPreset);
      return rank(node.permissionPreset) > rank(base)
        ? [{ kind: 'stage-permission', template: after.title, stage: node.title, before: base, after: node.permissionPreset }] : [];
    });
  }
  return [];
}

/**
 * Settings an AI may change from a conversation a person sees directly. Applies view settings, agents,
 * 단계 연결 and templates now (with history and undo, `settings-changes.json`); raises everything else as
 * a proposal the person applies. Every operation runs one at a time.
 */
export class SettingsAuthority {
  private readonly history: JsonFile;
  private readonly advisorFile: JsonFile;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly proposals = new Map<string, ProposalRecord>();
  private changes: readonly SettingsChangeRecord[] = [];
  private advisor = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SettingsAuthorityOptions) {
    this.history = new JsonFile(options.dir, HISTORY_FILE);
    this.advisorFile = new JsonFile(options.dir, ADVISOR_FILE);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async init(): Promise<void> {
    await this.history.init();
    this.changes = (await this.history.readValidated(validateHistory, EMPTY_HISTORY)).changes;
    await this.advisorFile.init();
    this.advisor = (await this.advisorFile.readValidated(validateAdvisor, { version: 1, enabled: false })).enabled;
  }

  /** 자문 (`ask_advisor`): off until a person turns it on. */
  advisorEnabled(): boolean {
    return this.advisor;
  }

  /** The person's Settings switch for 자문. */
  setAdvisor(enabled: boolean): Promise<boolean> {
    return this.run(async () => {
      await this.writeAdvisor(enabled);
      this.emit(['host']);
      return this.advisor;
    });
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.history.flush();
    await this.advisorFile.flush();
  }

  // ── The AI's tools ──────────────────────────────────────────────────────────────────────────────────

  /** settings_read: the values an AI may change, and what it changed and proposed in this conversation. */
  read(context: SettingsAiContext, templateId?: string): Promise<Record<string, unknown>> {
    return this.run(async () => {
      const ko = await this.options.korean();
      if (templateId !== undefined) {
        const template = this.options.templates.list().find((entry) => entry.id === templateId);
        if (!template) throw new SettingsError('not-found', 'Unknown templateId. Built-in templates cannot be changed; read the saved ones first.');
        return { template: templateContent(template) };
      }
      const view = await this.conversationView(context.sessionId);
      return {
        ui: await this.options.ui.read(),
        choices: {
          themes: await this.options.ui.themes(),
          fonts: this.options.ui.fonts.map((font) => font.id),
          effects: this.options.ui.effectIds,
        },
        agents: this.options.profiles.list(),
        phases: this.options.profiles.phases(),
        templates: this.options.templates.list().map((template) => ({
          id: template.id, title: template.title, description: template.description,
          stages: template.graph.nodes.map((node) => ({ id: node.id, title: node.title, permissionPreset: node.permissionPreset })),
        })),
        host: {
          orchestration: await this.options.host.read('orchestration'),
          advisor: this.advisor,
          remoteAccess: await this.options.host.read('remoteAccess'),
          startAtLogin: await this.options.host.read('startAtLogin'),
        },
        changedHere: view.changes.map((change) => ({
          changeId: change.id, at: change.at, change: settingsChangeLine(this.label(change, ko)),
          state: change.undone ? 'undone' : change.conflict ? 'changed-since' : 'applied',
        })),
        proposedHere: view.proposals.map((proposal) => ({ proposalId: proposal.id, title: proposal.title, state: this.waiting(proposal) || proposal.state !== 'pending' ? proposal.state : 'expired', ...(proposal.detail ? { detail: proposal.detail } : {}) })),
      };
    });
  }

  /** settings_apply: changes that need no person, now, with history; refuses anything else. */
  apply(context: SettingsAiContext, raw: unknown): Promise<{ readonly changes: readonly { readonly changeId: string; readonly change: string }[] }> {
    return this.run(async () => {
      const plan = await this.plan(context.projectId, raw);
      if (plan.host.length || plan.workflow.length || plan.reasons.length) {
        throw new SettingsError('needs-person', `A person must apply this (${this.reasonText(plan.reasons, false)}). Use settings_propose with the same change; nothing was changed.`);
      }
      if (!plan.edits.length) return { changes: [] };
      const ko = await this.options.korean();
      const records = await this.writeEdits(plan.edits, { kind: 'ai', sessionId: context.sessionId, ...(context.turnId ? { turnId: context.turnId } : {}) });
      return { changes: records.map((record) => ({ changeId: record.id, change: settingsChangeLine(this.label(record, ko)) })) };
    });
  }

  /** settings_propose: shows the change to the person as an approval; nothing changes until they apply it. */
  propose(context: SettingsAiContext, raw: unknown): Promise<{ readonly proposalId: string; readonly title: string; readonly desktopOnly: boolean }> {
    return this.run(async () => {
      const plan = await this.plan(context.projectId, raw);
      if (!plan.edits.length && !plan.host.length && !plan.workflow.length) throw new SettingsError('invalid', 'These settings already have those values; nothing to propose.');
      const pending = [...this.proposals.values()].filter((entry) => entry.view.sessionId === context.sessionId && (entry.view.state === 'applying' || this.waiting(entry.view)));
      if (pending.length >= MAX_PENDING_PROPOSALS) throw new SettingsError('limit', `At most ${String(MAX_PENDING_PROPOSALS)} proposals can wait for the person at once.`);
      const ko = await this.options.korean();
      const id = this.createId();
      const rows = this.rows(plan, ko);
      const title = this.title(plan, rows, ko);
      const risk = this.risk(plan, ko);
      const desktopOnly = plan.host.length > 0 || plan.workflow.length > 0 || plan.reasons.length > 0
        || plan.edits.some((edit) => edit.domain !== 'ui' && edit.domain !== 'agent');
      const pcLine = desktopOnly ? `\n${ko ? 'PC에서만 적용할 수 있습니다.' : 'Only the PC can apply this.'}` : '';
      const body = `${rows.map(settingsChangeLine).join('\n')}\n\n${risk}${pcLine}`;
      const providerRequestId = `${SETTINGS_PROPOSAL_REQUEST_PREFIX}${id}`;
      // Known before the approval shows, so a quick decision finds it.
      const record: ProposalRecord = {
        view: { id, approvalId: '', sessionId: context.sessionId, at: this.now().toISOString(), title, rows, risk, desktopOnly, state: 'pending' },
        plan,
        ...(context.turnId ? { turnId: context.turnId } : {}),
      };
      this.proposals.set(id, record);
      const approvalId = await this.options.raiseApproval({
        sessionId: context.sessionId,
        providerRequestId,
        risk: plan.reasons.length || plan.host.some((edit) => edit.after) || plan.workflow.some((edit) => this.turnsOn(edit)) ? 'danger' : 'write',
        title: `${ko ? '설정 제안' : 'Settings proposal'}: ${title}`,
        detail: body.slice(0, 2_000),
        request: { v: 1, kind: 'tool', toolName: ko ? 'EZTerminal 설정' : 'EZTerminal settings', target: title.slice(0, 2_000), input: body.slice(0, 16_000) },
      }).catch(() => undefined);
      if (!approvalId) {
        this.proposals.delete(id);
        throw new SettingsError('unavailable', 'This conversation cannot show a proposal now.');
      }
      record.view = { ...record.view, approvalId };
      this.emit(['proposal']);
      return { proposalId: id, title, desktopOnly };
    });
  }

  /** settings_undo (AI, its own conversation's changes) and 되돌리기 (a person, any change). */
  undo(changeId: string, actor: SettingsActor): Promise<SettingsUndoResult> {
    return this.run(async (): Promise<SettingsUndoResult> => {
      const record = this.changes.find((entry) => entry.id === changeId);
      const own = record && actor.kind === 'ai' ? (record.actor.kind === 'ai' && record.actor.sessionId === actor.sessionId) || record.proposedBy?.sessionId === actor.sessionId : true;
      if (!record || !own) return { ok: false, error: 'not-found', message: 'Unknown changeId. Read settings_read for this conversation’s changes.' };
      if (record.undoOf) return { ok: false, error: 'not-found', message: 'An undo is not undone again; apply the change once more instead.' };
      if (this.changes.some((entry) => entry.undoOf === record.id)) return { ok: false, error: 'already-undone', message: 'This change was already undone.' };
      const current = await this.currentValue(record.domain, record.target);
      if (!same(current, record.after)) {
        return { ok: false, error: 'conflict', message: 'It changed again since; undo would overwrite that change, so nothing was changed.', current };
      }
      const inverse: Edit = { domain: record.domain, target: record.target, before: record.after, after: record.before };
      const reasons = reasonsFor(inverse);
      if (actor.kind === 'ai' && reasons.length) {
        return { ok: false, error: 'needs-person', message: `Undoing this would raise a permission (${this.reasonText(reasons, false)}); the person can press 되돌리기.` };
      }
      try {
        const [written] = await this.writeEdits([inverse], actor, { undoOf: record.id });
        return { ok: true, changeId: written!.id };
      } catch (error) {
        if (error instanceof SettingsError && error.code === 'conflict') {
          return { ok: false, error: 'conflict', message: 'It changed again since; undo would overwrite that change, so nothing was changed.', current: await this.currentValue(record.domain, record.target) };
        }
        return { ok: false, error: 'failed', message: error instanceof Error ? error.message : 'The change could not be undone.' };
      }
    });
  }

  // ── The person's decision on a proposal (daemon `permission.resolve`) ─────────────────────────────────

  /** Why this principal cannot decide this proposal this way, or undefined when it may. */
  authorizeProposal(input: { readonly providerRequestId: string; readonly principal: DaemonPrincipal; readonly decision: 'allow' | 'deny'; readonly response?: ApprovalResponse }): string | undefined {
    if (input.principal.kind !== 'desktop' && input.principal.kind !== 'android') return 'A person decides a settings proposal in EZTerminal; automations and agents cannot.';
    if (input.decision === 'deny') return undefined;
    if (input.response?.kind === 'session') return 'A settings proposal is applied once; it cannot be allowed for the whole conversation.';
    const record = this.proposals.get(input.providerRequestId.slice(SETTINGS_PROPOSAL_REQUEST_PREFIX.length));
    if (!record || record.view.state !== 'pending') return 'This proposal is no longer available. Ask the AI again if you still want it.';
    if (input.principal.kind === 'android' && record.view.desktopOnly) return 'Only the PC can apply this setting.';
    return undefined;
  }

  /** The approval resolved: a decline is recorded, an allow applies exactly the change shown, as that person. */
  proposalResolved(input: { readonly providerRequestId: string; readonly principal: DaemonPrincipal; readonly decision: 'allow' | 'deny' }): Promise<void> {
    const id = input.providerRequestId.slice(SETTINGS_PROPOSAL_REQUEST_PREFIX.length);
    const record = this.proposals.get(id);
    const by = input.principal.kind === 'android' ? 'android' as const : 'desktop' as const;
    if (!record || record.view.state !== 'pending') return Promise.resolve();
    if (input.decision === 'deny' || (input.principal.kind !== 'desktop' && input.principal.kind !== 'android')) {
      record.view = { ...record.view, state: 'declined', resolvedBy: by };
      this.emit(['proposal']);
      return Promise.resolve();
    }
    record.view = { ...record.view, state: 'applying', resolvedBy: by };
    this.emit(['proposal']);
    const person: SettingsPerson = { principal: by, id: input.principal.id };
    return this.run(async () => {
      try {
        await this.applyProposal(record, person);
        record.view = { ...record.view, state: 'applied' };
      } catch (error) {
        record.view = { ...record.view, state: 'failed', detail: error instanceof Error ? error.message : String(error) };
      }
      this.emit(['proposal']);
    });
  }

  // ── What the conversation shows ───────────────────────────────────────────────────────────────────────

  /** A proposal still waiting for the person (not expired with the conversation). */
  private waiting(view: SettingsProposalView): boolean {
    return view.state === 'pending' && (this.options.approvalState?.(view.approvalId) ?? 'pending') === 'pending';
  }

  conversation(sessionId: string): Promise<SettingsConversationView> {
    return this.run(() => this.conversationView(sessionId));
  }

  /** One change as the person reads it. */
  label(edit: Pick<SettingsChangeRecord, 'domain' | 'target' | 'before' | 'after'>, ko: boolean): SettingsProposalRow {
    return settingsEditLabel(edit, ko, {
      profileName: (id) => this.options.profiles.list().find((profile) => profile.id === id)?.name,
      fontName: (id) => this.options.ui.fonts.find((font) => font.id === id)?.label,
    });
  }

  private async conversationView(sessionId: string): Promise<SettingsConversationView> {
    const mine = this.changes.filter((record) => !record.undoOf
      && ((record.actor.kind === 'ai' && record.actor.sessionId === sessionId) || record.proposedBy?.sessionId === sessionId)).slice(-SHOWN_PER_CONVERSATION);
    const changes = await Promise.all(mine.map(async (record) => {
      const undone = this.changes.some((entry) => entry.undoOf === record.id);
      if (undone) return { ...record, undone, conflict: false };
      const current = await this.currentValue(record.domain, record.target);
      return same(current, record.after) ? { ...record, undone, conflict: false } : { ...record, undone, conflict: true, current };
    }));
    const proposals = [...this.proposals.values()].filter((entry) => entry.view.sessionId === sessionId).slice(-SHOWN_PER_CONVERSATION).map((entry) => entry.view);
    return { changes, proposals };
  }

  // ── Planning: what a change would do, field by field ──────────────────────────────────────────────────

  private async plan(projectId: string, raw: unknown): Promise<Plan> {
    const parsed = SettingsChangeSchema.safeParse(raw);
    if (!parsed.success) throw new SettingsError('invalid', `Invalid change: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'change'}: ${issue.message}`).join('; ')}`);
    const change = parsed.data;
    const edits: Edit[] = [];
    const host: HostEdit[] = [];
    const workflow: WorkflowEdit[] = [];
    switch (change.domain) {
      case 'ui': edits.push(...await this.planUi(change.set)); break;
      case 'agent': {
        const profiles = this.options.profiles.list();
        if ('remove' in change) {
          const existing = profiles.find((profile) => profile.id === change.remove);
          if (!existing) throw new SettingsError('not-found', 'Unknown agent id. Read settings_read first.');
          edits.push({ domain: 'agent', target: existing.id, before: existing, after: null });
        } else {
          const existing = profiles.find((profile) => profile.id === change.profile.id) ?? null;
          if (!same(existing, change.profile)) edits.push({ domain: 'agent', target: change.profile.id, before: existing, after: change.profile });
        }
        break;
      }
      case 'phase': {
        const before = this.options.profiles.phases();
        const after = this.patchPhases(before, change.set);
        if (!same(before, after)) edits.push({ domain: 'phase', target: 'phases', before, after });
        break;
      }
      case 'template': {
        const id = 'remove' in change ? change.remove : change.template.id;
        if (isBuiltinWorkflowTemplateId(id)) throw new SettingsError('invalid', 'Built-in templates cannot be changed; save a copy under a new id.');
        const stored = this.options.templates.list().find((template) => template.id === id);
        const before = stored ? templateContent(stored) : null;
        if ('remove' in change) {
          if (!before) throw new SettingsError('not-found', 'Unknown templateId. Read settings_read first.');
          edits.push({ domain: 'template', target: id, before, after: null });
        } else if (!same(before, change.template)) {
          edits.push({ domain: 'template', target: id, before, after: change.template });
        }
        break;
      }
      case 'host':
        for (const key of Object.keys(change.set) as HostSettingKey[]) {
          const after = change.set[key]!;
          const before = key === 'advisor' ? this.advisor : await this.options.host.read(key);
          if (before !== after) host.push({ key, before, after });
        }
        break;
      case 'workflow': {
        if (!this.options.workflow) throw new SettingsError('unavailable', 'Workflow settings are unavailable on this host.');
        const current = await this.options.workflow.read(projectId, change.subprojectId);
        if (!current) throw new SettingsError('not-found', 'Unknown subprojectId in this conversation’s project. Read workflow_read first.');
        if (change.set.autoApprove !== undefined && change.set.autoApprove !== current.autoApprove) {
          workflow.push({ projectId, subprojectId: change.subprojectId, title: current.title, revision: current.revision, field: 'autoApprove', before: current.autoApprove, after: change.set.autoApprove });
        }
        if (change.set.repeat && !same(current.repeat, change.set.repeat)) {
          workflow.push({ projectId, subprojectId: change.subprojectId, title: current.title, revision: current.revision, field: 'repeat', before: current.repeat, after: change.set.repeat });
        }
        break;
      }
    }
    const reasons: Reason[] = [
      ...edits.flatMap((edit) => reasonsFor(edit, edit.before === null ? this.lastKnown(edit.domain, edit.target) : undefined)),
      ...host.map((edit): Reason => ({ kind: 'host', key: edit.key, on: edit.after })),
      ...workflow.map((edit): Reason => ({ kind: 'workflow', field: edit.field, title: edit.title, on: this.turnsOn(edit) })),
    ];
    return { edits, host, workflow, reasons };
  }

  private async planUi(set: UiSettingsPatch): Promise<Edit[]> {
    const current = await this.options.ui.read();
    const edits: Edit[] = [];
    if (set.theme !== undefined && !(await this.options.ui.themes()).includes(set.theme)) throw new SettingsError('invalid', `Unknown theme. Choose one of settings_read choices.themes.`);
    if (set.font && !this.options.ui.fonts.some((font) => font.id === set.font)) throw new SettingsError('invalid', 'Unknown font. Choose one of settings_read choices.fonts, or null for the theme’s own font.');
    const unknownEffect = Object.keys(set.effects ?? {}).find((id) => !this.options.ui.effectIds.includes(id));
    if (unknownEffect) throw new SettingsError('invalid', `Unknown effect "${unknownEffect}". Choose from settings_read choices.effects.`);
    for (const field of ['theme', 'uiScale', 'font', 'effectIntensity', 'density', 'locale', 'scrollback'] as const) {
      if (set[field] === undefined) continue;
      const before = current[field] ?? null;
      const after = set[field] ?? null;
      if (!same(before, after)) edits.push({ domain: 'ui', target: field, before, after });
    }
    for (const [id, value] of Object.entries(set.effects ?? {})) {
      const before = current.effects[id] ?? null;
      if (before !== value) edits.push({ domain: 'ui', target: `effects.${id}`, before, after: value });
    }
    return edits;
  }

  private patchPhases(current: ChatAgentPhaseMap, set: PhasePatch): ChatAgentPhaseMap {
    const profiles = this.options.profiles.list();
    const byProvider: Record<string, { plan?: { profileId: string }; implement?: { profileId: string } }> = Object.fromEntries(
      Object.entries(current.byProvider).map(([provider, links]) => [provider, { ...links }]),
    );
    for (const phase of ['plan', 'implement'] as const) {
      for (const [provider, profileId] of Object.entries(set[phase] ?? {})) {
        const entry = byProvider[provider] ?? {};
        if (profileId === null) delete entry[phase];
        else {
          const profile = profiles.find((candidate) => candidate.id === profileId);
          if (!profile) throw new SettingsError('not-found', `Unknown agent "${profileId}". Read settings_read agents.`);
          if (profile.providerId !== provider) throw new SettingsError('invalid', `The ${phase} agent of a ${provider} conversation must be a ${provider} agent (a conversation keeps its AI).`);
          entry[phase] = { profileId };
        }
        if (entry.plan || entry.implement) byProvider[provider] = entry;
        else delete byProvider[provider];
      }
    }
    let review = current.review;
    if (set.review === null) review = undefined;
    else if (set.review !== undefined) {
      if (!profiles.some((candidate) => candidate.id === set.review)) throw new SettingsError('not-found', `Unknown agent "${set.review}". Read settings_read agents.`);
      review = { profileId: set.review };
    }
    return { byProvider, ...(review ? { review } : {}), switchModel: set.switchModel ?? current.switchModel };
  }

  private turnsOn(edit: WorkflowEdit): boolean {
    return edit.field === 'autoApprove' ? edit.after === true : (edit.after as WorkflowRepeat | null)?.enabled === true;
  }

  // ── Reading and writing one field ─────────────────────────────────────────────────────────────────────

  /** The latest value the history saw for this id (what it held before a removal), or undefined. */
  private lastKnown(domain: SettingsDomain, target: string): unknown {
    for (let index = this.changes.length - 1; index >= 0; index -= 1) {
      const record = this.changes[index]!;
      if (record.domain !== domain || record.target !== target) continue;
      const value = record.after ?? record.before;
      if (value !== null && value !== undefined) return value;
    }
    return undefined;
  }

  private async currentValue(domain: SettingsDomain, target: string): Promise<unknown> {
    switch (domain) {
      case 'ui': {
        const values = await this.options.ui.read();
        if (target.startsWith('effects.')) return values.effects[target.slice('effects.'.length)] ?? null;
        return (values as unknown as Record<string, unknown>)[target] ?? null;
      }
      case 'agent': return this.options.profiles.list().find((profile) => profile.id === target) ?? null;
      case 'phase': return this.options.profiles.phases();
      case 'template': {
        const stored = this.options.templates.list().find((template) => template.id === target);
        return stored ? templateContent(stored) : null;
      }
    }
  }

  /** Writes edits through the same stores the Settings screen uses and records each in the history. */
  private async writeEdits(edits: readonly Edit[], actor: SettingsActor, extra: { readonly undoOf?: string; readonly proposedBy?: SettingsChangeRecord['proposedBy'] } = {}): Promise<SettingsChangeRecord[]> {
    const ui = edits.filter((edit) => edit.domain === 'ui');
    if (ui.length) {
      const current = await this.options.ui.read();
      const patch: Record<string, unknown> = {};
      let effects: Record<string, boolean> | undefined;
      for (const edit of ui) {
        if (edit.target.startsWith('effects.')) {
          effects ??= { ...current.effects };
          const id = edit.target.slice('effects.'.length);
          if (edit.after === null) delete effects[id];
          else effects[id] = edit.after as boolean;
        } else patch[edit.target] = edit.after;
      }
      await this.options.ui.write({ ...(patch as UiSettingsWrite), ...(effects ? { effects } : {}) });
    }
    // Each store compares what it holds with what this edit was planned from inside its own write, so a
    // person's save that lands first (a lowered permission, say) is never overwritten.
    const fail = (result: StoreResult): void => {
      if (result.ok) return;
      throw result.conflict ? new SettingsError('conflict', 'It changed since it was read (someone saved it meanwhile); nothing was changed.') : new SettingsError('invalid', result.error);
    };
    for (const edit of edits) {
      if (edit.domain === 'agent') {
        const expect = (current: ChatAgentProfile | undefined): boolean => same(current ?? null, edit.before ?? null);
        fail(edit.after ? await this.options.profiles.save(edit.after, expect) : await this.options.profiles.remove(edit.target, expect));
      } else if (edit.domain === 'phase') {
        fail(await this.options.profiles.savePhases(edit.after, (current) => same(current, edit.before)));
      } else if (edit.domain === 'template') {
        const expect = (current: WorkflowTemplate | undefined): boolean => same(current ? templateContent(current) : null, edit.before ?? null);
        fail(edit.after ? await this.options.templates.save(edit.after, expect) : await this.options.templates.remove(edit.target, expect));
      }
    }
    const at = this.now().toISOString();
    const records = edits.map((edit): SettingsChangeRecord => ({
      id: this.createId(), at, actor, domain: edit.domain, target: edit.target, before: edit.before ?? null, after: edit.after ?? null,
      ...(extra.undoOf ? { undoOf: extra.undoOf } : {}), ...(extra.proposedBy ? { proposedBy: extra.proposedBy } : {}),
    }));
    const next = await this.history.update(validateHistory, EMPTY_HISTORY, (file) => ({ version: 1 as const, changes: [...file.changes, ...records].slice(-MAX_SETTINGS_CHANGES) }), 'record settings change');
    this.changes = next?.changes ?? [...this.changes, ...records].slice(-MAX_SETTINGS_CHANGES);
    this.emit([...new Set(edits.map((edit) => edit.domain))]);
    return records;
  }

  private async applyProposal(record: ProposalRecord, person: SettingsPerson): Promise<void> {
    const { plan } = record;
    const ko = await this.options.korean();
    const changedSince = ko ? '그 뒤 설정이 바뀌어 적용하지 않았습니다. 필요하면 AI에게 다시 요청하세요' : 'The setting changed since; nothing was applied. Ask the AI again if you still want it';
    for (const edit of plan.edits) if (!same(await this.currentValue(edit.domain, edit.target), edit.before)) throw new Error(changedSince);
    for (const edit of plan.host) if ((edit.key === 'advisor' ? this.advisor : await this.options.host.read(edit.key)) !== edit.before) throw new Error(changedSince);
    for (const edit of plan.workflow) {
      const current = await this.options.workflow?.read(edit.projectId, edit.subprojectId);
      // A workflow saved since the proposal is not the one the person saw: 반복 would pin the newer one.
      if (!current || current.revision !== edit.revision || !same(edit.field === 'autoApprove' ? current.autoApprove : current.repeat, edit.before)) throw new Error(changedSince);
    }
    if (plan.edits.length) {
      await this.writeEdits(plan.edits, { kind: 'person', principal: person.principal, id: person.id },
        { proposedBy: { sessionId: record.view.sessionId, ...(record.turnId ? { turnId: record.turnId } : {}) } });
    }
    for (const edit of plan.host) {
      if (edit.key === 'advisor') await this.writeAdvisor(edit.after);
      else await this.options.host.write(edit.key, edit.after, person);
    }
    for (const edit of plan.workflow) {
      const result = await this.options.workflow!.write(edit.projectId, edit.subprojectId, { [edit.field]: edit.after } as { autoApprove?: boolean; repeat?: WorkflowRepeat }, person, edit.revision);
      if (!result.ok) throw new Error(result.message);
    }
    if (plan.host.length) this.emit(['host']);
  }

  private async writeAdvisor(enabled: boolean): Promise<void> {
    const next = await this.advisorFile.update(validateAdvisor, { version: 1, enabled: false }, () => ({ version: 1 as const, enabled }), 'save advisor switch');
    if (!next) throw new Error('The 자문 switch could not be saved.');
    this.advisor = next.enabled;
  }

  // ── Words ─────────────────────────────────────────────────────────────────────────────────────────────

  private rows(plan: Plan, ko: boolean): SettingsProposalRow[] {
    const onOff = (value: boolean): string => (value ? (ko ? '켬' : 'On') : (ko ? '끔' : 'Off'));
    const hostName: Record<HostSettingKey, readonly [string, string]> = {
      orchestration: ['에이전트가 에이전트 만들기', 'Agents create agents'],
      advisor: ['자문 (ask_advisor)', 'Advisor (ask_advisor)'],
      remoteAccess: ['원격 접속', 'Remote access'],
      startAtLogin: ['로그인 시 시작', 'Start at login'],
    };
    const repeatText = (value: unknown): string => {
      const repeat = value as WorkflowRepeat | null;
      if (!repeat?.enabled) return onOff(false);
      const day = repeat.cadence === 'weekly' ? (ko ? `매주 ${['일', '월', '화', '수', '목', '금', '토'][repeat.weekday ?? 0]!}요일` : `Weekly (day ${String(repeat.weekday ?? 0)})`) : (ko ? '매일' : 'Daily');
      return `${day} ${repeat.time} (${repeat.timezone})`;
    };
    return [
      ...plan.edits.map((edit) => this.label(edit, ko)),
      ...plan.host.map((edit) => ({ name: hostName[edit.key][ko ? 0 : 1], before: onOff(edit.before), after: onOff(edit.after) })),
      ...plan.workflow.map((edit) => edit.field === 'autoApprove'
        ? { name: ko ? `자동 승인 · ${edit.title}` : `Auto-approve · ${edit.title}`, before: onOff(edit.before === true), after: onOff(edit.after === true) }
        : { name: ko ? `반복 · ${edit.title}` : `Repeat · ${edit.title}`, before: repeatText(edit.before), after: repeatText(edit.after) }),
    ];
  }

  private title(plan: Plan, rows: readonly SettingsProposalRow[], ko: boolean): string {
    const [reason] = plan.reasons;
    if (reason?.kind === 'agent-permission') return ko ? `에이전트 "${reason.name}" 권한 올리기` : `Raise agent "${reason.name}" permission`;
    if (reason?.kind === 'stage-permission') return ko ? `템플릿 "${reason.template}" 단계 권한 올리기` : `Raise a stage permission in "${reason.template}"`;
    if (reason?.kind === 'host' || reason?.kind === 'workflow') {
      const [row] = rows.slice(plan.edits.length);
      const verb = reason.on ? (ko ? '켜기' : 'on') : (ko ? '끄기' : 'off');
      return ko ? `${row?.name ?? ''} ${verb}`.trim() : `Turn ${verb} ${row?.name ?? ''}`.trim();
    }
    const first = rows[0]?.name ?? '';
    return rows.length > 1 ? (ko ? `${first} 외 ${String(rows.length - 1)}개 바꾸기` : `Change ${first} and ${String(rows.length - 1)} more`) : (ko ? `${first} 바꾸기` : `Change ${first}`);
  }

  private risk(plan: Plan, ko: boolean): string {
    const text = (korean: string, english: string): string => (ko ? korean : english);
    const sentences = plan.reasons.map((reason) => {
      switch (reason.kind) {
        case 'agent-permission': return reason.after === 'full-access'
          ? text('에이전트를 고치는 일이지만 권한을 올리는 변경이라 제안으로만 올라옵니다. 워크플로 단계에서는 전체 권한이 승인 후 실행으로 낮춰집니다.', 'Editing an agent, but it raises its permission, so it is only proposed. Workflow stages still lower full access to ask before running.')
          : text('에이전트를 고치는 일이지만 권한을 올리는 변경이라 제안으로만 올라옵니다.', 'Editing an agent, but it raises its permission, so it is only proposed.');
        case 'stage-permission': return text(`"${reason.stage}" 단계가 ${permissionName(reason.after, true)}(으)로 바뀝니다. 실행은 여전히 사람이 시작합니다.`, `Stage "${reason.stage}" becomes ${permissionName(reason.after, false)}. A person still starts every run.`);
        case 'host': {
          if (!reason.on) return text('끄는 변경입니다.', 'This turns it off.');
          switch (reason.key) {
            case 'remoteAccess': return text('켜면 페어링한 폰이 이 PC의 터미널과 대화를 조작할 수 있습니다. 페어링 코드는 따로 확인합니다.', 'Paired phones can then control this PC’s terminals and conversations. Pairing codes are confirmed separately.');
            case 'startAtLogin': return text('로그인하면 EZTerminal이 백그라운드에서 시작되어 예약 작업이 돕니다.', 'EZTerminal starts in the background at login and runs scheduled work.');
            case 'orchestration': return text('켜면 대화의 AI가 다른 에이전트를 만들어 일을 맡길 수 있습니다.', 'Conversation AIs can then create other agents and hand them work.');
            case 'advisor': return text('켜면 대화의 AI가 검토 에이전트에게 읽기 전용으로 자문을 구할 수 있습니다(횟수 제한).', 'Conversation AIs can then ask the review agent for advice, read-only and a few times per conversation.');
          }
          return '';
        }
        case 'workflow': return !reason.on ? text('끄는 변경입니다.', 'This turns it off.')
          : reason.field === 'repeat' ? text('정해진 시각에 자동으로 실행이 시작됩니다.', 'Runs start on their own at the set time.')
            : text('승인 단계와 결과 통합을 사람 대신 자동으로 넘깁니다.', 'Approval stages and result integration pass without a person.');
      }
    });
    if (!sentences.length) return text('바로 적용할 수 있는 변경이지만 AI가 확인을 요청했습니다. 적용한 뒤 되돌릴 수 있습니다.', 'This could apply directly, but the AI asked you first. You can undo it afterwards.');
    return [...new Set(sentences)].join(' ');
  }

  private reasonText(reasons: readonly Reason[], ko: boolean): string {
    if (!reasons.length) return ko ? '사람만 바꾸는 설정' : 'a setting only a person changes';
    return reasons.map((reason) => {
      switch (reason.kind) {
        case 'agent-permission': return `agent "${reason.name}" permission ${reason.before} → ${reason.after}`;
        case 'stage-permission': return `stage "${reason.stage}" permission ${reason.before} → ${reason.after}`;
        case 'host': return `${reason.key} ${reason.on ? 'on' : 'off'}`;
        case 'workflow': return `${reason.field} ${reason.on ? 'on' : 'off'} for "${reason.title}"`;
      }
      return '';
    }).join(', ');
  }

  private emit(domains: readonly SettingsChangedDomain[]): void {
    try {
      this.options.onChanged?.({ domains });
    } catch {
      // A notification never breaks a settings change.
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateHistory(raw: unknown): SettingsChangeFile | null {
  const parsed = SettingsChangeFileSchema.safeParse(raw);
  return parsed.success ? parsed.data as SettingsChangeFile : null;
}

function validateAdvisor(raw: unknown): { readonly version: 1; readonly enabled: boolean } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  return value.version === 1 && typeof value.enabled === 'boolean' && Object.keys(value).length === 2 ? { version: 1, enabled: value.enabled } : null;
}

/**
 * Settings tools are offered only to a conversation a person sees directly: not a prepared (workflow
 * stage, review, planning) session, a scheduled run, an advisor, or a managed or provider-owned child.
 * With `turnPrincipal` (each call), the turn running now must also be one a person sent — not a
 * heartbeat, a report-back or another automation.
 */
export function settingsConversationAllowed(
  snapshot: Pick<DaemonSnapshot, 'sessions' | 'agents' | 'agentRelations'>,
  sessionId: string,
  options: { readonly prepared: boolean; readonly turnPrincipal?: DaemonPrincipal['kind'] | null },
): boolean {
  const session = snapshot.sessions.find((entry) => entry.id === sessionId);
  if (!session || session.kind !== 'agent' || session.archivedAt !== undefined || options.prepared) return false;
  if (/^(?:scheduled-agent|planning|advisor)-/u.test(sessionId)) return false;
  if (snapshot.agentRelations.some((relation) => relation.childSessionId === sessionId && !relation.detachedAt)) return false;
  if (options.turnPrincipal === undefined) return true;
  return options.turnPrincipal === 'desktop' || options.turnPrincipal === 'android';
}

/** `settings-changes:conversation|undo|advisor|set-advisor` for the desktop renderer (a person's actions, from an app window only). */
export function installSettingsChangesIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly authority: SettingsAuthority;
  readonly ready: Promise<unknown>;
  /** The desktop person behind an EZTerminal window's session surface, or null for any other sender. */
  readonly principal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
}): () => void {
  const { ipc, authority, ready, principal } = input;
  ipc.handle('settings-changes:conversation', async (event, clientId: unknown, sessionId: unknown) => {
    if (!principal(event, clientId)) return { changes: [], proposals: [] };
    await ready;
    return typeof sessionId === 'string' && sessionId ? authority.conversation(sessionId) : { changes: [], proposals: [] };
  });
  ipc.handle('settings-changes:undo', async (event, clientId: unknown, changeId: unknown) => {
    const person = principal(event, clientId);
    if (!person) return { ok: false, error: 'not-found', message: 'This window cannot undo settings changes.' };
    await ready;
    if (typeof changeId !== 'string' || !changeId) return { ok: false, error: 'not-found', message: 'This change is no longer available.' };
    return authority.undo(changeId, { kind: 'person', principal: 'desktop', id: person });
  });
  ipc.handle('settings-changes:advisor', async (event, clientId: unknown) => {
    if (!principal(event, clientId)) return false;
    await ready;
    return authority.advisorEnabled();
  });
  ipc.handle('settings-changes:set-advisor', async (event, clientId: unknown, enabled: unknown) => {
    await ready;
    if (!principal(event, clientId)) return authority.advisorEnabled();
    return typeof enabled === 'boolean' ? authority.setAdvisor(enabled) : authority.advisorEnabled();
  });
  return () => {
    for (const channel of ['conversation', 'undo', 'advisor', 'set-advisor']) ipc.removeHandler(`settings-changes:${channel}`);
  };
}
