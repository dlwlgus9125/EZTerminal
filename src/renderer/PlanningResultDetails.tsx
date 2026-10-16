import { useEffect, useMemo, useState } from "react";
import { gitDiffFileChanges } from "../shared/conversation-changes";
import type { ExecutionRun } from "../shared/planning-execution";
import type { PlanningDeviceEvidenceInput } from "../shared/planning-device-evidence";
import { PlanningDeviceEvidenceForm, type PlanningDeviceEvidenceTarget } from "./PlanningDeviceEvidenceForm";
import type {
  PlanningIntegrationRecord,
  PlanningResultQuery,
  PlanningResultQueryResult,
  PlanningResultRecord,
  PlanningValidationRecord,
} from "../shared/planning-result";
import { useAppTranslation } from "./i18n";
import { Badge, Button, Dialog, EmptyState, LoadingState } from "./ui";
import { ChatMarkdown } from "./chat/markdown/ChatMarkdown";
import { DiffView } from "./chat/parts/DiffView";
import "./chat/chat.css";

export type PlanningResultReader = (
  query: PlanningResultQuery,
) => Promise<PlanningResultQueryResult>;
export type PlanningResultSelection = Extract<
  PlanningResultQuery,
  { kind: "attempt" | "integration" }
>;

function useResultCopy(): (korean: string, english: string) => string {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  return (korean, english) => (ko ? korean : english);
}

