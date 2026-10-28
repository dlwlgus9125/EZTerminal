import { permissionPresetLabel } from "./agent-permission-copy";
import { Glyph, glyphIcon } from './ui/Glyph';
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonSnapshot } from "../shared/daemon-protocol";
import type {
  DaemonProviderManagementResult,
  ProviderModel,
} from "../shared/daemon-provider";
import type { PlanningSnapshot } from "../shared/planning";
import type {
  ExecutionRun,
  PlanningExecutionSnapshot,
} from "../shared/planning-execution";
import {
  PlanningRunRequestSchema,
  type PlanningRunPreparationInput,
  type PlanningRunRequest,
  type PlanningRunResult,
  type PlanningTaskAssignment,
} from "../shared/planning-run";
import { useAppTranslation } from "./i18n";
import {
  PlanningIntegrationStatus,
  PlanningResultDetails,
  type PlanningResultReader,
  type PlanningResultSelection,
} from "./PlanningResultDetails";
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
} from "./ui";
import { ChatMarkdown } from "./chat/markdown/ChatMarkdown";

export interface PlanningExecutionAccess {
  readPlanningResult?: PlanningResultReader;
  getPlanningExecutionSnapshot(projectId: string, subprojectId?: string): Promise<PlanningRunResult>;
  executePlanningRun(command: PlanningRunRequest): Promise<PlanningRunResult>;
  getDaemonSnapshot(): Promise<DaemonSnapshot | null>;
  listDaemonProviderModels(
    providerId: string,
  ): Promise<DaemonProviderManagementResult<readonly ProviderModel[]>>;
}
export interface PlanningExecutionPanelProps {
  readonly initialBaselineId?: string;
  readonly initialRunId?: string;
  readonly planning: PlanningSnapshot;
  readonly access: PlanningExecutionAccess;
  readonly disabled: boolean;
  readonly pendingRequest: PlanningRunRequest | null;
  readonly persistPendingRequest: (
    request: PlanningRunRequest | null,
  ) => Promise<void>;
  readonly onOpenConversation?: (sessionId: string) => void;
}
type Assignment = PlanningTaskAssignment & { rowId: string };
const freshAssignment = (): Assignment => ({
  rowId: crypto.randomUUID(),
  taskId: "",
  profileId: "",
  providerId: "",
  model: "",
  permissionPreset: "plan",
});
const assignmentSettings = (
  assignment: Assignment,
): Omit<PlanningTaskAssignment, "taskId"> => ({
  profileId: assignment.profileId,
  providerId: assignment.providerId,
  model: assignment.model,
  permissionPreset: assignment.permissionPreset,
  ...(assignment.reasoningEffort
    ? { reasoningEffort: assignment.reasoningEffort }
    : {}),
});

