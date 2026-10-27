import {
  ArrowLeft,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Save,
  SquareTerminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlanningCommand,
  PlanningItem,
  PlanningMutationResult,
  PlanningOperation,
  PlanningReadResult,
  PlanningSnapshot,
} from "../shared/planning";
import { PlanningCommandSchema } from "../shared/planning";
import { selectPlanningTasks } from "../shared/planning-selection";
import { useAppTranslation } from "./i18n";
import { useAgentStateLabel } from "./agent-state-label";
import { PlanningLinkEditor } from "./PlanningLinkEditor";
import { PlanningStructureEditor } from "./PlanningStructureEditor";
import {
  ProjectArchivePanel,
  type ProjectArchiveAccess,
} from "./ProjectArchivePanel";
import {
  PlanningWorkspaceDraftSchema,
  type PlanningDraftStorage,
  type PlanningWorkspaceDraft,
  type PlanningEntityDrafts,
} from "./planning-draft-state";
import { PlanningTaskEditor } from "./PlanningTaskEditor";
import { PlanningProfileEditor } from "./PlanningProfileEditor";
import { SceneDesigner } from "./planning/SceneDesigner";
import {
  PlanningQuickTaskCard,
  createQuickTaskDraft,
} from "./PlanningQuickTaskCard";
import { planningProfilePresets } from "../shared/planning-profile-presets";
import {
  PlanningExecutionPanel,
  type PlanningExecutionAccess,
} from "./PlanningExecutionPanel";
import type { PlanningRunRequest } from "../shared/planning-run";
import type { ProjectArchiveRequest } from "../shared/project-archive";
import type { PlanningAssetApi } from "../shared/planning-asset";
import type { PlanningAiRequest } from "../shared/planning-ai";
import {
  PlanningAiPanel,
  type PlanningAiAccess,
} from "./planning/PlanningAiPanel";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingState,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "./ui";
import "./planning-workspace.css";

export type PlanningWorkspaceSection =
  "overview" | "planning" | "design" | "chat" | "tasks" | "review";
export interface PlanningWorkspaceAccess {
  getPlanningSnapshot(projectId: string, subprojectId?: string): Promise<PlanningReadResult>;
  executePlanningCommand(
    command: PlanningCommand,
  ): Promise<PlanningMutationResult>;
}
export type { PlanningConversation } from "./workflow/workflow-conversations";
import type { PlanningConversation } from "./workflow/workflow-conversations";
export interface PlanningWorkspacePanelProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly subprojectId?: string;
  readonly access: PlanningWorkspaceAccess;
  readonly initialSection?: PlanningWorkspaceSection;
  readonly initialRunId?: string;
  readonly mobile?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly draftStorage?: PlanningDraftStorage;
  readonly executionAccess?: PlanningExecutionAccess;
  readonly archiveAccess?: ProjectArchiveAccess;
  readonly assetApi?: PlanningAssetApi;
  readonly aiAccess?: PlanningAiAccess;
  readonly onBack?: () => void;
  readonly onNewConversation?: () => void;
  readonly conversations?: readonly PlanningConversation[];
  readonly conversationError?: string;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenTerminal?: () => void;
  readonly onOpenFiles?: () => void;
  readonly onExportScene?: (name: string, content: string) => Promise<void>;
  /** Inside the project workspace, which already owns the project header, back and refresh. */
  readonly embedded?: boolean;
}

const SECTIONS: readonly PlanningWorkspaceSection[] = [
  "overview",
  "planning",
  "design",
  "chat",
  "tasks",
  "review",
];
const KINDS: readonly PlanningItem["kind"][] = [
  "requirement",
  "feature",
  "information",
  "flow",
  "decision",
];
const identity = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
type ItemEdit = { item: PlanningItem; acceptanceText: string; dirty: boolean };
const emptyEntityDrafts = (): PlanningEntityDrafts => ({
  tasks: {},
  profiles: {},
  scenes: {},
  components: {},
});
function reconcileEntityDrafts<T extends { id: string }>(
  drafts: Record<string, { value: T; dirty: boolean }>,
  entities: T[],
  saved: ReadonlySet<string>,
): Record<string, { value: T; dirty: boolean }> {
  return Object.fromEntries(
    Object.entries(drafts).flatMap(([id, draft]) => {
      if (draft.dirty && !saved.has(id)) return [[id, draft]];
      const value = entities.find((entity) => entity.id === id);
      return value ? [[id, { value, dirty: false }]] : [];
    }),
  );
}

/** One project surface and one list at a time. Dock hosts keep this mounted across tab changes. */
export function PlanningWorkspacePanel(
  props: PlanningWorkspacePanelProps,
): JSX.Element {
  return <PlanningWorkspaceContent key={`${props.projectId}:${props.subprojectId ?? ''}`} {...props} />;
}

