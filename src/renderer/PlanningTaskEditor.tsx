import { Glyph, glyphIcon } from './ui/Glyph';
import { useState } from "react";
import type {
  PlanningOperation,
  PlanningSnapshot,
  TaskDefinition,
} from "../shared/planning";
import { useAppTranslation } from "./i18n";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
} from "./ui";

export type PlanningTaskDrafts = Readonly<
  Record<string, { value: TaskDefinition; dirty: boolean }>
>;
export interface PlanningTaskEditorProps {
  readonly snapshot: PlanningSnapshot;
  readonly drafts: PlanningTaskDrafts;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly onDraftChange: (task: TaskDefinition) => void;
  readonly onPatch: (operations: PlanningOperation[], summary: string) => void;
}
const id = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
function toggle(values: readonly string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

/** Task definitions remain editable planning data. This component never starts an execution. */
export function PlanningTaskEditor({
  snapshot,
  drafts,
  disabled,
  readOnly,
  onDraftChange,
  onPatch,
}: PlanningTaskEditorProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const text = (korean: string, english: string) => (ko ? korean : english);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entries = new Map(snapshot.draft.tasks.map((task) => [task.id, task]));
  for (const [key, draft] of Object.entries(drafts))
    entries.set(key, draft.value);
  const selected = selectedId ? entries.get(selectedId) : undefined;
  const update = (patch: Partial<TaskDefinition>): void => {
    if (selected) onDraftChange({ ...selected, ...patch });
  };
  const create = (): void => {
    const task: TaskDefinition = {
      id: id("task"),
      revision: 0,
      title: "",
      objective: "",
      featureIds: [],
      screenIds: [],
      inputRefs: [],
      dependencyIds: [],
      allowedPaths: [],
      interfaceRefs: [],
      acceptance: [],
      validationPlan: [],
      status: "draft",
    };
    onDraftChange(task);
    setSelectedId(task.id);
  };
  const inputs = [
    ...snapshot.draft.items.map((item) => ({
      ...item,
      refKind: "item" as const,
    })),
    ...snapshot.draft.scenes.map((scene) => ({
      ...scene,
      refKind: "scene" as const,
    })),
  ];
  return (
    <div
      className="planning-workspace__split"
      data-editing={Boolean(selected) || undefined}
    >
      <aside className="planning-workspace__list">
        <div className="planning-workspace__list-heading">
          <h2>{text("작업 정의", "Task definitions")}</h2>
          <IconButton
            icon={glyphIcon('plus')}
            aria-label={text("작업 정의 추가", "Add task definition")}
            disabled={readOnly}
            onClick={create}
          />
        </div>
        {[...entries.values()].map((task) => (
          <button
            className="planning-workspace__item"
            key={task.id}
            aria-pressed={selectedId === task.id}
            onClick={() => setSelectedId(task.id)}
          >
            <strong>
              {task.title || text("제목 없는 작업", "Untitled task")}
            </strong>
            <small>
              {text(
                `선행 작업 ${task.dependencyIds.length}개 · 완료 기준 ${task.acceptance.length}개`,
                `${task.dependencyIds.length} dependencies · ${task.acceptance.length} criteria`,
              )}
            </small>
            <Badge
              variant={
                task.status === "ready"
                  ? "success"
                  : task.status === "review-needed"
                    ? "warning"
                    : "neutral"
              }
            >
              {drafts[task.id]?.dirty
                ? text("미저장", "Unsaved")
                : task.status === "ready"
                  ? text("검토 완료", "Reviewed")
                  : task.status === "review-needed"
                    ? text("재검토 필요", "Needs review")
                    : text("초안", "Draft")}
            </Badge>
          </button>
        ))}
      </aside>
      {selected ? (
        <form
          className="planning-workspace__editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled)
              onPatch(
                [
                  {
                    op: "task.put",
                    value: {
                      ...selected,
                      title: selected.title.trim(),
                      allowedPaths: selected.allowedPaths
                        .map((path) => path.trim())
                        .filter(Boolean),
                    },
                  },
                ],
                text(
                  `작업 정의 저장: ${selected.title}`,
                  `Save task definition: ${selected.title}`,
                ),
              );
          }}
        >
          <div className="planning-workspace__editor-heading">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedId(null)}
            >
              {text("목록", "List")}
            </Button>
            <span>
              {text(
                "실행 전 작업 범위와 완료 기준",
                "Scope and criteria before execution",
              )}
            </span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              leadingIcon={<Glyph name="save" />}
              disabled={
                disabled ||
                !selected.title.trim() ||
                !drafts[selected.id]?.dirty
              }
            >
              {text("저장", "Save")}
            </Button>
          </div>
          <Field label={text("작업 제목", "Task title")} required>
            <Input
              value={selected.title}
              disabled={readOnly}
              maxLength={300}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <label className="planning-workspace__text-field">
            {text("목표와 작업 범위", "Objective and scope")}
            <textarea
              rows={4}
              value={selected.objective}
              disabled={readOnly}
              onChange={(event) => update({ objective: event.target.value })}
            />
          </label>
          <Field
            label={text("검증 환경 격리", "Validation environment isolation")}
          >
            <Select
              value={selected.executionEnvironment?.mode ?? "serial"}
              disabled={readOnly}
              onChange={(event) =>
                update({
                  executionEnvironment: {
                    mode: event.target.value as "serial" | "namespaced",
                    portCount: selected.executionEnvironment?.portCount ?? 0,
                  },
                })
              }
            >
              <option value="serial">
                {text(
                  "공유 환경 · 순차 실행",
                  "Shared environment · run serially",
                )}
              </option>
              <option value="namespaced">
                {text(
                  "작업별 환경 분리 준비됨",
                  "Tools support per-task isolation",
                )}
              </option>
            </Select>
          </Field>
          {selected.executionEnvironment?.mode === "namespaced" && (
            <>
              <p className="planning-workspace__muted">
                {text(
                  "프로젝트 도구가 PORT, EZTERMINAL_TEST_NAMESPACE, EZTERMINAL_OUTPUT_DIR, TMP/TEMP 설정을 사용해야 합니다. 이 조건에서만 독립 작업을 동시에 실행합니다.",
                  "Project tools must use PORT, EZTERMINAL_TEST_NAMESPACE, EZTERMINAL_OUTPUT_DIR and TMP/TEMP. Only then can independent tasks run concurrently.",
                )}
              </p>
              <Field label={text("필요한 포트 수", "Required port count")}>
                <Select
                  value={selected.executionEnvironment.portCount}
                  disabled={readOnly}
                  onChange={(event) =>
                    update({
                      executionEnvironment: {
                        mode: "namespaced",
                        portCount: Number(event.target.value),
                      },
                    })
                  }
                >
                  {[0, 1, 2, 3, 4].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <div className="planning-workspace__field-row">
            <Field label={text("담당 역할", "Role profile")}>
              <Select
                value={selected.profileId ?? ""}
                disabled={readOnly}
                onChange={(event) =>
                  update({ profileId: event.target.value || undefined })
                }
              >
                <option value="">{text("미지정", "Unassigned")}</option>
                {snapshot.draft.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={text("검토 상태", "Review status")}>
              <Select
                value={selected.status}
                disabled={readOnly}
                onChange={(event) =>
                  update({
                    status: event.target.value as TaskDefinition["status"],
                  })
                }
              >
                <option value="draft">{text("초안", "Draft")}</option>
                <option value="review-needed">
                  {text("재검토 필요", "Needs review")}
                </option>
                <option value="ready">{text("검토 완료", "Reviewed")}</option>
              </Select>
            </Field>
          </div>
          <fieldset className="planning-workspace__checks" disabled={readOnly}>
            <legend>
              {text("입력 기획과 화면", "Input plans and screens")}
            </legend>
            {inputs.length ? (
              inputs.map((entry) => (
                <label key={entry.id}>
                  <input
                    type="checkbox"
                    checked={selected.inputRefs.some(
                      (ref) => ref.id === entry.id,
                    )}
                    onChange={() => {
                      const removing = selected.inputRefs.some(
                        (ref) => ref.id === entry.id,
                      );
                      update({
                        inputRefs: removing
                          ? selected.inputRefs.filter(
                              (ref) => ref.id !== entry.id,
                            )
                          : [
                              ...selected.inputRefs,
                              {
                                id: entry.id,
                                kind: entry.refKind,
                                revision: entry.revision,
                              },
                            ],
                        ...(entry.refKind === "item"
                          ? {
                              featureIds: toggle(selected.featureIds, entry.id),
                            }
                          : {
                              screenIds: toggle(selected.screenIds, entry.id),
                            }),
                      });
                    }}
                  />
                  <span>
                    {entry.title} <small>r{entry.revision}</small>
                  </span>
                </label>
              ))
            ) : (
              <p className="planning-workspace__muted">
                {text(
                  "기획이나 화면을 먼저 저장하세요.",
                  "Save a plan or screen first.",
                )}
              </p>
            )}
          </fieldset>
          <fieldset className="planning-workspace__checks" disabled={readOnly}>
            <legend>{text("선행 작업", "Dependencies")}</legend>
            {snapshot.draft.tasks
              .filter((task) => task.id !== selected.id)
              .map((task) => (
                <label key={task.id}>
                  <input
                    type="checkbox"
                    checked={selected.dependencyIds.includes(task.id)}
                    onChange={() =>
                      update({
                        dependencyIds: toggle(selected.dependencyIds, task.id),
                      })
                    }
                  />
                  {task.title}
                </label>
              ))}
            {snapshot.draft.tasks.filter((task) => task.id !== selected.id)
              .length === 0 && (
              <p className="planning-workspace__muted">
                {text(
                  "다른 작업을 저장하면 선택할 수 있습니다.",
                  "Save another task to select a dependency.",
                )}
              </p>
            )}
          </fieldset>
          <label className="planning-workspace__text-field">
            {text(
              "허용 경로 · 프로젝트 기준, 한 줄에 하나",
              "Allowed paths · project-relative, one per line",
            )}
            <textarea
              rows={3}
              disabled={readOnly}
              value={selected.allowedPaths.join("\n")}
              onChange={(event) =>
                update({ allowedPaths: event.target.value.split("\n") })
              }
              placeholder="src/feature"
            />
          </label>
          <section>
            <div className="planning-workspace__list-heading">
              <h3>{text("완료 기준", "Acceptance criteria")}</h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                leadingIcon={<Glyph name="plus" />}
                onClick={() =>
                  update({
                    acceptance: [
                      ...selected.acceptance,
                      { id: id("acceptance"), description: "" },
                    ],
                  })
                }
              >
                {text("기준 추가", "Add criterion")}
              </Button>
            </div>
            {selected.acceptance.map((criterion, index) => (
              <div
                key={criterion.id}
                className="planning-workspace__connection"
              >
                <Field
                  label={text(
                    `완료 기준 ${index + 1}`,
                    `Criterion ${index + 1}`,
                  )}
                >
                  <Input
                    value={criterion.description}
                    disabled={readOnly}
                    onChange={(event) =>
                      update({
                        acceptance: selected.acceptance.map((entry) =>
                          entry.id === criterion.id
                            ? { ...entry, description: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                </Field>
                <IconButton
                  icon={glyphIcon('trash')}
                  aria-label={text("완료 기준 삭제", "Remove criterion")}
                  disabled={readOnly}
                  onClick={() =>
                    update({
                      acceptance: selected.acceptance.filter(
                        (entry) => entry.id !== criterion.id,
                      ),
                      validationPlan: selected.validationPlan.map((entry) => ({
                        ...entry,
                        acceptanceIds: entry.acceptanceIds.filter(
                          (key) => key !== criterion.id,
                        ),
                      })),
                    })
                  }
                />
              </div>
            ))}
          </section>
          <section>
            <div className="planning-workspace__list-heading">
              <h3>{text("검증 계획", "Validation plan")}</h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                leadingIcon={<Glyph name="plus" />}
                onClick={() =>
                  update({
                    validationPlan: [
                      ...selected.validationPlan,
                      {
                        id: id("validation"),
                        acceptanceIds: [],
                        description: "",
                        method: "inspection",
                        environment: "",
                      },
                    ],
                  })
                }
              >
                {text("검증 추가", "Add validation")}
              </Button>
            </div>
            {selected.validationPlan.map((validation, index) => {
              const change = (
                patch: Partial<TaskDefinition["validationPlan"][number]>,
              ) =>
                update({
                  validationPlan: selected.validationPlan.map((entry) =>
                    entry.id === validation.id ? { ...entry, ...patch } : entry,
                  ),
                });
              return (
                <fieldset
                  className="planning-workspace__validation"
                  key={validation.id}
                  disabled={readOnly}
                >
                  <legend>
                    {text(`검증 ${index + 1}`, `Validation ${index + 1}`)}
                  </legend>
                  <Field label={text("검증 설명", "Validation description")}>
                    <Input
                      value={validation.description}
                      onChange={(event) =>
                        change({ description: event.target.value })
                      }
                    />
                  </Field>
                  <div className="planning-workspace__field-row">
                    <Field label={text("검증 방법", "Validation method")}>
                      <Select
                        value={validation.method}
                        onChange={(event) =>
                          change({
                            method: event.target
                              .value as typeof validation.method,
                          })
                        }
                      >
                        <option value="inspection">
                          {text("검토", "Inspection")}
                        </option>
                        <option value="command">
                          {text("명령 실행", "Command")}
                        </option>
                        <option value="device">
                          {text("실제 기기", "Device")}
                        </option>
                      </Select>
                    </Field>
                    <Field label={text("검증 환경", "Environment")}>
                      <Input
                        value={validation.environment}
                        onChange={(event) =>
                          change({ environment: event.target.value })
                        }
                        placeholder={text("예: Windows 11", "e.g. Windows 11")}
                      />
                    </Field>
                  </div>
                  {validation.method === "command" && (
                    <Field
                      label={text("실행할 검증 명령", "Validation command")}
                    >
                      <Input
                        value={validation.command ?? ""}
                        onChange={(event) =>
                          change({ command: event.target.value })
                        }
                      />
                    </Field>
                  )}
                  <fieldset className="planning-workspace__checks">
                    <legend>
                      {text("검증할 완료 기준", "Covered acceptance criteria")}
                    </legend>
                    {selected.acceptance.map((criterion) => (
                      <label key={criterion.id}>
                        <input
                          type="checkbox"
                          checked={validation.acceptanceIds.includes(
                            criterion.id,
                          )}
                          onChange={() =>
                            change({
                              acceptanceIds: toggle(
                                validation.acceptanceIds,
                                criterion.id,
                              ),
                            })
                          }
                        />
                        {criterion.description ||
                          text("작성 중인 완료 기준", "Untitled criterion")}
                      </label>
                    ))}
                  </fieldset>
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<Glyph name="trash" />}
                    onClick={() =>
                      update({
                        validationPlan: selected.validationPlan.filter(
                          (entry) => entry.id !== validation.id,
                        ),
                      })
                    }
                  >
                    {text("검증 삭제", "Remove validation")}
                  </Button>
                </fieldset>
              );
            })}
          </section>
        </form>
      ) : (
        <EmptyState
          title={text("실행할 작업을 정의하세요", "Define the work to execute")}
          description={text(
            "입력 기획, 허용 경로, 선행 작업과 완료 기준을 지정합니다. 저장만으로 실행되지 않습니다.",
            "Specify inputs, allowed paths, dependencies and acceptance criteria. Saving does not start execution.",
          )}
          action={
            <Button disabled={readOnly} onClick={create}>
              {text("작업 정의 추가", "Add task definition")}
            </Button>
          }
        />
      )}
    </div>
  );
}