/** A prepared run is an immutable host snapshot. Only a separate Start command executes it. */
export function PlanningExecutionPanel({
  initialBaselineId,
  initialRunId,
  planning,
  access,
  disabled,
  pendingRequest,
  persistPendingRequest,
  onOpenConversation,
}: PlanningExecutionPanelProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const text = (korean: string, english: string): string =>
    ko ? korean : english;
  const [snapshot, setSnapshot] = useState<PlanningExecutionSnapshot | null>(
    null,
  );
  const [daemon, setDaemon] = useState<DaemonSnapshot | null>(null);
  const [models, setModels] = useState<
    Record<string, readonly ProviderModel[]>
  >({});
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [baselineId, setBaselineId] = useState("");
  const [teamMode, setTeamMode] =
    useState<PlanningRunPreparationInput["teamMode"]>("single");
  const [progressPolicy, setProgressPolicy] =
    useState<PlanningRunPreparationInput["progressPolicy"]>("checkpoint");
  const [assignments, setAssignments] = useState<Assignment[]>([
    freshAssignment(),
  ]);
  const [reviewer, setReviewer] = useState<Assignment>(freshAssignment);
  const [supersedesRunId, setSupersedesRunId] = useState("");
  const [review, setReview] = useState<{
    runId: string;
    attemptId: string;
  } | null>(null);
  const [reviewDetail, setReviewDetail] = useState("");
  const [resultSelection, setResultSelection] =
    useState<PlanningResultSelection | null>(null);
  const [decision, setDecision] = useState<
    | { type: "resolve-change"; runId: string; gateId: string }
    | { type: "extend-retry"; runId: string; taskId: string }
    | null
  >(null);
  const [decisionReason, setDecisionReason] = useState("");
  const appliedInitialBaseline = useRef<string | null>(null);
  const runElement = useRef<HTMLElement | null>(null);
  const focusedRun = useRef<string>();
  useEffect(() => {
    if (initialRunId && runElement.current && focusedRun.current !== initialRunId) {
      focusedRun.current = initialRunId; runElement.current.scrollIntoView?.({ block: 'start' }); runElement.current.focus({ preventScroll: true });
    }
  }, [initialRunId, snapshot]);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const baseline = planning.baselines.find((entry) => entry.id === baselineId);
  useEffect(() => {
    if (
      !initialBaselineId ||
      appliedInitialBaseline.current === initialBaselineId
    )
      return;
    const source = planning.baselines.find(
      (entry) => entry.id === initialBaselineId,
    );
    if (!source) return;
    appliedInitialBaseline.current = initialBaselineId;
    setBaselineId(initialBaselineId);
    setPrepareOpen(true);
    setAssignments(
      source.draft.tasks.map((task) => ({
        ...freshAssignment(),
        taskId: task.id,
        profileId: task.profileId ?? "",
        permissionPreset: source.draft.profiles
          .find((profile) => profile.id === task.profileId)
          ?.allowedTools.includes("project.write")
          ? "standard"
          : "plan",
      })),
    );
    setReviewer({
      ...freshAssignment(),
      profileId:
        source.draft.profiles.find((profile) => profile.role === "review")
          ?.id ?? "",
    });
  }, [initialBaselineId, planning.baselines]);
  const providers =
    daemon?.providers.filter(
      (provider) =>
        provider.enabled &&
        ["codex-app-server", "claude-agent-sdk"].includes(provider.protocol),
    ) ?? [];
  const locked = disabled || busy || Boolean(pendingRequest);
  const refresh = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    const request = ++generation.current;
    setLoading(true);
    const results = await Promise.allSettled([
      access.getPlanningExecutionSnapshot(planning.projectId),
      access.getDaemonSnapshot(),
    ]);
    if (!mounted.current || request !== generation.current) return;
    const execution = results[0];
    if (execution.status === "fulfilled") {
      if (execution.value.ok) {
        setSnapshot(execution.value.snapshot);
        setError(null);
      } else setError(execution.value.message);
    } else setError(String(execution.reason));
    if (results[1].status === "fulfilled") setDaemon(results[1].value);
    else setError(String(results[1].reason));
    setLoading(false);
  }, [access, planning.projectId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [refresh]);
  // Reading active execution state never repeats a command or starts a task.
  useEffect(() => {
    if (
      disabled ||
      !snapshot?.runs.some((run) =>
        ["running", "awaiting-review", "reconciling"].includes(run.state),
      )
    )
      return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [disabled, snapshot, refresh]);

  const loadModels = async (providerId: string): Promise<void> => {
    if (!providerId || models[providerId]) return;
    try {
      const result = await access.listDaemonProviderModels(providerId);
      if (!mounted.current) return;
      if (result.ok) {
        setModels((current) => ({ ...current, [providerId]: result.value }));
        setModelErrors((current) => ({ ...current, [providerId]: "" }));
      } else
        setModelErrors((current) => ({
          ...current,
          [providerId]: result.message,
        }));
    } catch (reason) {
      if (mounted.current)
        setModelErrors((current) => ({
          ...current,
          [providerId]: String(reason),
        }));
    }
  };
  const execute = async (request: PlanningRunRequest): Promise<boolean> => {
    if (busyRef.current || disabled) return false;
    const parsed = PlanningRunRequestSchema.safeParse(request);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("\n"),
      );
      return false;
    }
    busyRef.current = true;
    generation.current += 1;
    setBusy(true);
    setError(null);
    try {
      await persistPendingRequest(request);
      if (!mounted.current) return false;
      const result = await access.executePlanningRun(request);
      if (!mounted.current) return false;
      if (result.ok) {
        setSnapshot(result.snapshot);
        await persistPendingRequest(null);
        if (request.type === "prepare") setPrepareOpen(false);
        if (request.type === "review") {
          setReview(null);
          setReviewDetail("");
        }
        if (
          request.type === "extend-retry" ||
          request.type === "resolve-change"
        ) {
          setDecision(null);
          setDecisionReason("");
          if (
            request.type === "resolve-change" &&
            request.payload.decision === "approve"
          ) {
            setSupersedesRunId(request.payload.runId);
            setBaselineId("");
            setAssignments([freshAssignment()]);
            setReviewer(freshAssignment());
            setPrepareOpen(true);
          }
        }
        return true;
      } else {
        setError(result.message);
        if (!/unavailable|offline|timeout|disconnected/u.test(result.error))
          await persistPendingRequest(null);
        return false;
      }
    } catch (reason) {
      if (mounted.current) setError(String(reason));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const envelope = () => ({
    commandId: `execution-${crypto.randomUUID()}`,
    projectId: planning.projectId,
    expectedRevision: snapshot?.revision ?? 0,
  });
  const runAction = (type: "start" | "pause" | "continue", runId: string) => {
    if (!locked) void execute({ ...envelope(), type, payload: { runId } });
  };
  const taskAction = (
    type: "cancel-task" | "retry" | "resume-task" | "select-candidate",
    runId: string,
    taskId: string,
  ) => {
    if (!locked)
      void execute({ ...envelope(), type, payload: { runId, taskId } });
  };
  const stateLabel = (value: string): string =>
    ({
      prepared: text("실행 준비됨", "Prepared"),
      running: text("실행 중", "Running"),
      paused: text("보류", "Paused"),
      reconciling: text("실행 확인 중", "Reconciling"),
      "awaiting-review": text("검토 대기", "Awaiting review"),
      completed: text("검토 완료", "Reviewed"),
      ready: text("배정 대기", "Ready"),
      waiting: text("선행 작업 대기", "Waiting"),
      failed: text("실패", "Failed"),
      cancelled: text("취소됨", "Cancelled"),
      stale: text("기준 변경됨", "Stale"),
    })[value] ?? value;

  const assignmentFields = (
    assignment: Assignment,
    update: (patch: Partial<Assignment>) => void,
    isReviewer = false,
  ): JSX.Element => {
    const profile = baseline?.draft.profiles.find(
      (entry) => entry.id === assignment.profileId,
    );
    const selectedModel = models[assignment.providerId]?.find(
      (entry) => entry.id === assignment.model,
    );
    return (
      <>
        {!isReviewer && (
          <Field label={text("작업", "Task")}>
            <Select
              value={assignment.taskId}
              disabled={locked}
              onChange={(event) => update({ taskId: event.target.value })}
            >
              <option value="">{text("작업 선택", "Select task")}</option>
              {baseline?.draft.tasks
                .filter((task) => task.status === "ready")
                .map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label={text("역할 프로필", "Role profile")}>
          <Select
            value={assignment.profileId}
            disabled={locked}
            onChange={(event) => {
              const selected = baseline?.draft.profiles.find(
                (entry) => entry.id === event.target.value,
              );
              update({
                profileId: event.target.value,
                permissionPreset:
                  !isReviewer &&
                  selected?.allowedTools.includes("project.write") &&
                  ["implementation", "integration"].includes(selected.role)
                    ? "standard"
                    : "plan",
              });
            }}
          >
            <option value="">{text("역할 선택", "Select role")}</option>
            {baseline?.draft.profiles
              .filter((entry) => !isReviewer || entry.role === "review")
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title} · r{entry.revision}
                </option>
              ))}
          </Select>
        </Field>
        <div className="planning-workspace__field-row">
          <Field label={text("AI 연결", "Provider")}>
            <Select
              value={assignment.providerId}
              disabled={locked}
              onChange={(event) => {
                update({
                  providerId: event.target.value,
                  model: "",
                  reasoningEffort: undefined,
                });
                void loadModels(event.target.value);
              }}
            >
              <option value="">{text("연결 선택", "Select provider")}</option>
              {providers.map((provider) => (
                <option
                  value={provider.id}
                  key={provider.id}
                  disabled={["unavailable", "incompatible", "error"].includes(
                    provider.health,
                  )}
                >
                  {provider.displayName} · {provider.health}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={text("모델", "Model")}>
            <Select
              value={assignment.model}
              disabled={locked || !assignment.providerId}
              onChange={(event) =>
                update({
                  model: event.target.value,
                  reasoningEffort: undefined,
                })
              }
            >
              <option value="">{text("모델 선택", "Select model")}</option>
              {models[assignment.providerId]?.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.displayName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {modelErrors[assignment.providerId] && (
          <p role="alert">
            {modelErrors[assignment.providerId]}{" "}
            <Button
              size="sm"
              disabled={locked}
              onClick={() => void loadModels(assignment.providerId)}
            >
              {text("모델 다시 확인", "Retry model discovery")}
            </Button>
          </p>
        )}
        {selectedModel?.reasoningEfforts?.length ? (
          <Field label={text("추론 설정", "Reasoning effort")}>
            <Select
              disabled={locked}
              value={assignment.reasoningEffort ?? ""}
              onChange={(event) =>
                update({ reasoningEffort: event.target.value || undefined })
              }
            >
              <option value="">{text("모델 기본값", "Model default")}</option>
              {selectedModel.reasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <p className="planning-workspace__muted">
          {assignment.permissionPreset === "standard"
            ? text(
                "지정한 작업 경로 수정 가능",
                "Can modify the assigned task paths",
              )
            : text("읽기 전용", "Read only")}
          {profile &&
            ` · ${text("추가 수정", "Repair retries")} ${profile.retryLimit}`}
        </p>
      </>
    );
  };
  const renderRun = (run: ExecutionRun): JSX.Element => (
    <article ref={run.runId === initialRunId ? runElement : undefined} tabIndex={run.runId === initialRunId ? -1 : undefined} className="planning-workspace__run" key={run.runId} data-workflow-run={run.runId} data-selected={run.runId === initialRunId || undefined}>
      <div className="planning-workspace__list-heading">
        <div>
          <h3>
            {planning.baselines.find(
              (entry) => entry.id === run.preparation.baseline.baselineId,
            )?.title ?? run.preparation.baseline.baselineId}
          </h3>
          <small>
            {run.runId} · r{run.preparation.baseline.revision}
          </small>
        </div>
        <Badge
          variant={
            run.state === "completed"
              ? "success"
              : run.state === "reconciling"
                ? "warning"
                : "neutral"
          }
        >
          {stateLabel(run.state)}
        </Badge>
      </div>
      <div className="planning-workspace__subnav">
        {run.state === "prepared" && (
          <Button
            variant="primary"
            leadingIcon={<Glyph name="play" />}
            disabled={locked}
            onClick={() => runAction("start", run.runId)}
          >
            {text("이 설정으로 실행 시작", "Start with these settings")}
          </Button>
        )}
        {run.state === "running" && !run.dispatchPaused && (
          <Button
            leadingIcon={<Glyph name="pause" />}
            disabled={locked}
            onClick={() => runAction("pause", run.runId)}
          >
            {text("새 작업 배정 중지", "Pause dispatch")}
          </Button>
        )}
        {(run.dispatchPaused || run.state === "paused") && (
          <Button
            leadingIcon={<Glyph name="play" />}
            disabled={
              locked || run.gates.some((gate) => gate.state === "pending")
            }
            onClick={() => runAction("continue", run.runId)}
          >
            {text("계속 진행", "Continue")}
          </Button>
        )}
      </div>
      {access.readPlanningResult && run.state !== "prepared" && (
        <PlanningIntegrationStatus
          projectId={planning.projectId}
          runId={run.runId}
          revision={snapshot?.revision ?? 0}
          read={access.readPlanningResult}
          disabled={disabled}
          onOpen={() =>
            setResultSelection({
              kind: "integration",
              projectId: planning.projectId,
              runId: run.runId,
            })
          }
        />
      )}
      <details>
        <summary>
          {text("고정한 실행 설정", "Frozen execution settings")}
        </summary>
        <p>
          {run.preparation.teamMode} · {run.preparation.progressPolicy} ·{" "}
          {run.preparationFingerprint.slice(0, 16)}
        </p>
        {run.preparation.tasks.map((task) => (
          <div className="planning-workspace__connection" key={task.taskId}>
            <span>
              <strong>{task.title}</strong>
              <small>
                {task.profile.providerId} · {task.profile.model} ·{" "}
                {permissionPresetLabel(task.profile.permissionPreset, ko ? "ko" : "en", "automated")} · r{task.profile.revision}
              </small>
            </span>
          </div>
        ))}
        {run.preparation.reviewer && (
          <p>
            {text("독립 검토", "Independent review")}:{" "}
            {run.preparation.reviewer.providerId} ·{" "}
            {run.preparation.reviewer.model}
          </p>
        )}
      </details>
      {run.gates
        .filter((gate) => gate.state === "pending")
        .map((gate) => (
          <div key={gate.gateId} className="planning-workspace__message">
            <p>{gate.detail}</p>
            <small>{gate.taskIds.join(", ")}</small>
            {gate.kind === "replan" && (
              <div className="planning-workspace__actions">
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() =>
                    void execute({
                      ...envelope(),
                      type: "keep-original",
                      payload: { runId: run.runId, gateId: gate.gateId },
                    })
                  }
                >
                  {text(
                    "기존 기준으로 계속",
                    "Continue with original baseline",
                  )}
                </Button>
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    setDecision({
                      type: "resolve-change",
                      runId: run.runId,
                      gateId: gate.gateId,
                    });
                    setDecisionReason("");
                  }}
                >
                  {text("변경 기준으로 재계획", "Replan with changed baseline")}
                </Button>
              </div>
            )}
          </div>
        ))}
      {run.tasks.map((task) => {
        const definition = run.preparation.tasks.find(
          (entry) => entry.taskId === task.taskId,
        )!;
        const attempt = run.attempts.find(
          (entry) => entry.attemptId === task.currentAttemptId,
        );
        const evidence = run.evidence.filter(
          (entry) => entry.attemptId === attempt?.attemptId,
        );
        const candidate = definition.candidateGroupId;
        const retryLimit =
          definition.retryLimit + (task.extraRetriesGranted ?? 0);
        const pendingApprovals = attempt
          ? (daemon?.approvals.filter(
              (approval) =>
                approval.sessionId === attempt.sessionId &&
                approval.state === "pending",
            ) ?? [])
          : [];
        return (
          <section className="planning-workspace__run-task" key={task.taskId}>
            <div className="planning-workspace__list-heading">
              <strong>{definition.title}</strong>
              <Badge
                variant={
                  task.state === "failed"
                    ? "danger"
                    : task.state === "completed"
                      ? "success"
                      : "neutral"
                }
              >
                {stateLabel(task.state)}
              </Badge>
            </div>
            <p className="planning-workspace__muted">
              {text("추가 수정", "Repair retries")} {task.retriesUsed}/
              {retryLimit}
              {task.extraRetriesGranted
                ? ` (${text("추가 승인", "Extra approvals")} ${task.extraRetriesGranted})`
                : ""}
              {task.pauseReason ? ` · ${task.pauseReason}` : ""}
            </p>
            {attempt && (
              <>
                {attempt.summary && <ChatMarkdown markdown={attempt.summary} />}
                {pendingApprovals.length > 0 && (
                  <div className="planning-workspace__message" role="status">
                    <strong>
                      {text(
                        "권한·질문 응답 대기",
                        "Waiting for permission or input",
                      )}
                    </strong>
                    <ul>
                      {pendingApprovals.map((approval) => (
                        <li key={approval.id}>{approval.title}</li>
                      ))}
                    </ul>
                    <p>
                      {text(
                        "해당 AI 대화에서 요청 내용을 확인하고 응답하세요.",
                        "Open the agent conversation to review and answer the request.",
                      )}
                    </p>
                  </div>
                )}
                <small>
                  {text("요청", "Requested")}:{" "}
                  {attempt.requestedSettings.providerId}/
                  {attempt.requestedSettings.model} ·{" "}
                  {text("적용", "Effective")}:{" "}
                  {attempt.effectiveSettings.providerId}/
                  {attempt.effectiveSettings.model}
                </small>
                {onOpenConversation && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenConversation(attempt.sessionId)}
                  >
                    {text("담당 AI 대화 열기", "Open agent conversation")}
                  </Button>
                )}
                {access.readPlanningResult && (
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      setResultSelection({
                        kind: "attempt",
                        projectId: planning.projectId,
                        attemptId: attempt.attemptId,
                      })
                    }
                  >
                    {text(
                      "변경 파일·검증 결과",
                      "Changed files and validation",
                    )}
                  </Button>
                )}
              </>
            )}
            {evidence.length > 0 && (
              <ul className="planning-workspace__history">
                {evidence.map((entry) => (
                  <li key={entry.evidenceId}>
                    <span>
                      {entry.summary}
                      <small>
                        {entry.environment}
                        {entry.command ? ` · ${entry.command}` : ""}
                        {entry.exitCode === undefined
                          ? ""
                          : ` · exit ${entry.exitCode}`}
                      </small>
                    </span>
                    <Badge
                      variant={
                        entry.status === "passed"
                          ? "success"
                          : entry.status === "failed"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {entry.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="planning-workspace__actions">
              {task.state === "running" && (
                <Button
                  size="sm"
                  disabled={locked || task.cancelRequested}
                  onClick={() =>
                    taskAction("cancel-task", run.runId, task.taskId)
                  }
                >
                  {task.cancelRequested
                    ? text("취소 요청됨", "Cancellation requested")
                    : text("이 작업 취소", "Cancel task")}
                </Button>
              )}
              {task.state === "failed" && (
                <Button
                  size="sm"
                  disabled={locked || task.retriesUsed >= retryLimit}
                  onClick={() => taskAction("retry", run.runId, task.taskId)}
                >
                  {text("수정 재시도", "Retry repair")}
                </Button>
              )}
              {task.state === "failed" && task.retriesUsed >= retryLimit && (
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    setDecision({
                      type: "extend-retry",
                      runId: run.runId,
                      taskId: task.taskId,
                    });
                    setDecisionReason("");
                  }}
                >
                  {text("추가 수정 1회 승인", "Approve one extra repair")}
                </Button>
              )}
              {(task.state === "failed" || task.state === "paused") && (
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    setSupersedesRunId(run.runId);
                    setBaselineId(run.preparation.baseline.baselineId);
                    setAssignments([
                      {
                        ...freshAssignment(),
                        taskId: definition.sourceTaskId ?? task.taskId,
                        profileId: definition.profile.profileId,
                        permissionPreset: definition.profile.permissionPreset,
                      },
                    ]);
                    setReviewer({
                      ...freshAssignment(),
                      profileId: run.preparation.reviewer?.profileId ?? "",
                    });
                    setPrepareOpen(true);
                  }}
                >
                  {text("다른 AI로 다시 준비", "Prepare with another AI")}
                </Button>
              )}
              {task.state === "cancelled" && (
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() =>
                    taskAction("resume-task", run.runId, task.taskId)
                  }
                >
                  {text("작업 재개", "Resume task")}
                </Button>
              )}
              {task.state === "awaiting-review" && attempt && (
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    setReview({
                      runId: run.runId,
                      attemptId: attempt.attemptId,
                    });
                    setReviewDetail("");
                  }}
                >
                  {text("근거 검토", "Review evidence")}
                </Button>
              )}
              {candidate && task.state === "completed" && (
                <Button
                  size="sm"
                  disabled={
                    locked ||
                    run.selectedCandidates?.[candidate] === task.taskId
                  }
                  onClick={() =>
                    taskAction("select-candidate", run.runId, task.taskId)
                  }
                >
                  {run.selectedCandidates?.[candidate] === task.taskId
                    ? text("채택됨", "Selected")
                    : text("이 후보 채택", "Select candidate")}
                </Button>
              )}
            </div>
          </section>
        );
      })}
    </article>
  );

  return (
    <div className="planning-workspace__execution">
      <div className="planning-workspace__list-heading">
        <h2>{text("실행과 검토", "Execution and review")}</h2>
        <div className="planning-workspace__actions">
          <IconButton
            icon={glyphIcon('refresh')}
            aria-label={text("실행 상태 새로고침", "Refresh execution")}
            disabled={busy || disabled}
            onClick={() => void refresh()}
          />
          <Button
            size="sm"
            leadingIcon={<Glyph name="plus" />}
            disabled={locked || !snapshot || planning.baselines.length === 0}
            onClick={() => setPrepareOpen((current) => !current)}
          >
            {text("실행 준비", "Prepare execution")}
          </Button>
        </div>
      </div>
      {error && (
        <p className="planning-workspace__message" role="alert">
          {error}
        </p>
      )}
      {pendingRequest && (
        <div className="planning-workspace__message" role="alert">
          <p>
            {text(
              "요청 결과가 확인되지 않았습니다. 새 요청을 보내기 전에 같은 요청의 결과를 확인하세요.",
              "The request outcome is unknown. Check the same request before issuing another command.",
            )}
          </p>
          <Button
            size="sm"
            disabled={disabled || busy}
            onClick={() => void execute(pendingRequest)}
          >
            {text("실행 요청 결과 확인", "Check execution request")}
          </Button>
        </div>
      )}
      {loading && !snapshot ? (
        <LoadingState
          label={text("실행 상태 불러오는 중", "Loading execution state")}
        />
      ) : snapshot?.runs.length === 0 && !prepareOpen ? (
        <EmptyState
          title={text("준비한 실행이 없습니다", "No execution prepared")}
          description={
            planning.baselines.length
              ? text(
                  "기준선과 담당 AI를 선택해 준비한 뒤 실행을 시작하세요.",
                  "Prepare a frozen baseline and agent assignments, then start it explicitly.",
                )
              : text(
                  "기획·설계·작업을 검토하고 기준선을 먼저 확정하세요.",
                  "Review the plan, designs and task definitions, then freeze a baseline.",
                )
          }
        />
      ) : null}
      {prepareOpen && (
        <form
          className="planning-workspace__preparation"
          onSubmit={(event) => {
            event.preventDefault();
            if (locked) return;
            if (
              (teamMode === "single" || teamMode === "independent-review") &&
              assignments.length !== 1
            ) {
              setError(
                text(
                  "이 팀 구성에는 실행 담당이 한 명 필요합니다. 다른 배정을 제거하거나 역할 분담을 선택하세요.",
                  "This team mode requires one worker. Remove extra assignments or choose division of work.",
                ),
              );
              return;
            }
            const reviewerSettings = assignmentSettings(reviewer);
            void execute({
              ...envelope(),
              type: "prepare",
              payload: {
                runId: `run-${crypto.randomUUID()}`,
                baselineId,
                teamMode,
                progressPolicy,
                assignments: assignments.map((assignment) => ({
                  taskId: assignment.taskId,
                  ...assignmentSettings(assignment),
                })),
                reviewer: reviewerSettings,
                ...(supersedesRunId ? { supersedesRunId } : {}),
              },
            });
          }}
        >
          <Field label={text("실행할 기준선", "Execution baseline")}>
            <Select
              value={baselineId}
              disabled={locked}
              onChange={(event) => {
                setBaselineId(event.target.value);
                setAssignments([freshAssignment()]);
                setReviewer(freshAssignment());
              }}
            >
              <option value="">{text("기준선 선택", "Select baseline")}</option>
              {planning.baselines.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.title} · r{entry.sourceRevision}
                </option>
              ))}
            </Select>
          </Field>
          <div className="planning-workspace__field-row">
            <Field label={text("팀 구성", "Team mode")}>
              <Select
                value={teamMode}
                disabled={locked}
                onChange={(event) =>
                  setTeamMode(event.target.value as typeof teamMode)
                }
              >
                <option value="single">
                  {text("단일 담당", "Single worker")}
                </option>
                <option value="division">
                  {text("역할 분담", "Division of work")}
                </option>
                <option value="candidates">
                  {text("대안 비교", "Candidate comparison")}
                </option>
                <option value="independent-review">
                  {text("독립 검토", "Independent review")}
                </option>
              </Select>
            </Field>
            <Field label={text("진행 정책", "Progression policy")}>
              <Select
                value={progressPolicy}
                disabled={locked}
                onChange={(event) =>
                  setProgressPolicy(event.target.value as typeof progressPolicy)
                }
              >
                <option value="manual">{text("수동 진행", "Manual")}</option>
                <option value="checkpoint">
                  {text("단계별 확인", "Stage checkpoints")}
                </option>
                <option value="autonomous">
                  {text("완료 기준까지 자율 진행", "Autonomous to acceptance")}
                </option>
              </Select>
            </Field>
          </div>
          {baseline && (
            <>
              <div className="planning-workspace__assignment-grid">
                {assignments.map((assignment, index) => (
                  <fieldset
                    className="planning-workspace__validation"
                    key={assignment.rowId}
                  >
                    <legend>
                      {text(`담당 AI ${index + 1}`, `Worker ${index + 1}`)}
                    </legend>
                    {assignmentFields(assignment, (patch) =>
                      setAssignments((current) =>
                        current.map((entry) =>
                          entry.rowId === assignment.rowId
                            ? { ...entry, ...patch }
                            : entry,
                        ),
                      ),
                    )}
                    {assignments.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={locked}
                        leadingIcon={<Glyph name="trash" />}
                        onClick={() =>
                          setAssignments((current) =>
                            current.filter(
                              (entry) => entry.rowId !== assignment.rowId,
                            ),
                          )
                        }
                      >
                        {text("담당 제거", "Remove assignment")}
                      </Button>
                    )}
                  </fieldset>
                ))}
              </div>
              {teamMode !== "single" && (
                <Button
                  size="sm"
                  disabled={
                    locked ||
                    assignments.length >= (teamMode === "candidates" ? 4 : 128)
                  }
                  onClick={() =>
                    setAssignments((current) => [...current, freshAssignment()])
                  }
                >
                  {text("담당 AI 추가", "Add worker")}
                </Button>
              )}
              <fieldset className="planning-workspace__validation">
                <legend>
                  {text("독립 검토 담당", "Independent reviewer")}
                </legend>
                {assignmentFields(
                  reviewer,
                  (patch) =>
                    setReviewer((current) => ({ ...current, ...patch })),
                  true,
                )}
              </fieldset>
            </>
          )}
          {snapshot?.runs.some((run) =>
            run.gates.some(
              (gate) => gate.kind === "replan" && gate.state !== "rejected",
            ),
          ) && (
            <Field
              label={text(
                "변경 계획을 적용할 이전 실행",
                "Previous execution to replan",
              )}
            >
              <Select
                value={supersedesRunId}
                disabled={locked}
                onChange={(event) => setSupersedesRunId(event.target.value)}
              >
                <option value="">{text("새 실행", "New execution")}</option>
                {snapshot.runs
                  .filter((run) =>
                    run.gates.some(
                      (gate) =>
                        gate.kind === "replan" && gate.state !== "rejected",
                    ),
                  )
                  .map((run) => (
                    <option key={run.runId} value={run.runId}>
                      {run.runId}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          <p className="planning-workspace__muted">
            {text(
              "준비는 설정과 기준선을 고정합니다. 검사를 통과한 준비 결과에서 별도로 시작해야 AI가 실행됩니다.",
              "Preparation validates and freezes the settings and baseline. The AI runs only after you separately start the prepared result.",
            )}
          </p>
          <Button
            type="submit"
            variant="primary"
            disabled={locked || !baseline}
          >
            {text("설정 확인하고 준비", "Validate and prepare")}
          </Button>
        </form>
      )}
      {snapshot?.runs.slice().reverse().map(renderRun)}
      {access.readPlanningResult && (
        <PlanningResultDetails
          selection={resultSelection}
          read={access.readPlanningResult}
          onClose={() => setResultSelection(null)}
          onOpenConversation={onOpenConversation}
          retryDisabled={locked}
          onRetryReview={(result) => { if (!locked) void execute({...envelope(), type: "retry-review", payload: {runId: result.runId, attemptId: result.attemptId}}); }}
          executionRuns={snapshot?.runs}
          onRecordDeviceEvidence={async (payload) => !locked && execute({ ...envelope(), type: "record-device-evidence", payload })}
          disabled={disabled}
        />
      )}
      <Dialog
        open={Boolean(decision)}
        onOpenChange={(open) => {
          if (!open && !busy) setDecision(null);
        }}
        title={
          decision?.type === "extend-retry"
            ? text("추가 수정 1회 승인", "Approve one extra repair")
            : text("변경 기준으로 재계획", "Replan with changed baseline")
        }
        footer={
          <Button
            variant="primary"
            disabled={locked || !decisionReason.trim()}
            onClick={() => {
              if (!decision) return;
              void execute(
                decision.type === "extend-retry"
                  ? {
                      ...envelope(),
                      type: "extend-retry",
                      payload: {
                        runId: decision.runId,
                        taskId: decision.taskId,
                        reason: decisionReason.trim(),
                      },
                    }
                  : {
                      ...envelope(),
                      type: "resolve-change",
                      payload: {
                        runId: decision.runId,
                        gateId: decision.gateId,
                        decision: "approve",
                        detail: decisionReason.trim(),
                      },
                    },
              );
            }}
          >
            {text("승인", "Approve")}
          </Button>
        }
      >
        <p>
          {decision?.type === "extend-retry"
            ? text(
                "실패한 작업에 수정 기회를 한 번 추가합니다. 같은 오류가 반복되면 설정과 검증 근거를 먼저 확인하세요.",
                "Grant one additional repair for this failed task. Review its settings and evidence if the same failure repeats.",
              )
            : text(
                "영향받는 작업은 이전 기준으로 계속하지 않습니다. 새 기준선과 담당 AI를 다시 준비한 후 명시적으로 실행하세요.",
                "Affected tasks will stop using the previous baseline. Prepare the new baseline and agent assignments, then explicitly start the replacement.",
              )}
        </p>
        <Field label={text("승인 이유", "Approval reason")}>
          <Input
            value={decisionReason}
            disabled={locked}
            maxLength={decision?.type === "extend-retry" ? 4000 : 10000}
            onChange={(event) => setDecisionReason(event.target.value)}
          />
        </Field>
      </Dialog>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
        title={text("실행 결과 검토", "Review execution result")}
        footer={
          <>
            <Button
              disabled={locked || !reviewDetail.trim()}
              onClick={() => {
                if (review)
                  void execute({
                    ...envelope(),
                    type: "review",
                    payload: {
                      ...review,
                      decision: "reject",
                      detail: reviewDetail,
                    },
                  });
              }}
            >
              {text("수정 요청", "Request changes")}
            </Button>
            <Button
              variant="primary"
              disabled={locked || !reviewDetail.trim()}
              onClick={() => {
                if (review)
                  void execute({
                    ...envelope(),
                    type: "review",
                    payload: {
                      ...review,
                      decision: "approve",
                      detail: reviewDetail,
                    },
                  });
              }}
            >
              {text("검토 완료", "Approve review")}
            </Button>
          </>
        }
      >
        <p>
          {text(
            "검토는 현재 기준선, 변경 revision, 실제 검증 근거와 독립 검토 기록에 고정됩니다. 근거가 누락되거나 오래되면 적용되지 않습니다.",
            "This decision binds the current baseline, artifact revision, actual validation evidence and independent review record. Missing or stale evidence blocks acceptance.",
          )}
        </p>
        <Field label={text("검토 의견", "Review notes")}>
          <Input
            value={reviewDetail}
            maxLength={10_000}
            disabled={busy}
            onChange={(event) => setReviewDetail(event.target.value)}
          />
        </Field>
      </Dialog>
    </div>
  );
}