/** Integration is read from its own host record; task review never implies a successful integration. */
export function PlanningIntegrationStatus({
  projectId,
  runId,
  revision,
  read,
  onOpen,
  disabled,
}: {
  projectId: string;
  runId: string;
  revision: number;
  read: PlanningResultReader;
  onOpen: () => void;
  disabled: boolean;
}): JSX.Element {
  const text = useResultCopy();
  const [record, setRecord] = useState<PlanningIntegrationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    if (disabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void read({ kind: "integration", projectId, runId })
      .then((result) => {
        if (!current) return;
        if (result.ok && result.kind === "integration") {
          setRecord(result.integration);
          setError(null);
        } else
          setError(
            result.ok
              ? text(
                  "통합 응답 형식이 맞지 않습니다.",
                  "Unexpected integration response.",
                )
              : result.message,
          );
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
    // Language changes do not cause another network read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, runId, revision, read, disabled]);
  return (
    <section
      className="planning-workspace__integration"
      aria-label={text("통합 상태", "Integration status")}
    >
      <div className="planning-workspace__list-heading">
        <strong>{text("통합 검증", "Integration validation")}</strong>
        <Badge
          variant={
            record?.status === "passed"
              ? "success"
              : record?.status === "failed"
                ? "danger"
                : "neutral"
          }
        >
          {record?.status === "passed"
            ? text("통합 검증 통과", "Integration passed")
            : record?.status === "failed"
              ? text("통합 검증 실패", "Integration failed")
              : record?.status === "validating"
                ? text("통합 검증 중", "Validating integration")
                : record?.status === "awaiting-evidence"
                  ? text("실기기 증빙 대기", "Waiting for device evidence")
                : text("통합 완료 미확인", "Integration not confirmed")}
        </Badge>
      </div>
      {loading && (
        <p>{text("통합 기록 확인 중…", "Checking integration record…")}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {record?.successfulCommit && (
        <p>
          {text("성공 revision", "Successful revision")}:{" "}
          <code>{record.successfulCommit}</code>
        </p>
      )}
      {record?.previousSuccessfulCommit && (
        <p>
          {text("직전 성공 revision", "Previous successful revision")}:{" "}
          <code>{record.previousSuccessfulCommit}</code>
        </p>
      )}
      {!record && !loading && (
        <p className="planning-workspace__muted">
          {text(
            "작업 검토와 통합 검증은 각각 확인합니다.",
            "Task review and integration validation are checked separately.",
          )}
        </p>
      )}
      <Button size="sm" disabled={disabled} onClick={onOpen}>
        {text("통합 결과 보기", "View integration result")}
      </Button>
    </section>
  );
}

export function PlanningResultDetails({
  selection,
  read,
  onClose,
  onOpenConversation,
  onRetryReview,
  executionRuns,
  onRecordDeviceEvidence,
  retryDisabled,
  disabled,
}: {
  selection: PlanningResultSelection | null;
  read: PlanningResultReader;
  onClose: () => void;
  onOpenConversation?: (sessionId: string) => void;
  onRetryReview?: (result: PlanningResultRecord) => void;
  executionRuns?: readonly ExecutionRun[];
  onRecordDeviceEvidence?: (input: PlanningDeviceEvidenceInput) => Promise<boolean>;
  retryDisabled?: boolean;
  disabled: boolean;
}): JSX.Element {
  const text = useResultCopy();
  const [record, setRecord] = useState<
    PlanningResultRecord | PlanningIntegrationRecord | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [log, setLog] = useState<{
    reference: string;
    text: string | null;
    error?: string;
  } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [capture, setCapture] = useState<{ reference: string; mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64?: string; error?: string } | null>(null);
  const [deviceTarget, setDeviceTarget] = useState<PlanningDeviceEvidenceTarget | null>(null);
  const [diff, setDiff] = useState<{ text?: string; error?: string } | null>(
    null,
  );
  const diffChanges = useMemo(() => (diff?.text ? gitDiffFileChanges(diff.text) : []), [diff?.text]);
  useEffect(() => {
    let current = true;
    setRecord(null);
    setLog(null);
    setError(null);
    setDiff(null);
    setDiffOpen(false);
    setCapture(null);
    setDeviceTarget(null);
    if (!selection || disabled) return;
    setLoading(true);
    void read(selection)
      .then((result) => {
        if (!current) return;
        if (!result.ok) setError(result.message);
        else if (result.kind === "attempt" && selection.kind === "attempt")
          setRecord(result.result);
        else if (
          result.kind === "integration" &&
          selection.kind === "integration"
        )
          setRecord(result.integration);
        else
          setError(
            text(
              "결과 응답 형식이 맞지 않습니다.",
              "Unexpected result response.",
            ),
          );
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, read, refresh, disabled]);
  useEffect(() => {
    let current = true;
    if (!diffOpen || selection?.kind !== "attempt" || disabled) return;
    setDiff(null);
    void read({
      kind: "diff",
      projectId: selection.projectId,
      attemptId: selection.attemptId,
    })
      .then((result) => {
        if (!current) return;
        if (result.ok && result.kind === "diff") setDiff({ text: result.text });
        else
          setDiff({
            error: result.ok
              ? text(
                  "변경 내용 응답 형식이 맞지 않습니다.",
                  "Unexpected diff response.",
                )
              : result.message,
          });
      })
      .catch((reason: unknown) => {
        if (current) setDiff({ error: String(reason) });
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffOpen, selection, read, disabled]);
  useEffect(() => {
    let current = true;
    if (!log || !selection || disabled) return;
    const reference = log.reference;
    void read({ kind: "log", projectId: selection.projectId, reference })
      .then((result) => {
        if (!current) return;
        if (result.ok && result.kind === "log")
          setLog({ reference, text: result.text });
        else
          setLog({
            reference,
            text: null,
            error: result.ok
              ? text(
                  "로그 응답 형식이 맞지 않습니다.",
                  "Unexpected log response.",
                )
              : result.message,
          });
      })
      .catch((reason: unknown) => {
        if (current) setLog({ reference, text: null, error: String(reason) });
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log?.reference, selection?.projectId, read, disabled]);
  useEffect(() => {
    let current = true;
    if (!capture || !selection || disabled) return;
    const reference = capture.reference;
    void read({kind: 'capture', projectId: selection.projectId, reference}).then(result => {
      if (!current) return;
      if (result.ok && result.kind === 'capture') setCapture({ reference, mimeType: result.mimeType, dataBase64: result.dataBase64 });
      else setCapture({ reference, error: result.ok ? text('캡처 응답 형식이 맞지 않습니다.', 'Unexpected capture response.') : result.message });
    }).catch((reason: unknown) => { if (current) setCapture({ reference, error: String(reason) }); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture?.reference, selection?.projectId, read, disabled]);
  const deviceEvidenceTarget = (entry: PlanningValidationRecord): PlanningDeviceEvidenceTarget | null => {
    if (!record || entry.status !== 'not-run' || !onRecordDeviceEvidence) return null;
    const run = executionRuns?.find(candidate => candidate.runId === record.runId);
    if (!run) return null;
    if ('attemptId' in record) {
      if (record.baselineFingerprint !== run.preparation.baseline.fingerprint || !record.artifacts.length) return null;
      const task = run.preparation.tasks.find(candidate => candidate.taskId === record.taskId);
      const validation = task?.validations.find(candidate => candidate.validationId === entry.validationId && candidate.method === 'device');
      if (!task || !validation) return null;
      return {scope: 'attempt', runId: run.runId, taskId: task.taskId, validationId: validation.validationId, baselineFingerprint: record.baselineFingerprint, attemptId: record.attemptId, artifactIds: record.artifacts.map(artifact => artifact.artifactId), environment: validation.environment, command: validation.command};
    }
    if (record.status !== 'awaiting-evidence') return null;
    for (const task of run.preparation.tasks) {
      const validation = task.validations.find(candidate => `${task.taskId}:${candidate.validationId}` === entry.validationId && candidate.method === 'device');
      if (validation) return {scope: 'integration', runId: run.runId, taskId: task.taskId, validationId: validation.validationId, baselineFingerprint: run.preparation.baseline.fingerprint, candidateCommit: record.candidateCommit, environment: validation.environment, command: validation.command};
    }
    return null;
  };
  const validations = (entries: PlanningValidationRecord[]): JSX.Element => (
    <ul className="planning-workspace__history">
      {entries.map((entry) => (
        <li key={entry.validationId}>
          <div>
            <strong>{entry.validationId}</strong>
            <p>{entry.summary}</p>
            {entry.exitCode !== undefined && (
              <small>exit {entry.exitCode}</small>
            )}
            {entry.device && <dl className="planning-workspace__result-meta">
              <dt>{text('증빙 출처', 'Evidence source')}</dt><dd>{text('사용자가 직접 실행하고 확인함', 'Performed and attested by the user')}</dd>
              <dt>{text('기기', 'Device')}</dt><dd>{entry.device.deviceId} · {entry.device.platformVersion}</dd>
              <dt>{text('앱 버전', 'App version')}</dt><dd>{entry.device.appVersion}</dd>
              <dt>{text('실행 시각', 'Execution time')}</dt><dd>{entry.device.startedAt} → {entry.device.finishedAt}</dd>
              <dt>{text('실행 절차', 'Procedure')}</dt><dd><code>{entry.device.command}</code></dd>
              <dt>{text('로그 식별값', 'Log hash')}</dt><dd><code>{entry.device.logHash}</code></dd>
              <dt>{text('캡처 식별값', 'Capture hash')}</dt><dd><code>{entry.device.captureHash}</code></dd>
            </dl>}
            <div className="planning-workspace__actions">
              {entry.device && <Button size="sm" disabled={disabled} onClick={() => setCapture({ reference: entry.device!.captureHash })}>{text('저장한 기기 캡처', 'View saved device capture')}</Button>}
              {deviceEvidenceTarget(entry) && <Button size="sm" disabled={disabled || retryDisabled} onClick={() => setDeviceTarget(deviceEvidenceTarget(entry))}>{text('실기기 증빙 첨부', 'Attach device evidence')}</Button>}
              {entry.logRefs.map((reference, index) => (
                <Button
                  key={reference}
                  size="sm"
                  disabled={disabled}
                  onClick={() => setLog({ reference, text: null })}
                >
                  {text(
                    `검증 로그 ${index + 1}`,
                    `Validation log ${index + 1}`,
                  )}
                </Button>
              ))}
            </div>
          </div>
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
  );
  const attempt = record && "attemptId" in record ? record : null;
  const integration = record && "inputFingerprint" in record ? record : null;
  return (
    <Dialog
      size="lg"
      open={Boolean(selection)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        selection?.kind === "attempt"
          ? text("작업 결과와 검증 근거", "Task result and evidence")
          : text("통합 결과", "Integration result")
      }
      footer={<Button onClick={onClose}>{text("닫기", "Close")}</Button>}
    >
      <div className="planning-workspace__result">
        <Button
          size="sm"
          disabled={disabled || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {text("저장 결과 다시 확인", "Refresh saved result")}
        </Button>
        {error && <p role="alert">{error}</p>}
        {loading ? (
          <LoadingState
            label={text("저장 결과 확인 중", "Reading saved result")}
          />
        ) : !record && !error ? (
          <EmptyState
            title={text("저장된 결과가 아직 없습니다", "No saved result yet")}
            description={text(
              "실행과 검증이 기록된 후 확인할 수 있습니다.",
              "Results appear after execution and validation have been recorded.",
            )}
          />
        ) : null}
        {attempt && (
          <>
            <dl className="planning-workspace__result-meta">
              <dt>{text("결과 작업 경로", "Result workspace")}</dt>
              <dd>
                <code>{attempt.rootPath}</code>
              </dd>
              <dt>{text("기준 커밋", "Base commit")}</dt>
              <dd>
                <code>{attempt.baseCommit ?? "—"}</code>
              </dd>
              <dt>{text("결과 커밋", "Result commit")}</dt>
              <dd>
                <code>{attempt.commit ?? "—"}</code>
              </dd>
              <dt>{text("기준선 식별값", "Baseline fingerprint")}</dt>
              <dd>
                <code>{attempt.baselineFingerprint}</code>
              </dd>
            </dl>
            {attempt.error && <p role="alert">{attempt.error}</p>}
          {attempt.error && !attempt.review && onRetryReview && <Button size="sm" disabled={disabled || retryDisabled} onClick={() => onRetryReview(attempt)}>{text("독립 검토 다시 요청", "Retry independent review")}</Button>}
            <h3>{text("변경 파일", "Changed files")}</h3>
            {attempt.changedPaths.length ? (
              <ul>
                {attempt.changedPaths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{text("기록된 파일 변경 없음", "No recorded file changes")}</p>
            )}
            <Button
              size="sm"
              disabled={disabled || !attempt.baseCommit || !attempt.commit}
              onClick={() => setDiffOpen((open) => !open)}
            >
              {diffOpen
                ? text("변경 내용 접기", "Collapse diff")
                : text("고정한 결과 변경 내용", "View frozen result diff")}
            </Button>
            {diffOpen && (
              <section className="planning-workspace__result-log">
                {diff?.error ? (
                  <p role="alert">{diff.error}</p>
                ) : diff?.text !== undefined ? (
                  diffChanges.length > 0 ? (
                    <div className="planning-workspace__result-diff">
                      {diffChanges.map((change) => (
                        <DiffView key={change.path} change={change} />
                      ))}
                    </div>
                  ) : (
                    <pre>
                      {diff.text ||
                        text(
                          "기준 커밋과 파일 변경이 같습니다.",
                          "No file changes from the base commit.",
                        )}
                    </pre>
                  )
                ) : (
                  <LoadingState
                    label={text("변경 내용 읽는 중", "Reading result diff")}
                  />
                )}
              </section>
            )}
            <h3>{text("검증 결과", "Validation results")}</h3>
            {validations(attempt.validations)}
            <h3>{text("독립 검토", "Independent review")}</h3>
            {attempt.review ? (
              <>
                <Badge
                  variant={
                    attempt.review.decision === "approve" ? "success" : "danger"
                  }
                >
                  {attempt.review.decision}
                </Badge>
                <ChatMarkdown markdown={attempt.review.summary} />
                <ul>
                  {attempt.review.inspections.map((entry) => (
                    <li key={entry.validationId}>
                      {entry.validationId} · {entry.status}
                      <ChatMarkdown markdown={entry.summary} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{text("검토 기록 대기", "Waiting for review record")}</p>
            )}
            {attempt.reviewerSessionId && onOpenConversation && (
              <Button
                size="sm"
                onClick={() => onOpenConversation(attempt.reviewerSessionId!)}
              >
                {text("검토 AI 대화 열기", "Open reviewer conversation")}
              </Button>
            )}
          </>
        )}
        {integration && (
          <>
            <Badge
              variant={
                integration.status === "passed"
                  ? "success"
                  : integration.status === "failed"
                    ? "danger"
                    : "neutral"
              }
            >
              {integration.status === "passed"
                ? text("통합 검증 통과", "Integration passed")
                : integration.status === "failed"
                  ? text("통합 검증 실패", "Integration failed")
                  : integration.status === "awaiting-evidence"
                    ? text("실기기 증빙 대기", "Waiting for device evidence")
                  : text("통합 검증 중", "Validating integration")}
            </Badge>
            <dl className="planning-workspace__result-meta">
              <dt>{text("통합 작업 경로", "Integration workspace")}</dt>
              <dd>
                <code>{integration.workspacePath}</code>
              </dd>
              <dt>{text("통합 후보 revision", "Candidate revision")}</dt>
              <dd>
                <code>{integration.candidateCommit}</code>
              </dd>
              <dt>{text("성공 revision", "Successful revision")}</dt>
              <dd>
                <code>
                  {integration.successfulCommit ??
                    text("미확정", "Unconfirmed")}
                </code>
              </dd>
              <dt>
                {text("직전 성공 revision", "Previous successful revision")}
              </dt>
              <dd>
                <code>{integration.previousSuccessfulCommit ?? "—"}</code>
              </dd>
            </dl>
            {integration.error && <p role="alert">{integration.error}</p>}
            <h3>{text("통합 검증 결과", "Integration validation results")}</h3>
            {validations(integration.validations)}
            <details>
              <summary>
                {text("통합한 결과 revision", "Integrated artifact revisions")}
              </summary>
              <ul>
                {integration.inputArtifacts.map((entry) => (
                  <li key={entry.artifactId}>
                    <code>
                      {entry.artifactId} · {entry.revision}
                    </code>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        {log && (
          <section className="planning-workspace__result-log">
            <h3>{text("검증 로그", "Validation log")}</h3>
            <small>{log.reference}</small>
            {log.error ? (
              <p role="alert">{log.error}</p>
            ) : log.text === null ? (
              <LoadingState label={text("로그 읽는 중", "Reading log")} />
            ) : (
              <pre>{log.text}</pre>
            )}
          </section>
        )}
        {deviceTarget && onRecordDeviceEvidence && <PlanningDeviceEvidenceForm
          key={`${deviceTarget.scope}:${deviceTarget.taskId}:${deviceTarget.validationId}`}
          target={deviceTarget}
          disabled={disabled || Boolean(retryDisabled)}
          onCancel={() => setDeviceTarget(null)}
          onSubmit={async (input) => {
            const accepted = await onRecordDeviceEvidence(input);
            if (accepted) { setDeviceTarget(null); setRefresh(value => value + 1); }
            return accepted;
          }}
        />}
        {capture && <section className="planning-workspace__result-log"><h3>{text('사용자가 첨부한 실행 캡처', 'Execution capture supplied by the user')}</h3>{capture.error ? <p role="alert">{capture.error}</p> : capture.dataBase64 && capture.mimeType ? <img className="planning-workspace__evidence-capture" src={`data:${capture.mimeType};base64,${capture.dataBase64}`} alt={text('저장된 실기기 검증 캡처', 'Saved device validation capture')} /> : <LoadingState label={text('캡처 읽는 중', 'Reading capture')} />}</section>}
      </div>
    </Dialog>
  );
}
