import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProjectArchiveHistory,
  ProjectArchiveInventory,
  ProjectArchiveManifest,
  ProjectArchiveRequest,
  ProjectArchiveResult,
} from "../shared/project-archive";
import { useAppTranslation } from "./i18n";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingState,
  Select,
} from "./ui";
import "./planning-workspace.css";

export interface ProjectArchiveAccess {
  executeProjectArchive(
    request: ProjectArchiveRequest,
  ): Promise<ProjectArchiveResult>;
}
export function ProjectArchivePanel({
  projectId,
  access,
  disabled,
  onOpenProject,
  pendingRequest,
  persistPendingRequest,
}: {
  projectId: string;
  access: ProjectArchiveAccess;
  disabled: boolean;
  onOpenProject?: (projectId: string) => void;
  pendingRequest?: ProjectArchiveRequest | null;
  persistPendingRequest?: (
    request: ProjectArchiveRequest | null,
  ) => Promise<void>;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const text = (korean: string, english: string) => (ko ? korean : english);
  const [inventory, setInventory] = useState<ProjectArchiveInventory | null>(
    null,
  );
  const [history, setHistory] = useState<ProjectArchiveHistory | null>(null);
  const [manifest, setManifest] = useState<ProjectArchiveManifest | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [restoredProject, setRestoredProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"archive" | "history">("archive");
  const [historySection, setHistorySection] = useState<
    "planning" | "conversations" | "execution"
  >("planning");
  const [sessionId, setSessionId] = useState("");
  const [localPending, setLocalPending] =
    useState<ProjectArchiveRequest | null>(null);
  const uncertain = pendingRequest ?? localPending;
  const locked = disabled || busy || Boolean(uncertain);
  const mounted = useRef(true);
  const pending = useRef(false);
  const persistRequest = async (
    command: ProjectArchiveRequest | null,
  ): Promise<void> => {
    if (persistPendingRequest) await persistPendingRequest(command);
    if (mounted.current) setLocalPending(command);
  };
  const refresh = useCallback(async () => {
    if (disabled || pending.current) return;
    setLoading(true);
    try {
      const result = await access.executeProjectArchive({
        type: "inventory",
        projectId,
      });
      if (!mounted.current) return;
      if (result.ok && result.kind === "inventory") {
        setInventory(result.inventory);
        setSelected([]);
        setError(null);
      } else if (!result.ok) setError(result.message);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [access, disabled, projectId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  const request = async (command: ProjectArchiveRequest): Promise<void> => {
    if (disabled || pending.current) return;
    const writes =
      command.type === "export" ||
      command.type === "restore" ||
      command.type === "cleanup";
    if (
      writes &&
      uncertain &&
      JSON.stringify(uncertain) !== JSON.stringify(command)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (writes) await persistRequest(command);
      if (!mounted.current) return;
      const result = await access.executeProjectArchive(command);
      if (!mounted.current) return;
      if (!result.ok) {
        if (result.error !== "cancelled") setError(result.message);
        if (writes && result.error !== "unavailable")
          await persistRequest(null);
        return;
      }
      if (writes) await persistRequest(null);
      if (result.kind === "inspect") {
        setArchiveId(result.archiveId);
        setManifest(result.manifest);
        setName(
          `${result.manifest.projectName} ${text("복원", "restored")}`.slice(
            0,
            100,
          ),
        );
      }
      if (result.kind === "export") {
        setManifest(result.manifest);
        setArchiveId(null);
        setNotice(
          text(
            `저장한 패키지: ${result.path}`,
            `Saved package: ${result.path}`,
          ),
        );
      }
      if (result.kind === "restore") {
        setRestoredProject(result.projectId);
        setArchiveId(null);
        setNotice(
          text(
            `새 프로젝트로 복원했습니다: ${result.rootPath}`,
            `Restored as a new project: ${result.rootPath}`,
          ),
        );
      }
      if (result.kind === "history") {
        setHistory(result.history);
        setView("history");
        setSessionId(result.history?.conversations[0]?.session.id ?? "");
      }
      if (result.kind === "cleanup") {
        setCleanupOpen(false);
        setCleanupConfirmed(false);
        setSelected([]);
        setInventory(null);
        setNotice(
          text(
            `${result.removedItems}개 기록을 정리했습니다.`,
            `Removed ${result.removedItems} records.`,
          ),
        );
      }
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
    if (command.type === "cleanup") await refresh();
  };
  const bytes = (value: number): string =>
    value < 1024
      ? `${value} B`
      : value < 1024 * 1024
        ? `${(value / 1024).toFixed(1)} KB`
        : `${(value / (1024 * 1024)).toFixed(1)} MB`;
  const selectedEntries =
    inventory?.conversations.filter(
      (entry) => selected.includes(entry.sessionId) && entry.deletable,
    ) ?? [];
  const conversation = history?.conversations.find(
    (entry) => entry.session.id === sessionId,
  );
  const manifestView = (value: ProjectArchiveManifest): JSX.Element => (
    <section className="planning-workspace__archive-manifest">
      <h3>{text("패키지 포함 목록", "Package contents")}</h3>
      <p>
        {value.projectName} · {new Date(value.createdAt).toLocaleString()}
      </p>
      <Badge variant={value.portable ? "success" : "warning"}>
        {value.portable
          ? text("이동 가능한 기록", "Portable records")
          : text("포함 범위 확인 필요", "Review package scope")}
      </Badge>
      <ul>
        {[...new Set(value.entries.map((entry) => entry.kind))].map((kind) => (
          <li key={kind}>
            {kind} ·{" "}
            {value.entries.filter((entry) => entry.kind === kind).length} ·{" "}
            {bytes(
              value.entries
                .filter((entry) => entry.kind === kind)
                .reduce((sum, entry) => sum + entry.byteLength, 0),
            )}
          </li>
        ))}
      </ul>
      <h4>{text("포함하지 않는 항목", "Excluded items")}</h4>
      <ul>
        {value.exclusions.map((entry) => (
          <li key={entry.item}>
            <strong>{entry.item}</strong> — {entry.reason}
          </li>
        ))}
      </ul>
      {value.notes.map((note, index) => (
        <p key={index}>{note}</p>
      ))}
      <details>
        <summary>
          {text("기준 revision과 무결성", "Revisions and integrity")}
        </summary>
        <p>
          Planning r{value.source.planningRevision} · Daemon r
          {value.source.daemonRevision} · Execution r
          {value.source.executionRevision}
        </p>
        <code>{value.integrity}</code>
      </details>
    </section>
  );
  return (
    <section className="planning-workspace__archive">
      <div className="planning-workspace__list-heading">
        <h2>{text("프로젝트 기록과 보관", "Project history and archive")}</h2>
        <Button
          size="sm"
          disabled={disabled || busy}
          onClick={() => void refresh()}
        >
          {text("용량 다시 확인", "Refresh storage inventory")}
        </Button>
      </div>
      <div className="planning-workspace__subnav">
        <Button
          size="sm"
          aria-pressed={view === "archive"}
          onClick={() => setView("archive")}
        >
          {text("백업·복원·정리", "Backup, restore and cleanup")}
        </Button>
        <Button
          size="sm"
          disabled={disabled || busy}
          aria-pressed={view === "history"}
          onClick={() => void request({ type: "history", projectId })}
        >
          {text("복원한 역사 보기", "View restored history")}
        </Button>
      </div>
      {error && (
        <p className="planning-workspace__message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="planning-workspace__message" role="status">
          {notice}
        </p>
      )}
      {restoredProject && onOpenProject && (
        <Button onClick={() => onOpenProject(restoredProject)}>
          {text("복원한 프로젝트 열기", "Open restored project")}
        </Button>
      )}
      {uncertain && (
        <div className="planning-workspace__message" role="alert">
          <p>
            {text(
              "보관 요청 결과를 확인하지 못했습니다. 새 요청 전에 같은 요청의 처리 결과를 확인하세요.",
              "The archive request outcome is unknown. Check the same request before starting another.",
            )}
          </p>
          <Button
            disabled={disabled || busy}
            onClick={() => void request(uncertain)}
          >
            {text("보관 요청 결과 확인", "Check archive request")}
          </Button>
        </div>
      )}
      {view === "archive" ? (
        <>
          <p>
            {text(
              "저장된 기획, 실행, 대화와 검증 기록을 한 패키지로 보관합니다. OS 자격 증명, API 토큰과 기기 연결 키는 이동하지 않습니다.",
              "Keep saved planning, execution, conversations and evidence in one package. OS credentials, API tokens and device pairing keys are excluded.",
            )}
          </p>
          {loading && !inventory ? (
            <LoadingState
              label={text("기록 용량 확인 중", "Reading storage inventory")}
            />
          ) : (
            inventory && (
              <ul className="planning-workspace__history">
                {inventory.groups.map((group) => (
                  <li key={group.kind}>
                    <strong>{group.kind}</strong>
                    <span>
                      {group.items} · {bytes(group.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          )}
          <div className="planning-workspace__actions">
            <Button
              disabled={locked || !inventory}
              onClick={() =>
                void request({
                  type: "export",
                  projectId,
                  commandId: `archive-${crypto.randomUUID()}`,
                })
              }
            >
              {text("프로젝트 기록 내보내기", "Export project records")}
            </Button>
            <Button
              disabled={locked}
              onClick={() => void request({ type: "inspect", projectId })}
            >
              {text("패키지 선택하고 내용 확인", "Choose and inspect package")}
            </Button>
          </div>
          {manifest && manifestView(manifest)}
          {archiveId && (
            <form
              className="planning-workspace__baseline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void request({
                  type: "restore",
                  archiveId,
                  name: name.trim(),
                  commandId: `archive-${crypto.randomUUID()}`,
                });
              }}
            >
              <Field
                label={text("복원할 새 프로젝트 이름", "New project name")}
              >
                <Input
                  value={name}
                  disabled={disabled || busy}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Button type="submit" disabled={locked || !name.trim()}>
                {text("새 프로젝트로 복원", "Restore as new project")}
              </Button>
            </form>
          )}
          <h3>
            {text(
              "보관된 대화 기록 수동 정리",
              "Manually clean archived conversations",
            )}
          </h3>
          <p className="planning-workspace__muted">
            {text(
              "실행·검토에서 참조하는 기록과 진행 중인 대화는 보호됩니다. 정리는 선택한 삭제 가능 기록에만 적용됩니다.",
              "Records referenced by execution or review and active conversations are protected. Cleanup applies only to selected deletable records.",
            )}
          </p>
          {inventory?.conversations.length ? (
            <ul className="planning-workspace__archive-conversations">
              {inventory.conversations.map((entry) => (
                <li key={entry.sessionId}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={locked || !entry.deletable}
                      checked={selected.includes(entry.sessionId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, entry.sessionId]
                            : current.filter((id) => id !== entry.sessionId),
                        )
                      }
                    />
                    <span>
                      <strong>{entry.title}</strong>
                      <small>
                        {entry.items} · {bytes(entry.bytes)}
                        {entry.protection ? ` · ${entry.protection}` : ""}
                      </small>
                    </span>
                  </label>
                  {!entry.deletable && (
                    <Badge>{text("보호됨", "Protected")}</Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {text(
                "정리할 보관 대화가 없습니다.",
                "No archived conversations to clean up.",
              )}
            </p>
          )}
          <Button
            disabled={locked || selectedEntries.length === 0}
            onClick={() => {
              setCleanupConfirmed(false);
              setCleanupOpen(true);
            }}
          >
            {text("선택한 기록 정리", "Clean selected records")}
          </Button>
        </>
      ) : !history ? (
        <EmptyState
          title={text("복원한 역사 기록이 없습니다", "No restored history")}
          description={text(
            "패키지에서 복원한 이전 기록은 이곳에서 읽기 전용으로 확인합니다.",
            "Previously restored records appear here as read-only history.",
          )}
        />
      ) : (
        <>
          <Badge>{text("읽기 전용 역사", "Read-only history")}</Badge>
          {manifestView(history.manifest)}
          <Field label={text("역사 보기", "History view")}>
            <Select
              value={historySection}
              onChange={(event) =>
                setHistorySection(event.target.value as typeof historySection)
              }
            >
              <option value="planning">
                {text("기획과 기준선", "Planning and baselines")}
              </option>
              <option value="conversations">
                {text("대화 기록", "Conversations")}
              </option>
              <option value="execution">
                {text("실행과 검증", "Execution and evidence")}
              </option>
            </Select>
          </Field>
          {historySection === "planning" && (
            <>
              <p>
                {text("복원 원본 기획 revision", "Original planning revision")}{" "}
                {history.planning.revision} ·{" "}
                {history.planning.baselines.length}{" "}
                {text("기준선", "baselines")}
              </p>
              {history.planning.draft.items.map((item) => (
                <details key={item.id}>
                  <summary>
                    {item.title} · r{item.revision}
                  </summary>
                  <p className="planning-workspace__proposal">{item.body}</p>
                  <ul>
                    {item.acceptance.map((criterion, index) => (
                      <li key={index}>{criterion}</li>
                    ))}
                  </ul>
                </details>
              ))}
              <details>
                <summary>
                  {text("기획 변경 기록", "Planning change history")}
                </summary>
                <ol>
                  {history.planning.history.map((entry) => (
                    <li key={entry.id}>
                      r{entry.revision} · {entry.summary}
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
          {historySection === "conversations" && (
            <>
              <Field
                label={text("보관된 대화 선택", "Choose archived conversation")}
              >
                <Select
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                >
                  {history.conversations.map((entry) => (
                    <option key={entry.session.id} value={entry.session.id}>
                      {entry.session.title}
                    </option>
                  ))}
                </Select>
              </Field>
              {conversation?.transcript.map((entry) => (
                <article
                  className="planning-workspace__archive-message"
                  key={entry.id}
                >
                  <small>
                    {entry.kind} · #{entry.sequence}
                  </small>
                  <p className="planning-workspace__proposal">{entry.text}</p>
                </article>
              ))}
            </>
          )}
          {historySection === "execution" && (
            <>
              {history.execution.runs.map((run) => (
                <details key={run.runId}>
                  <summary>
                    {run.runId} · {run.state}
                  </summary>
                  <p>
                    {run.preparation.baseline.baselineId} · r
                    {run.preparation.baseline.revision}
                  </p>
                  <ul>
                    {run.attempts.map((attempt) => (
                      <li key={attempt.attemptId}>
                        {attempt.taskId} · {attempt.state}
                        <p>{attempt.summary}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
              {history.results.map((result) => (
                <details key={result.attemptId}>
                  <summary>
                    {result.attemptId} · {text("검증 근거", "Evidence")}
                  </summary>
                  <ul>
                    {result.validations.map((validation) => (
                      <li key={validation.validationId}>
                        {validation.validationId} · {validation.status}
                        <p>{validation.summary}</p>
                      </li>
                    ))}
                  </ul>
                  {result.review && (
                    <p>
                      {result.review.decision} · {result.review.summary}
                    </p>
                  )}
                </details>
              ))}
              {history.integrations.map((integration) => (
                <p key={integration.runId}>
                  {text("통합 검증", "Integration validation")} ·{" "}
                  {integration.status} ·{" "}
                  {integration.successfulCommit ??
                    text("성공 revision 없음", "No successful revision")}
                </p>
              ))}
            </>
          )}
        </>
      )}
      <Dialog
        open={cleanupOpen}
        onOpenChange={(open) => {
          if (!busy) setCleanupOpen(open);
        }}
        title={text(
          "선택한 기록 영구 정리",
          "Permanently clean selected records",
        )}
        footer={
          <>
            <Button disabled={busy} onClick={() => setCleanupOpen(false)}>
              {text("취소", "Cancel")}
            </Button>
            <Button
              disabled={
                locked ||
                !cleanupConfirmed ||
                !inventory ||
                selectedEntries.length === 0
              }
              onClick={() => {
                if (inventory)
                  void request({
                    type: "cleanup",
                    projectId,
                    inventoryToken: inventory.token,
                    sessionIds: selectedEntries.map((entry) => entry.sessionId),
                    confirmation: "delete-selected-archived-history",
                  });
              }}
            >
              {text("기록 영구 정리", "Permanently remove records")}
            </Button>
          </>
        }
      >
        <p>
          {selectedEntries.length} {text("개 대화", "conversations")} ·{" "}
          {bytes(selectedEntries.reduce((sum, entry) => sum + entry.bytes, 0))}
        </p>
        <ul>
          {selectedEntries.map((entry) => (
            <li key={entry.sessionId}>{entry.title}</li>
          ))}
        </ul>
        <label>
          <input
            type="checkbox"
            checked={cleanupConfirmed}
            disabled={busy}
            onChange={(event) => setCleanupConfirmed(event.target.checked)}
          />
          {text(
            "선택한 대화 기록이 이 PC에서 영구 삭제됨을 확인했습니다.",
            "I understand these selected conversation records will be permanently removed from this PC.",
          )}
        </label>
      </Dialog>
    </section>
  );
}