function PlanningWorkspaceContent({
  projectId,
  projectName,
  subprojectId,
  access,
  initialSection = "overview",
  initialRunId,
  mobile = false,
  disabled = false,
  disabledReason,
  draftStorage,
  executionAccess: sourceExecutionAccess,
  archiveAccess,
  assetApi: sourceAssetApi,
  aiAccess: sourceAiAccess,
  onBack,
  onNewConversation,
  conversations = [],
  conversationError,
  onOpenConversation,
  onOpenTerminal,
  onOpenFiles,
  onExportScene,
  embedded = false,
}: PlanningWorkspacePanelProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const stateLabel = useAgentStateLabel();
  const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const copy = (ko: string, en: string): string => (korean ? ko : en);
  const scopeRun = useCallback((request: PlanningRunRequest): PlanningRunRequest => subprojectId ? { ...request, subprojectId } : request, [subprojectId]);
  const scopeAi = useCallback((request: PlanningAiRequest): PlanningAiRequest => !subprojectId ? request : request.type === 'start' ? { ...request, request: { ...request.request, subprojectId } } : { ...request, subprojectId }, [subprojectId]);
  const executionAccess = useMemo<PlanningExecutionAccess | undefined>(() => sourceExecutionAccess ? {
    getPlanningExecutionSnapshot: async id => { const result = await sourceExecutionAccess.getPlanningExecutionSnapshot(id, subprojectId); if (!result.ok || !subprojectId) return result; return { ...result, snapshot: { ...result.snapshot, runs: result.snapshot.runs.filter(run => run.preparation.subprojectId === subprojectId || subprojectId === 'legacy-default' && !run.preparation.subprojectId) } }; },
    executePlanningRun: request => sourceExecutionAccess.executePlanningRun(scopeRun(request)),
    getDaemonSnapshot: () => sourceExecutionAccess.getDaemonSnapshot(),
    listDaemonProviderModels: id => sourceExecutionAccess.listDaemonProviderModels(id),
    ...(sourceExecutionAccess.readPlanningResult ? { readPlanningResult: (query: Parameters<NonNullable<PlanningExecutionAccess["readPlanningResult"]>>[0]) => sourceExecutionAccess.readPlanningResult!(subprojectId ? { ...query, subprojectId } : query) } : {}),
  } : undefined, [sourceExecutionAccess, subprojectId, scopeRun]);
  const assetApi = useMemo<PlanningAssetApi | undefined>(() => sourceAssetApi ? { executePlanningAsset: request => sourceAssetApi.executePlanningAsset(subprojectId ? { ...request, subprojectId } : request) } : undefined, [sourceAssetApi, subprojectId]);
  const aiAccess = useMemo<PlanningAiAccess | undefined>(() => sourceAiAccess ? { planningAiRequest: request => sourceAiAccess.planningAiRequest(scopeAi(request)), getDaemonSnapshot: () => sourceAiAccess.getDaemonSnapshot(), listDaemonProviderModels: id => sourceAiAccess.listDaemonProviderModels(id) } : undefined, [sourceAiAccess, scopeAi]);
  const labels: Record<PlanningWorkspaceSection, string> = {
    overview: copy("개요", "Overview"),
    planning: copy("기획", "Planning"),
    design: copy("설계", "Design"),
    chat: copy("대화", "Conversations"),
    tasks: copy("작업", "Tasks"),
    review: copy("검토", "Review"),
  };
  const kinds: Record<PlanningItem["kind"], string> = {
    requirement: copy("요구사항", "Requirement"),
    feature: copy("기능", "Feature"),
    information: copy("정보 구조", "Information"),
    flow: copy("사용 흐름", "Flow"),
    decision: copy("결정", "Decision"),
  };
  const statusLabel = (status: PlanningItem["status"]): string =>
    status === "ready"
      ? copy("검토 완료", "Reviewed")
      : status === "review-needed"
        ? copy("재검토 필요", "Needs review")
        : copy("초안", "Draft");
  const [section, setSection] = useState(initialSection);
  const [snapshot, setSnapshot] = useState<PlanningSnapshot | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [planningView, setPlanningView] = useState<
    "documents" | "information" | "flow" | "ai"
  >("documents");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<PlanningCommand | null>(null);
  const [pendingRun, setPendingRun] = useState<PlanningRunRequest | null>(null);
  const [pendingArchive, setPendingArchive] =
    useState<ProjectArchiveRequest | null>(null);
  const [pendingAi, setPendingAi] = useState<PlanningAiRequest | null>(null);
  const [edits, setEdits] = useState<Record<string, ItemEdit>>({});
  const [entityDrafts, setEntityDrafts] =
    useState<PlanningEntityDrafts>(emptyEntityDrafts);
  const [definitionView, setDefinitionView] = useState<
    "tasks" | "profiles" | "execution"
  >(initialRunId ? "execution" : "tasks");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [baselineTitle, setBaselineTitle] = useState("");
  const [baselineTaskIds, setBaselineTaskIds] = useState<string[]>([]);
  const baselineSelection = useMemo(() => {
    if (!snapshot || baselineTaskIds.length === 0) return null;
    try { return { draft: selectPlanningTasks(snapshot.draft, baselineTaskIds), error: null }; }
    catch (reason) { return { draft: null, error: String(reason) }; }
  }, [snapshot, baselineTaskIds]);
  const [viewBaselineId, setViewBaselineId] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardKeys, setDiscardKeys] = useState<string[]>([]);
  const [quickTaskId, setQuickTaskId] = useState<string | null>(null);
  const [preparedBaselineId, setPreparedBaselineId] = useState<string>();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(!draftStorage);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [storageComparison, setStorageComparison] = useState<{
    state: PlanningWorkspaceDraft | null;
  } | null>(null);
  const storageQueue = useRef(Promise.resolve());
  const generation = useRef(0);
  const mounted = useRef(true);
  const mutating = useRef(false);

  const persist = useCallback(
    (state: PlanningWorkspaceDraft): Promise<void> => {
      if (!draftStorage) return Promise.resolve();
      const next = storageQueue.current
        .catch(() => undefined)
        .then(() => draftStorage.saveDraft({ ...state, ...(subprojectId ? { subprojectId } : {}) }));
      storageQueue.current = next;
      if (mounted.current) setStorageBusy(true);
      void next
        .then(
          () => {
            if (mounted.current) setStorageError(null);
          },
          (reason) => {
            if (mounted.current) {
              setStorageError(String(reason));
              setRecoveryBlocked(true);
            }
          },
        )
        .finally(() => {
          if (mounted.current && storageQueue.current === next)
            setStorageBusy(false);
        });
      return next;
    },
    [draftStorage, subprojectId],
  );

  useEffect(() => {
    if (!draftStorage) return;
    let current = true;
    setRecoveryReady(false);
    void draftStorage
      .loadDraft()
      .then((saved) => {
        if (!current) return;
        if (saved) {
          const state = PlanningWorkspaceDraftSchema.parse(saved);
          if (
            state.projectId !== projectId ||
            (state.snapshot && state.snapshot.projectId !== projectId) ||
            (state.uncertain && state.uncertain.projectId !== projectId)
          )
            throw new Error("Planning recovery project mismatch.");
          setSnapshot(state.snapshot);
          setSelectedId(state.selectedId);
          setEdits(state.edits);
          setUncertain(state.uncertain);
          setPendingRun(state.pendingRun ?? null);
          setPendingArchive(state.pendingArchive ?? null);
          setPendingAi(state.pendingAi ?? null);
          if (state.pendingArchive) setArchiveOpen(true);
          setEntityDrafts(state.entityDrafts);
          setQuickTaskId(
            Object.keys(state.entityDrafts.tasks).find((id) =>
              id.startsWith("quick-task-"),
            ) ?? null,
          );
        }
        setRecoveryReady(true);
      })
      .catch((reason) => {
        if (current) {
          setStorageError(String(reason));
          setRecoveryBlocked(true);
          setRecoveryReady(true);
        }
      });
    return () => {
      current = false;
    };
  }, [draftStorage, projectId]);

  useEffect(() => {
    if (!recoveryReady || recoveryBlocked) return;
    void persist({
      version: 1,
      projectId,
      snapshot,
      edits,
      entityDrafts,
      selectedId,
      uncertain,
      pendingRun,
      pendingArchive,
      pendingAi,
    }).catch(() => undefined);
  }, [
    persist,
    projectId,
    snapshot,
    edits,
    entityDrafts,
    selectedId,
    uncertain,
    pendingRun,
    pendingArchive,
    pendingAi,
    recoveryReady,
    recoveryBlocked,
  ]);

  const refresh = useCallback(async (): Promise<void> => {
    if (mutating.current || !recoveryReady) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await access.getPlanningSnapshot(projectId, subprojectId);
      if (!mounted.current || generation.current !== request) return;
      if (result.ok) {
        setSnapshot(result.snapshot);
        setEdits((current) =>
          Object.fromEntries(
            Object.entries(current).flatMap(([id, draft]) => {
              if (draft.dirty) return [[id, draft]];
              const item = result.snapshot.draft.items.find(
                (entry) => entry.id === id,
              );
              return item
                ? [
                    [
                      id,
                      {
                        item,
                        acceptanceText: item.acceptance.join("\n"),
                        dirty: false,
                      },
                    ],
                  ]
                : [];
            }),
          ),
        );
        setEntityDrafts((current) => ({
          tasks: reconcileEntityDrafts(
            current.tasks,
            result.snapshot.draft.tasks,
            new Set(),
          ),
          profiles: reconcileEntityDrafts(
            current.profiles,
            result.snapshot.draft.profiles,
            new Set(),
          ),
          scenes: reconcileEntityDrafts(
            current.scenes,
            result.snapshot.draft.scenes,
            new Set(),
          ),
          components: reconcileEntityDrafts(
            current.components,
            result.snapshot.draft.components,
            new Set(),
          ),
        }));
        setError(null);
      } else setError(result.error === "external-change" && korean
        ? "기획 파일이 앱 밖에서 변경되었습니다. 외부 변경을 검토하고 미저장 초안을 보존한 뒤 앱을 재시작하세요. 프로젝트를 다시 여는 것만으로는 해결되지 않습니다."
        : result.message);
    } catch (reason) {
      if (mounted.current && generation.current === request)
        setError(String(reason));
    } finally {
      if (mounted.current && generation.current === request) setLoading(false);
    }
  }, [access, projectId, subprojectId, recoveryReady, korean]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  const execute = async (command: PlanningCommand): Promise<void> => {
    if (mutating.current || disabled || !recoveryReady || recoveryBlocked)
      return;
    const checked = PlanningCommandSchema.safeParse(command);
    if (!checked.success) {
      setError(
        checked.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("\n"),
      );
      return;
    }
    mutating.current = true;
    generation.current += 1;
    setLoading(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    // Persist the command before transport so a crash never loses its identity.
    try {
      await persist({
        version: 1,
        projectId,
        snapshot,
        edits,
        entityDrafts,
        selectedId,
        uncertain: command,
        pendingRun,
        pendingArchive,
        pendingAi,
      });
    } catch {
      mutating.current = false;
      if (mounted.current) setBusy(false);
      return;
    }
    if (!mounted.current) {
      mutating.current = false;
      return;
    }
    setUncertain(command);
    try {
      const result = await access.executePlanningCommand(command);
      if (!mounted.current) return;
      if (!result.ok) {
        setError([result.error === "external-change" && korean
          ? "기획 파일이 앱 밖에서 변경되었습니다. 외부 변경을 검토하고 미저장 초안을 보존한 뒤 앱을 재시작하세요. 프로젝트를 다시 여는 것만으로는 해결되지 않습니다."
          : result.message, ...(result.issues ?? [])].join("\n"));
        setUncertain(result.error === "unavailable" ? command : null);
        return;
      }
      setSnapshot(result.snapshot);
      setUncertain(null);
      if (command.type === "planning.quick-freeze") {
        setQuickTaskId(null);
        setPreparedBaselineId(command.payload.baselineId);
        setSection("tasks");
        setDefinitionView("execution");
      }
      const savedIds = new Set(
        command.type === "planning.patch"
          ? command.payload.operations.flatMap((operation) =>
              "value" in operation ? [operation.value.id] : [operation.id],
            )
          : [],
      );
      if (command.type === "planning.quick-freeze")
        savedIds.add(command.payload.task.id);
      setEntityDrafts((current) => ({
        tasks: reconcileEntityDrafts(
          current.tasks,
          result.snapshot.draft.tasks,
          savedIds,
        ),
        profiles: reconcileEntityDrafts(
          current.profiles,
          result.snapshot.draft.profiles,
          savedIds,
        ),
        scenes: reconcileEntityDrafts(
          current.scenes,
          result.snapshot.draft.scenes,
          savedIds,
        ),
        components: reconcileEntityDrafts(
          current.components,
          result.snapshot.draft.components,
          savedIds,
        ),
      }));
      setNotice(
        copy(
          `저장됨 · 버전 ${result.revision}`,
          `Saved · revision ${result.revision}`,
        ),
      );
      if (command.type === "planning.patch") {
        setEdits((current) => {
          const next = { ...current };
          for (const operation of command.payload.operations) {
            if (operation.op === "item.put") {
              const saved = result.snapshot.draft.items.find(
                (item) => item.id === operation.value.id,
              );
              if (saved)
                next[saved.id] = {
                  item: saved,
                  acceptanceText: saved.acceptance.join("\n"),
                  dirty: false,
                };
            } else if (
              operation.op === "entity.delete" &&
              operation.kind === "item"
            )
              delete next[operation.id];
          }
          return next;
        });
      }
      if (
        command.type === "planning.branch" ||
        command.type === "planning.undo"
      ) {
        setEdits({});
        setEntityDrafts(emptyEntityDrafts());
        setSelectedId(null);
      }
      if (command.type === "planning.freeze") setBaselineTitle("");
      setDeleteId(null);
      setBranchId(null);
    } catch (reason) {
      if (mounted.current) {
        setError(String(reason));
        setUncertain(command);
      }
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const envelope = () => ({
    commandId: identity("planning"),
    projectId,
    ...(subprojectId ? { subprojectId } : {}),
    expectedRevision: snapshot?.revision ?? 0,
    actor: { kind: "user" as const, id: "planning-ui" },
  });
  const patch = (operations: PlanningOperation[], summary: string): void => {
    if (!snapshot || uncertain) return;
    void execute({
      ...envelope(),
      type: "planning.patch",
      payload: { operations, summary },
    });
  };
  const selectItem = (item: PlanningItem): void => {
    setSelectedId(item.id);
    setEdits((current) =>
      current[item.id]
        ? current
        : {
            ...current,
            [item.id]: {
              item,
              acceptanceText: item.acceptance.join("\n"),
              dirty: false,
            },
          },
    );
  };
  const addItem = (): void => {
    const item: PlanningItem = {
      id: identity("item"),
      revision: 0,
      kind:
        kindFilter === "all"
          ? "requirement"
          : (kindFilter as PlanningItem["kind"]),
      title: "",
      body: "",
      acceptance: [],
      status: "draft",
      ...(kindFilter === "flow" ? { flowStep: { kind: "action" as const } } : {}),
    };
    setEdits((current) => ({
      ...current,
      [item.id]: { item, acceptanceText: "", dirty: true },
    }));
    setSelectedId(item.id);
    setSection("planning");
  };
  const edit = selectedId ? edits[selectedId] : undefined;
  const editItem = (update: Partial<PlanningItem>): void => {
    if (!selectedId) return;
    setEdits((current) => ({
      ...current,
      [selectedId]: {
        ...current[selectedId],
        item: { ...current[selectedId].item, ...update },
        dirty: true,
      },
    }));
  };
  const pendingCount =
    Object.values(edits).filter((value) => value.dirty).length +
    Object.values(entityDrafts).reduce(
      (sum, group) =>
        sum + Object.values(group).filter((value) => value.dirty).length,
      0,
    );
  const discardTargets = [
    ...Object.entries(edits)
      .filter(([, entry]) => entry.dirty)
      .map(([id, entry]) => ({
        key: `items:${id}`,
        title: entry.item.title || copy("제목 없는 문서", "Untitled document"),
      })),
    ...Object.entries(entityDrafts).flatMap(([kind, entries]) =>
      Object.entries(entries)
        .filter(([, entry]) => entry.dirty)
        .map(([id, entry]) => ({
          key: `${kind}:${id}`,
          title: entry.value.title || copy("제목 없는 초안", "Untitled draft"),
        })),
    ),
  ];
  const viewedBaseline = snapshot?.baselines.find(
    (entry) => entry.id === viewBaselineId,
  );
  const itemMap = new Map(
    snapshot?.draft.items.map((item) => [item.id, item]) ?? [],
  );
  for (const [id, value] of Object.entries(edits)) itemMap.set(id, value.item);
  const items = [...itemMap.values()].filter(
    (item) =>
      (kindFilter === "all" || item.kind === kindFilter) &&
      `${item.title}\n${item.body}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const locked = busy || Boolean(uncertain) || !recoveryReady;
  const writeLocked = locked || disabled || recoveryBlocked;
  const persistPendingRun = async (
    request: PlanningRunRequest | null,
  ): Promise<void> => {
    if (recoveryBlocked || !recoveryReady)
      throw new Error(
        copy(
          "기기 초안 복구를 먼저 완료하세요.",
          "Complete device draft recovery first.",
        ),
      );
    await persist({
      version: 1,
      projectId,
      snapshot,
      edits,
      entityDrafts,
      selectedId,
      uncertain,
      pendingRun: request ? scopeRun(request) : null,
      pendingArchive,
      pendingAi,
    });
    if (mounted.current) setPendingRun(request ? scopeRun(request) : null);
  };
  const persistPendingArchive = async (
    request: ProjectArchiveRequest | null,
  ): Promise<void> => {
    if (recoveryBlocked || !recoveryReady)
      throw new Error("Complete device draft recovery first.");
    await persist({
      version: 1,
      projectId,
      snapshot,
      edits,
      entityDrafts,
      selectedId,
      uncertain,
      pendingRun,
      pendingArchive: request,
      pendingAi,
    });
    if (mounted.current) setPendingArchive(request);
  };
  const persistPendingAi = async (
    request: PlanningAiRequest | null,
  ): Promise<void> => {
    if (recoveryBlocked || !recoveryReady)
      throw new Error("Complete device draft recovery first.");
    await persist({
      version: 1,
      projectId,
      snapshot,
      edits,
      entityDrafts,
      selectedId,
      uncertain,
      pendingRun,
      pendingArchive,
      pendingAi: request ? scopeAi(request) : null,
    });
    if (mounted.current) setPendingAi(request ? scopeAi(request) : null);
  };
  const aiOptions = aiAccess
    ? {
        access: aiAccess,
        pendingRequest: pendingAi,
        persistPendingRequest: persistPendingAi,
        onApplied: (next: PlanningSnapshot) => {
          setSnapshot(next);
          setEdits((current) =>
            Object.fromEntries(
              Object.entries(current).flatMap(([id, entry]) => {
                if (entry.dirty) return [[id, entry]];
                const item = next.draft.items.find((value) => value.id === id);
                return item
                  ? [
                      [
                        id,
                        {
                          item,
                          acceptanceText: item.acceptance.join("\n"),
                          dirty: false,
                        },
                      ],
                    ]
                  : [];
              }),
            ),
          );
          setEntityDrafts((current) => ({
            tasks: reconcileEntityDrafts(
              current.tasks,
              next.draft.tasks,
              new Set(),
            ),
            profiles: reconcileEntityDrafts(
              current.profiles,
              next.draft.profiles,
              new Set(),
            ),
            scenes: reconcileEntityDrafts(
              current.scenes,
              next.draft.scenes,
              new Set(),
            ),
            components: reconcileEntityDrafts(
              current.components,
              next.draft.components,
              new Set(),
            ),
          }));
        },
        onOpenConversation,
      }
    : undefined;
  const inspectStorage = async (): Promise<void> => {
    if (!draftStorage || storageBusy) return;
    setRecoveryBlocked(true);
    try {
      const stored = await draftStorage.loadDraft();
      const state = stored ? PlanningWorkspaceDraftSchema.parse(stored) : null;
      if (state && state.projectId !== projectId)
        throw new Error("Planning recovery project mismatch.");
      if (mounted.current) setStorageComparison({ state });
    } catch (reason) {
      if (mounted.current) setStorageError(String(reason));
    }
  };
  const keepLocalDraft = async (): Promise<void> => {
    try {
      await persist({
        version: 1,
        projectId,
        snapshot,
        edits,
        entityDrafts,
        selectedId,
        uncertain,
        pendingRun,
        pendingArchive,
        pendingAi,
      });
      if (mounted.current) {
        setStorageComparison(null);
        setRecoveryBlocked(false);
        setStorageError(null);
      }
    } catch {
      /* persist reports the storage error and preserves both drafts. */
    }
  };
  const stateBadge = (status: PlanningItem["status"]) => (
    <Badge
      size="sm"
      variant={
        status === "ready"
          ? "success"
          : status === "review-needed"
            ? "warning"
            : "neutral"
      }
    >
      {statusLabel(status)}
    </Badge>
  );

  /** What each section holds, shown beside its tab instead of as overview tiles. */
  const sectionCounts: Partial<Record<PlanningWorkspaceSection, number>> = snapshot
    ? {
        planning: snapshot.draft.items.length,
        design: snapshot.draft.scenes.length,
        tasks: snapshot.draft.tasks.length,
        review: snapshot.baselines.length,
      }
    : {};
  const revisionBadge = snapshot && (
    <Badge>
      {copy("초안", "Draft")} · r{snapshot.revision}
    </Badge>
  );
  const pendingActions = (
    <>
      {pendingArchive && (
        <Button
          size="sm"
          onClick={() => {
            setSection("review");
            setArchiveOpen(true);
          }}
        >
          {copy("보관 요청 확인", "Check archive request")}
        </Button>
      )}
      {pendingCount > 0 && (
        <Button
          size="sm"
          variant="ghost"
          disabled={locked}
          onClick={() => {
            setDiscardKeys([]);
            setDiscardOpen(true);
          }}
        >
          {copy(
            `미저장 변경 ${pendingCount}`,
            `${pendingCount} unsaved changes`,
          )}
        </Button>
      )}
    </>
  );
  return (
    <section
      className="planning-workspace"
      data-mobile={mobile || undefined}
      data-embedded={embedded || undefined}
      data-testid="planning-workspace"
    >
      {!embedded && <header className="planning-workspace__header">
        <div className="planning-workspace__identity">
          {onBack && (
            <IconButton
              icon={ArrowLeft}
              aria-label={copy("프로젝트 목록", "Projects")}
              onClick={onBack}
            />
          )}
          <div>
            <span className="planning-workspace__eyebrow">
              {copy("프로젝트", "PROJECT")}
            </span>
            <h1>{projectName}</h1>
          </div>
          {revisionBadge}
        </div>
        <div className="planning-workspace__actions">
          {pendingActions}
          {onOpenTerminal && (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<SquareTerminal />}
              onClick={onOpenTerminal}
            >
              {copy("터미널", "Terminal")}
            </Button>
          )}
          {onNewConversation && (
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<MessageSquarePlus />}
              onClick={onNewConversation}
            >
              {copy("새 대화", "New conversation")}
            </Button>
          )}
          <IconButton
            icon={RefreshCw}
            aria-label={copy("새로고침", "Refresh")}
            disabled={busy || loading}
            onClick={() => void refresh()}
          />
        </div>
      </header>}
      {disabled && (
        <p className="planning-workspace__message" role="status">
          {disabledReason ??
            copy(
              "오프라인입니다. 입력은 유지되며 연결 후 직접 저장할 수 있습니다.",
              "Offline. Your edits are retained; save them explicitly after reconnecting.",
            )}
        </p>
      )}
      {storageError && (
        <p className="planning-workspace__message" role="alert">
          {copy(
            "기기 초안 저장소를 사용할 수 없습니다. 이 화면을 유지하고 저장 공간을 확인하세요.",
            "Device draft storage is unavailable. Keep this screen open and check device storage.",
          )}{" "}
          {storageError}
          {draftStorage && (
            <Button
              size="sm"
              disabled={storageBusy || busy}
              onClick={() => void inspectStorage()}
            >
              {copy(
                "저장본과 현재 초안 비교",
                "Compare stored and current drafts",
              )}
            </Button>
          )}
        </p>
      )}
      {storageBusy && (
        <p className="planning-workspace__notice" role="status">
          {copy("기기에 초안 저장 중", "Saving draft on this device")}
        </p>
      )}
      <Tabs
        className="planning-workspace__tabs"
        value={section}
        onValueChange={(value) => setSection(value as PlanningWorkspaceSection)}
      >
        <div className="planning-workspace__navigation">
          <TabList label={copy("프로젝트 영역", "Project sections")}>
            {SECTIONS.map((value) => (
              <Tab key={value} value={value} data-count={sectionCounts[value] || undefined}>
                {labels[value]}
              </Tab>
            ))}
          </TabList>
          {onOpenFiles && (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<FolderOpen />}
              onClick={onOpenFiles}
            >
              {copy("파일", "Files")}
            </Button>
          )}
          {embedded && (
            <div className="planning-workspace__embedded-actions">
              {revisionBadge}
              {pendingActions}
            </div>
          )}
        </div>
        {(error || uncertain) && (
          <div className="planning-workspace__message" role="alert">
            <p>{error}</p>
            {uncertain && (
              <>
                <p>
                  {copy(
                    "저장 결과를 확인하지 못했습니다. 입력은 유지됩니다. 같은 요청의 결과를 확인한 후 계속하세요.",
                    "The save result is unknown. Your draft is retained. Check the same request before continuing.",
                  )}
                </p>
                <Button
                  size="sm"
                  disabled={busy || disabled}
                  onClick={() => void execute(uncertain)}
                >
                  {copy("저장 결과 확인", "Check save result")}
                </Button>
              </>
            )}
          </div>
        )}
        {notice && (
          <p className="planning-workspace__notice" role="status">
            {notice}
          </p>
        )}
        {!snapshot ? SECTIONS.map(value => (
          <TabPanel key={value} value={value} className="planning-workspace__page">
          {loading ? <LoadingState label={copy("프로젝트를 불러오는 중", "Loading project")} /> : <EmptyState
            title={copy("프로젝트를 불러올 수 없습니다", "Project unavailable")}
            action={
              <Button onClick={() => void refresh()}>
                {copy("다시 불러오기", "Reload")}
              </Button>
            }
          />}
          </TabPanel>
        )) : (
          <>
            <TabPanel value="overview" className="planning-workspace__page">
              <div className="planning-workspace__intro">
                <span className="planning-workspace__eyebrow">
                  {copy("다음 작업", "NEXT STEP")}
                </span>
                <h2>
                  {snapshot.draft.items.length
                    ? copy(
                        "기획을 연결하고, 실행 기준을 완성하세요",
                        "Connect your plan and define the execution baseline",
                      )
                    : copy(
                        "만들고 싶은 것부터 정리하세요",
                        "Start with what you want to build",
                      )}
                </h2>
                <p>
                  {copy(
                    "요구사항에서 화면, 작업, 검토 기준까지 하나의 프로젝트로 이어집니다. 대화와 터미널은 언제든 바로 사용할 수 있습니다.",
                    "Connect requirements, screens, tasks and review criteria in one project. Conversations and terminals are always available.",
                  )}
                </p>
                <Button
                  leadingIcon={<Plus />}
                  onClick={addItem}
                  disabled={locked}
                >
                  {copy("요구사항 작성", "Write a requirement")}
                </Button>
                {executionAccess && (
                  <Button
                    variant="secondary"
                    leadingIcon={<Plus />}
                    disabled={locked}
                    onClick={() => {
                      const existing = Object.values(entityDrafts.tasks).find(
                        (entry) => entry.value.id.startsWith("quick-task-"),
                      )?.value;
                      const task = existing ?? createQuickTaskDraft();
                      if (!existing)
                        setEntityDrafts((current) => ({
                          ...current,
                          tasks: {
                            ...current.tasks,
                            [task.id]: { value: task, dirty: true },
                          },
                        }));
                      setQuickTaskId(task.id);
                    }}
                  >
                    {copy("간단 작업", "Quick task")}
                  </Button>
                )}
              </div>
              {quickTaskId && entityDrafts.tasks[quickTaskId] && (
                <PlanningQuickTaskCard
                  task={entityDrafts.tasks[quickTaskId].value}
                  profiles={snapshot.draft.profiles}
                  disabled={writeLocked}
                  readOnly={locked}
                  onChange={(value) =>
                    setEntityDrafts((current) => ({
                      ...current,
                      tasks: {
                        ...current.tasks,
                        [value.id]: { value, dirty: true },
                      },
                    }))
                  }
                  onFreeze={(task, reviewerProfileId) =>
                    void execute({
                      ...envelope(),
                      type: "planning.quick-freeze",
                      payload: {
                        baselineId: identity("quick-baseline"),
                        title: task.title,
                        task,
                        profileIds: [task.profileId!, reviewerProfileId],
                      },
                    })
                  }
                  onInitializeRoles={() =>
                    patch(
                      planningProfilePresets(korean ? "ko" : "en")
                        .filter(
                          (profile) =>
                            !snapshot.draft.profiles.some(
                              (existing) => existing.id === profile.id,
                            ),
                        )
                        .map((value) => ({ op: "profile.put", value })),
                      copy(
                        "기본 역할 프로필 추가",
                        "Add default role profiles",
                      ),
                    )
                  }
                  onClose={() => setQuickTaskId(null)}
                />
              )}
              <h3>{copy("최근 변경", "Recent changes")}</h3>
              {snapshot.history.length ? (
                <ol className="planning-workspace__history">
                  {snapshot.history
                    .slice(-5)
                    .reverse()
                    .map((change) => (
                      <li key={change.id}>
                        <span>{change.summary}</span>
                        <small>
                          r{change.revision} ·{" "}
                          {change.actor.kind === "ai"
                            ? "AI"
                            : copy("사용자", "User")}
                        </small>
                      </li>
                    ))}
                </ol>
              ) : (
                <p className="planning-workspace__muted">
                  {copy(
                    "저장한 변경이 여기에 표시됩니다.",
                    "Saved changes will appear here.",
                  )}
                </p>
              )}
            </TabPanel>
            <TabPanel
              value="planning"
              className="planning-workspace__definitions"
            >
              <nav
                className="planning-workspace__subnav"
                aria-label={copy("기획 보기", "Planning views")}
              >
                {aiAccess && (
                  <Button
                    size="sm"
                    aria-pressed={planningView === "ai"}
                    onClick={() => setPlanningView("ai")}
                  >
                    {copy("AI 변경 제안", "AI change proposal")}
                    {pendingAi ? " · !" : ""}
                  </Button>
                )}
                <Button
                  size="sm"
                  aria-pressed={planningView === "documents"}
                  onClick={() => setPlanningView("documents")}
                >
                  {copy("기획 문서", "Documents")}
                </Button>
                <Button
                  size="sm"
                  aria-pressed={planningView === "information"}
                  onClick={() => setPlanningView("information")}
                >
                  {copy("정보 구조", "Information architecture")}
                </Button>
                <Button
                  size="sm"
                  aria-pressed={planningView === "flow"}
                  onClick={() => setPlanningView("flow")}
                >
                  {copy("사용자 흐름", "User flow")}
                </Button>
              </nav>
              {planningView === "ai" && aiOptions ? (
                <PlanningAiPanel
                  {...aiOptions}
                  snapshot={snapshot}
                  disabled={writeLocked || pendingCount > 0}
                />
              ) : planningView !== "documents" && planningView !== "ai" ? (
                <PlanningStructureEditor
                  key={planningView}
                  mode={planningView}
                  snapshot={snapshot}
                  disabled={writeLocked || pendingCount > 0}
                  onPatch={patch}
                  onOpenDesign={() => setSection("design")}
                  onEditItem={(id) => {
                    const item = snapshot.draft.items.find(
                      (entry) => entry.id === id,
                    );
                    if (item) selectItem(item);
                    setPlanningView("documents");
                  }}
                />
              ) : (
                <div
                  className="planning-workspace__split"
                  data-editing={Boolean(edit) || undefined}
                >
                  <aside
                    className="planning-workspace__list"
                    aria-label={copy("기획 항목", "Planning items")}
                  >
                    <div className="planning-workspace__list-heading">
                      <h2>{labels.planning}</h2>
                      <IconButton
                        icon={Plus}
                        aria-label={copy("기획 항목 추가", "Add planning item")}
                        onClick={addItem}
                        disabled={locked}
                      />
                    </div>
                    <Field
                      label={copy("기획 검색", "Search planning")}
                      labelHidden
                    >
                      <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={copy(
                          "제목 또는 내용 검색",
                          "Search title or content",
                        )}
                      />
                    </Field>
                    <Field label={copy("항목 종류", "Item kind")} labelHidden>
                      <Select
                        value={kindFilter}
                        onChange={(event) => setKindFilter(event.target.value)}
                      >
                        <option value="all">
                          {copy("모든 항목", "All items")}
                        </option>
                        {KINDS.map((kind) => (
                          <option value={kind} key={kind}>
                            {kinds[kind]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="planning-workspace__item-list">
                      {items.map((item) => (
                        <button
                          key={item.id}
                          className="planning-workspace__item"
                          aria-pressed={selectedId === item.id}
                          onClick={() => selectItem(item)}
                        >
                          <small>
                            {kinds[item.kind]}
                            {edits[item.id]?.dirty
                              ? copy(" · 미저장", " · Unsaved")
                              : ""}
                          </small>
                          <strong>
                            {item.title ||
                              copy("제목 없는 항목", "Untitled item")}
                          </strong>
                          {stateBadge(item.status)}
                        </button>
                      ))}
                    </div>
                    {!items.length && (
                      <p className="planning-workspace__muted">
                        {copy(
                          "기획 항목이 없습니다.",
                          "No planning items yet.",
                        )}
                      </p>
                    )}
                  </aside>
                  {edit ? (
                    <form
                      className="planning-workspace__editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        patch(
                          [
                            {
                              op: "item.put",
                              value: {
                                ...edit.item,
                                title: edit.item.title.trim(),
                                acceptance: edit.acceptanceText
                                  .split("\n")
                                  .map((line) => line.trim())
                                  .filter(Boolean),
                              },
                            },
                          ],
                          copy(
                            `기획 저장: ${edit.item.title}`,
                            `Save planning: ${edit.item.title}`,
                          ),
                        );
                      }}
                    >
                      <div className="planning-workspace__editor-heading">
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<ArrowLeft />}
                          onClick={() => setSelectedId(null)}
                        >
                          {copy("목록", "List")}
                        </Button>
                        <span>
                          {edit.dirty
                            ? copy("저장하지 않은 변경", "Unsaved changes")
                            : copy("저장됨", "Saved")}
                        </span>
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          disabled={
                            writeLocked ||
                            !edit.item.title.trim() ||
                            !edit.dirty
                          }
                          leadingIcon={<Save />}
                        >
                          {busy
                            ? copy("저장 중", "Saving")
                            : copy("저장", "Save")}
                        </Button>
                      </div>
                      <Field label={copy("제목", "Title")} required>
                        <Input
                          value={edit.item.title}
                          maxLength={300}
                          disabled={locked}
                          onChange={(event) =>
                            editItem({ title: event.target.value })
                          }
                        />
                      </Field>
                      <div className="planning-workspace__field-row">
                        <Field label={copy("종류", "Kind")}>
                          <Select
                            disabled={locked}
                            value={edit.item.kind}
                            onChange={(event) =>
                              editItem({
                                kind: event.target
                                  .value as PlanningItem["kind"],
                                flowStep:
                                  event.target.value === "flow"
                                    ? (edit.item.flowStep ?? { kind: "action" })
                                    : undefined,
                              })
                            }
                          >
                            {KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {kinds[kind]}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={copy("검토 상태", "Review status")}>
                          <Select
                            disabled={locked}
                            value={edit.item.status}
                            onChange={(event) =>
                              editItem({
                                status: event.target
                                  .value as PlanningItem["status"],
                              })
                            }
                          >
                            <option value="draft">
                              {statusLabel("draft")}
                            </option>
                            <option value="review-needed">
                              {statusLabel("review-needed")}
                            </option>
                            <option value="ready">
                              {statusLabel("ready")}
                            </option>
                          </Select>
                        </Field>
                      </div>
                      <label className="planning-workspace__text-field">
                        {copy("내용", "Content")}
                        <textarea
                          value={edit.item.body}
                          disabled={locked}
                          rows={12}
                          maxLength={200_000}
                          onChange={(event) =>
                            editItem({ body: event.target.value })
                          }
                          placeholder={copy(
                            "목표, 사용 흐름, 제약과 결정 근거를 작성하세요.",
                            "Describe the goal, flow, constraints and decisions.",
                          )}
                        />
                      </label>
                      <label className="planning-workspace__text-field">
                        {copy(
                          "완료 기준 · 한 줄에 하나",
                          "Acceptance criteria · one per line",
                        )}
                        <textarea
                          value={edit.acceptanceText}
                          disabled={locked}
                          rows={4}
                          onChange={(event) => {
                            const value = event.target.value;
                            setEdits((current) => ({
                              ...current,
                              [edit.item.id]: {
                                ...current[edit.item.id],
                                acceptanceText: value,
                                dirty: true,
                              },
                            }));
                          }}
                        />
                      </label>
                      {snapshot.draft.items.some(
                        (item) => item.id === edit.item.id,
                      ) && (
                        <div>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={writeLocked}
                            leadingIcon={<Trash2 />}
                            onClick={() => setDeleteId(edit.item.id)}
                          >
                            {copy("항목 삭제", "Delete item")}
                          </Button>
                        </div>
                      )}
                      <PlanningLinkEditor
                        key={edit.item.id}
                        snapshot={snapshot}
                        sourceId={edit.item.id}
                        disabled={writeLocked || edit.dirty}
                        onPatch={patch}
                      />
                    </form>
                  ) : (
                    <EmptyState
                      icon={FileText}
                      title={copy("기획을 작성하세요", "Build your plan")}
                      description={copy(
                        "요구사항, 기능, 정보 구조, 흐름과 결정을 연결할 준비를 합니다.",
                        "Capture requirements, features, information, flows and decisions.",
                      )}
                      action={
                        <Button
                          leadingIcon={<Plus />}
                          disabled={locked}
                          onClick={addItem}
                        >
                          {copy("새 기획 항목", "New planning item")}
                        </Button>
                      }
                    />
                  )}
                </div>
              )}
            </TabPanel>
            <TabPanel
              value="design"
              className="planning-workspace__definitions"
            >
              <SceneDesigner
                assetApi={assetApi}
                ai={aiOptions}
                onExportScene={onExportScene}
                snapshot={snapshot}
                sceneDrafts={entityDrafts.scenes}
                componentDrafts={entityDrafts.components}
                disabled={writeLocked}
                readOnly={locked}
                mobile={mobile}
                onSceneDraftChange={(value) =>
                  setEntityDrafts((current) => ({
                    ...current,
                    scenes: {
                      ...current.scenes,
                      [value.id]: { value, dirty: true },
                    },
                  }))
                }
                onComponentDraftChange={(value) =>
                  setEntityDrafts((current) => ({
                    ...current,
                    components: {
                      ...current.components,
                      [value.id]: { value, dirty: true },
                    },
                  }))
                }
                onPatch={patch}
              />
            </TabPanel>
            <TabPanel value="chat" className="planning-workspace__page">
              <div className="planning-workspace__list-heading">
                <h2>{labels.chat}</h2>
                {onNewConversation && (
                  <Button
                    size="sm"
                    onClick={onNewConversation}
                    leadingIcon={<Plus />}
                  >
                    {copy("새 대화", "New conversation")}
                  </Button>
                )}
              </div>
              {conversationError && <p role="alert">{conversationError}</p>}
              {conversations.length ? (
                <div className="planning-workspace__conversation-list">
                  {conversations.map((conversation) => (
                    <button
                      className="planning-workspace__conversation"
                      key={conversation.id}
                      disabled={!onOpenConversation}
                      onClick={() => onOpenConversation?.(conversation.id)}
                    >
                      <span>
                        <strong>{conversation.title}</strong>
                        <small>
                          {[
                            conversation.providerLabel,
                            conversation.workspaceLabel,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                      {conversation.status && (
                        <Badge>{stateLabel(conversation.status)}</Badge>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title={copy(
                    "첫 대화를 시작하세요",
                    "Start your first conversation",
                  )}
                  description={copy(
                    "대화는 작업공간 구분 없이 이 목록에 모입니다.",
                    "All project conversations appear in this single list.",
                  )}
                  action={
                    onNewConversation && (
                      <Button onClick={onNewConversation}>
                        {copy("새 대화", "New conversation")}
                      </Button>
                    )
                  }
                />
              )}
            </TabPanel>
            <TabPanel value="tasks" className="planning-workspace__definitions">
              <div className="planning-workspace__subnav">
                {executionAccess && (
                  <Button
                    size="sm"
                    variant={
                      definitionView === "execution" ? "secondary" : "ghost"
                    }
                    aria-pressed={definitionView === "execution"}
                    onClick={() => setDefinitionView("execution")}
                  >
                    {copy("실행", "Execution")}
                    {pendingRun ? " · !" : ""}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={definitionView === "tasks" ? "secondary" : "ghost"}
                  aria-pressed={definitionView === "tasks"}
                  onClick={() => setDefinitionView("tasks")}
                >
                  {copy("작업 정의", "Task definitions")}
                </Button>
                <Button
                  size="sm"
                  variant={
                    definitionView === "profiles" ? "secondary" : "ghost"
                  }
                  aria-pressed={definitionView === "profiles"}
                  onClick={() => setDefinitionView("profiles")}
                >
                  {copy("역할 프로필", "Role profiles")}
                </Button>
              </div>
              {definitionView === "execution" && executionAccess ? (
                <PlanningExecutionPanel
                  planning={snapshot}
                  access={executionAccess}
                  initialBaselineId={preparedBaselineId}
                  initialRunId={initialRunId}
                  disabled={
                    disabled ||
                    busy ||
                    Boolean(uncertain) ||
                    !recoveryReady ||
                    recoveryBlocked
                  }
                  pendingRequest={pendingRun}
                  persistPendingRequest={persistPendingRun}
                  onOpenConversation={onOpenConversation}
                />
              ) : definitionView === "tasks" ? (
                <PlanningTaskEditor
                  snapshot={snapshot}
                  drafts={entityDrafts.tasks}
                  disabled={writeLocked}
                  readOnly={locked}
                  onDraftChange={(value) =>
                    setEntityDrafts((current) => ({
                      ...current,
                      tasks: {
                        ...current.tasks,
                        [value.id]: { value, dirty: true },
                      },
                    }))
                  }
                  onPatch={patch}
                />
              ) : (
                <PlanningProfileEditor
                  snapshot={snapshot}
                  drafts={entityDrafts.profiles}
                  disabled={writeLocked}
                  readOnly={locked}
                  onDraftChange={(value) =>
                    setEntityDrafts((current) => ({
                      ...current,
                      profiles: {
                        ...current.profiles,
                        [value.id]: { value, dirty: true },
                      },
                    }))
                  }
                  onPatch={patch}
                  onApplyProposal={(proposalId) =>
                    void execute({
                      ...envelope(),
                      type: "profile.apply",
                      payload: { proposalId },
                    })
                  }
                />
              )}
            </TabPanel>
            <TabPanel value="review" className="planning-workspace__page">
              {archiveAccess && (
                <details
                  className="planning-workspace__archive-entry"
                  open={archiveOpen}
                  onToggle={(event) => setArchiveOpen(event.currentTarget.open)}
                >
                  <summary>
                    {copy(
                      "프로젝트 기록 · 백업·복원·정리",
                      "Project records · backup, restore and cleanup",
                    )}
                  </summary>
                  {archiveOpen && (
                    <ProjectArchivePanel
                      projectId={projectId}
                      access={archiveAccess}
                      pendingRequest={pendingArchive}
                      persistPendingRequest={persistPendingArchive}
                      disabled={disabled || busy || pendingCount > 0}
                    />
                  )}
                </details>
              )}
              <h2>
                {copy("기획 검토와 기준선", "Planning review and baselines")}
              </h2>
              <p className="planning-workspace__muted">
                {copy(
                  "기준선은 검토한 기획·설계·작업의 변경할 수 없는 복사본입니다. 실행 시작은 별도 단계입니다.",
                  "A baseline freezes the reviewed plan, designs and task definitions. Starting execution is a separate step.",
                )}
              </p>
              <fieldset className="planning-workspace__baseline-selection" disabled={locked}>
                <legend>{copy("실행할 작업 범위", "Tasks to include")}</legend>
                <p>{copy("선택하지 않으면 전체를 확정합니다. 일부를 선택하면 의존 작업과 참조 문서·설계·설정만 함께 포함합니다.", "Leave all unchecked to freeze everything. A selection includes its dependencies and referenced documents, designs and settings.")}</p>
                {snapshot?.draft.tasks.map(task => <label key={task.id}><input type="checkbox" checked={baselineTaskIds.includes(task.id)} onChange={event => setBaselineTaskIds(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id))} />{task.title}</label>)}
                {baselineSelection?.error && <p role="alert">{baselineSelection.error}</p>}
                {baselineSelection?.draft && <details open><summary>{copy("함께 확정되는 범위", "Included scope")}</summary><ul>{baselineSelection.draft.tasks.map(task => <li key={task.id}>{task.title}{!baselineTaskIds.includes(task.id) ? copy(" · 의존 작업", " · dependency") : ""}</li>)}</ul><p>{copy("기획 항목", "Planning items")}: {baselineSelection.draft.items.length} · {copy("화면", "Scenes")}: {baselineSelection.draft.scenes.length} · {copy("설정", "Profiles")}: {baselineSelection.draft.profiles.length}</p></details>}
              </fieldset>
              <form
                className="planning-workspace__baseline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!locked)
                    void execute({
                      ...envelope(),
                      type: "planning.freeze",
                      payload: {
                        baselineId: identity("baseline"),
                        title: baselineTitle.trim(),
                        ...(baselineTaskIds.length ? { taskIds: baselineTaskIds } : {}),
                      },
                    });
                }}
              >
                <Field label={copy("기준선 이름", "Baseline name")}>
                  <Input
                    value={baselineTitle}
                    maxLength={300}
                    disabled={locked}
                    onChange={(event) => setBaselineTitle(event.target.value)}
                    placeholder={copy(
                      "예: 첫 번째 구현 범위",
                      "e.g. First implementation scope",
                    )}
                  />
                </Field>
                <Button
                  type="submit"
                  disabled={
                    writeLocked || pendingCount > 0 || !baselineTitle.trim() || !!baselineSelection?.error
                  }
                >
                  {copy("검토하고 기준선 확정", "Freeze reviewed baseline")}
                </Button>
              </form>
              {pendingCount > 0 && (
                <p className="planning-workspace__muted">
                  {copy(
                    `미저장 항목 ${pendingCount}개를 먼저 저장하세요.`,
                    `Save ${pendingCount} unsaved items first.`,
                  )}
                </p>
              )}
              {snapshot.baselines.length ? (
                <div className="planning-workspace__cards">
                  {snapshot.baselines
                    .slice()
                    .reverse()
                    .map((baseline) => (
                      <article
                        className="planning-workspace__card"
                        key={baseline.id}
                      >
                        <Badge variant="success">
                          {copy("확정됨", "Frozen")}
                        </Badge>
                        <h3>{baseline.title}</h3>
                        <p>
                          r{baseline.sourceRevision} ·{" "}
                          {baseline.createdAt.replace("T", " ").slice(0, 16)}
                        </p>
                        <code title={baseline.hash}>
                          {baseline.hash.slice(0, 16)}
                        </code>
                        <Button
                          size="sm"
                          onClick={() => setViewBaselineId(baseline.id)}
                        >
                          {copy("확정 내용 읽기", "Read frozen content")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={writeLocked || pendingCount > 0}
                          onClick={() => setBranchId(baseline.id)}
                        >
                          {copy(
                            "이 기준선에서 초안 만들기",
                            "Create draft from baseline",
                          )}
                        </Button>
                      </article>
                    ))}
                </div>
              ) : (
                <EmptyState
                  title={copy(
                    "확정한 기준선이 없습니다",
                    "No frozen baseline yet",
                  )}
                  description={copy(
                    "각 항목의 검토 상태와 연결을 확인하고 기준선을 확정하세요.",
                    "Review item statuses and connections before freezing a baseline.",
                  )}
                />
              )}
              <h3>{copy("변경 기록", "Change history")}</h3>
              <ol className="planning-workspace__history">
                {snapshot.history
                  .slice()
                  .reverse()
                  .map((change) => (
                    <li key={change.id}>
                      <span>
                        {change.summary}
                        <small>
                          r{change.revision} ·{" "}
                          {change.actor.kind === "ai"
                            ? "AI"
                            : copy("사용자", "User")}
                        </small>
                      </span>
                      {change.id ===
                        snapshot.history
                          .slice()
                          .reverse()
                          .find((entry) =>
                            [
                              "planning.patch",
                              "planning.branch",
                              "planning.undo",
                              "profile.apply",
                            ].includes(entry.type),
                          )?.id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={writeLocked || pendingCount > 0}
                          leadingIcon={<Undo2 />}
                          onClick={() =>
                            void execute({
                              ...envelope(),
                              type: "planning.undo",
                              payload: { changeId: change.id },
                            })
                          }
                        >
                          {copy("되돌리기", "Undo")}
                        </Button>
                      )}
                    </li>
                  ))}
              </ol>
            </TabPanel>
          </>
        )}
      </Tabs>
      <Dialog
        size="lg"
        open={Boolean(viewedBaseline)}
        onOpenChange={(open) => {
          if (!open) setViewBaselineId(null);
        }}
        title={viewedBaseline?.title ?? copy("기준선", "Baseline")}
      >
        {viewedBaseline && (
          <div className="planning-workspace__result">
            <Badge>
              {copy("읽기 전용 · 확정본", "Read-only · frozen baseline")}
            </Badge>
            <p>
              r{viewedBaseline.sourceRevision} · {viewedBaseline.createdAt}
            </p>
            <code>{viewedBaseline.hash}</code>
            <h3>{copy("기획 문서", "Planning documents")}</h3>
            {viewedBaseline.draft.items.map((item) => (
              <details key={item.id}>
                <summary>
                  {item.title} · r{item.revision}
                </summary>
                <p className="planning-workspace__proposal">{item.body}</p>
                <ul>
                  {item.acceptance.map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                </ul>
              </details>
            ))}
            <h3>{copy("화면과 작업", "Screens and tasks")}</h3>
            <ul>
              {viewedBaseline.draft.scenes.map((scene) => (
                <li key={scene.id}>
                  {scene.title} · r{scene.revision} · {scene.width}×
                  {scene.height}
                </li>
              ))}
            </ul>
            {viewedBaseline.draft.tasks.map((task) => (
              <details key={task.id}>
                <summary>
                  {task.title} · r{task.revision}
                </summary>
                <p>{task.objective}</p>
                <ul>
                  {task.acceptance.map((entry) => (
                    <li key={entry.id}>{entry.description}</li>
                  ))}
                </ul>
                <ul>
                  {task.validationPlan.map((entry) => (
                    <li key={entry.id}>
                      {entry.description} · {entry.environment}
                      <code>{entry.command}</code>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            <h3>{copy("역할별 프롬프트", "Role instructions")}</h3>
            {viewedBaseline.draft.profiles.map((profile) => (
              <details key={profile.id}>
                <summary>
                  {profile.title} · r{profile.revision}
                </summary>
                <p className="planning-workspace__proposal">
                  {profile.instructions}
                </p>
                <p>{profile.allowedTools.join(", ")}</p>
              </details>
            ))}
          </div>
        )}
      </Dialog>
      <Dialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={copy("미저장 변경 정리", "Manage unsaved changes")}
        footer={
          <>
            <Button onClick={() => setDiscardOpen(false)}>
              {copy("계속 편집", "Keep editing")}
            </Button>
            <Button
              variant="danger"
              disabled={locked || discardKeys.length === 0}
              onClick={() => {
                const selected = new Set(discardKeys);
                setEdits((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(
                      ([id]) => !selected.has(`items:${id}`),
                    ),
                  ),
                );
                setEntityDrafts(
                  (current) =>
                    Object.fromEntries(
                      Object.entries(current).map(([kind, entries]) => [
                        kind,
                        Object.fromEntries(
                          Object.entries(entries).filter(
                            ([id]) => !selected.has(`${kind}:${id}`),
                          ),
                        ),
                      ]),
                    ) as PlanningEntityDrafts,
                );
                if (selectedId && selected.has(`items:${selectedId}`))
                  setSelectedId(null);
                if (quickTaskId && selected.has(`tasks:${quickTaskId}`))
                  setQuickTaskId(null);
                setDiscardOpen(false);
                setDiscardKeys([]);
              }}
            >
              {copy("선택한 변경 폐기", "Discard selected changes")}
            </Button>
          </>
        }
      >
        <p>
          {copy(
            "아직 저장하지 않은 선택 항목의 변경만 폐기합니다. 저장된 프로젝트 내용과 기준선은 유지됩니다.",
            "Discard only the selected unsaved edits. Saved project content and frozen baselines remain available.",
          )}
        </p>
        <ul className="planning-workspace__archive-conversations">
          {discardTargets.map((entry) => (
            <li key={entry.key}>
              <label>
                <input
                  type="checkbox"
                  checked={discardKeys.includes(entry.key)}
                  onChange={(event) =>
                    setDiscardKeys((current) =>
                      event.target.checked
                        ? [...current, entry.key]
                        : current.filter((key) => key !== entry.key),
                    )
                  }
                />
                {entry.title}
              </label>
            </li>
          ))}
        </ul>
      </Dialog>
      <Dialog
        open={storageComparison !== null}
        onOpenChange={(open) => {
          if (!open && !storageBusy) setStorageComparison(null);
        }}
        title={copy("기기 초안 복구", "Recover device draft")}
        footer={
          <>
            <Button
              disabled={storageBusy}
              onClick={() => setStorageComparison(null)}
            >
              {copy("취소", "Cancel")}
            </Button>
            <Button
              disabled={
                storageBusy ||
                !storageComparison?.state ||
                Boolean(
                  uncertain &&
                  uncertain.commandId !==
                    storageComparison.state.uncertain?.commandId,
                ) ||
                Boolean(
                  pendingRun &&
                  pendingRun.commandId !==
                    storageComparison.state.pendingRun?.commandId,
                ) ||
                Boolean(
                  pendingArchive &&
                  JSON.stringify(pendingArchive) !==
                    JSON.stringify(storageComparison.state.pendingArchive),
                ) ||
                Boolean(
                  pendingAi &&
                  JSON.stringify(pendingAi) !==
                    JSON.stringify(storageComparison.state.pendingAi),
                )
              }
              onClick={() => {
                if (!storageComparison?.state) return;
                const stored = PlanningWorkspaceDraftSchema.parse(
                  storageComparison.state,
                );
                setSnapshot(stored.snapshot);
                setEdits(stored.edits);
                setEntityDrafts(stored.entityDrafts);
                setSelectedId(stored.selectedId);
                setUncertain(stored.uncertain);
                setPendingRun(stored.pendingRun ?? null);
                setPendingArchive(stored.pendingArchive ?? null);
                setPendingAi(stored.pendingAi ?? null);
                setStorageComparison(null);
                setStorageError(null);
                setRecoveryBlocked(false);
              }}
            >
              {copy(
                "현재 입력을 저장본으로 교체",
                "Replace current input with stored draft",
              )}
            </Button>
            <Button
              variant="primary"
              disabled={
                storageBusy ||
                Boolean(
                  storageComparison?.state?.uncertain &&
                  storageComparison.state.uncertain.commandId !==
                    uncertain?.commandId,
                ) ||
                Boolean(
                  storageComparison?.state?.pendingRun &&
                  storageComparison.state.pendingRun.commandId !==
                    pendingRun?.commandId,
                ) ||
                Boolean(
                  storageComparison?.state?.pendingArchive &&
                  JSON.stringify(storageComparison.state.pendingArchive) !==
                    JSON.stringify(pendingArchive),
                ) ||
                Boolean(
                  storageComparison?.state?.pendingAi &&
                  JSON.stringify(storageComparison.state.pendingAi) !==
                    JSON.stringify(pendingAi),
                )
              }
              onClick={() => void keepLocalDraft()}
            >
              {copy(
                "현재 입력으로 저장본 갱신",
                "Save current input over stored draft",
              )}
            </Button>
          </>
        }
      >
        <p>
          {copy(
            "저장본이 다른 화면에서 변경되었거나 저장에 실패했습니다. 두 초안을 확인한 후 사용할 내용을 선택하세요. 미확정 요청이 있으면 해당 요청이 있는 초안을 먼저 복구해야 합니다.",
            "The stored draft changed in another view or a save failed. Compare both drafts before choosing one. A draft containing an uncertain request must be recovered before that request can be replaced.",
          )}
        </p>
        <div className="planning-workspace__field-row">
          <section>
            <h3>
              {copy("현재 화면", "Current view")} · r{snapshot?.revision ?? 0}
            </h3>
            <ul>
              {Object.values(edits)
                .filter((draft) => draft.dirty)
                .map((draft) => (
                  <li key={draft.item.id}>
                    {draft.item.title || copy("제목 없음", "Untitled")}
                  </li>
                ))}
            </ul>
            <p>
              {copy("미저장 항목", "Unsaved items")}: {pendingCount}
            </p>
          </section>
          <section>
            <h3>
              {copy("기기 저장본", "Stored draft")} · r
              {storageComparison?.state?.snapshot?.revision ?? 0}
            </h3>
            <ul>
              {Object.values(storageComparison?.state?.edits ?? {})
                .filter((draft) => draft.dirty)
                .map((draft) => (
                  <li key={draft.item.id}>
                    {draft.item.title || copy("제목 없음", "Untitled")}
                  </li>
                ))}
            </ul>
            {(storageComparison?.state?.uncertain ||
              storageComparison?.state?.pendingRun ||
              storageComparison?.state?.pendingArchive) && (
              <Badge variant="warning">
                {copy("미확정 요청 있음", "Uncertain request retained")}
              </Badge>
            )}
          </section>
        </div>
      </Dialog>
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteId(null);
        }}
        title={copy("기획 항목을 삭제할까요?", "Delete this planning item?")}
        footer={
          <>
            <Button disabled={busy} onClick={() => setDeleteId(null)}>
              {copy("취소", "Cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={writeLocked}
              onClick={() => {
                if (deleteId)
                  patch(
                    [{ op: "entity.delete", kind: "item", id: deleteId }],
                    copy("기획 항목 삭제", "Delete planning item"),
                  );
              }}
            >
              {copy("삭제", "Delete")}
            </Button>
          </>
        }
      >
        <p>
          {copy(
            "다른 항목이 참조하는 경우 먼저 연결을 수정해야 합니다. 저장된 기준선은 유지됩니다.",
            "If another item references this one, update the connection first. Frozen baselines are preserved.",
          )}
        </p>
      </Dialog>
      <Dialog
        open={branchId !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setBranchId(null);
        }}
        title={copy(
          "기준선에서 새 초안을 만들까요?",
          "Create a draft from this baseline?",
        )}
        footer={
          <>
            <Button disabled={busy} onClick={() => setBranchId(null)}>
              {copy("취소", "Cancel")}
            </Button>
            <Button
              disabled={writeLocked}
              onClick={() => {
                if (branchId)
                  void execute({
                    ...envelope(),
                    type: "planning.branch",
                    payload: {
                      baselineId: branchId,
                      draftId: identity("draft"),
                    },
                  });
              }}
            >
              {copy("초안 만들기", "Create draft")}
            </Button>
          </>
        }
      >
        <p>
          {copy(
            "현재 초안을 선택한 기준선의 내용으로 바꿉니다. 기존 변경 기록과 기준선은 보존됩니다.",
            "Replace the current draft with this baseline. Existing history and baselines remain available.",
          )}
        </p>
      </Dialog>
    </section>
  );
}
