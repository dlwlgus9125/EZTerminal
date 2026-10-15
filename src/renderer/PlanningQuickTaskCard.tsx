import type { PlanningRoleProfile, TaskDefinition } from "../shared/planning";
import { useState } from "react";
import { useAppTranslation } from "./i18n";
import { Button, Field, Input, Select } from "./ui";

export function createQuickTaskDraft(): TaskDefinition {
  return {
    id: `quick-task-${crypto.randomUUID()}`,
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
    validationPlan: [
      {
        id: `validation-${crypto.randomUUID()}`,
        acceptanceIds: [],
        description: "Validate the acceptance criteria",
        method: "command",
        command: "",
        environment: "",
      },
    ],
    status: "draft",
  };
}

export function PlanningQuickTaskCard({
  task,
  profiles,
  disabled,
  readOnly,
  onChange,
  onFreeze,
  onInitializeRoles,
  onClose,
}: {
  readonly task: TaskDefinition;
  readonly profiles: readonly PlanningRoleProfile[];
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly onChange: (task: TaskDefinition) => void;
  readonly onFreeze: (task: TaskDefinition, reviewerProfileId: string) => void;
  readonly onInitializeRoles: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const text = (korean: string, english: string): string =>
    ko ? korean : english;
  const [reviewerId, setReviewerId] = useState("");
  const implementations = profiles.filter(
    (profile) => profile.role === "implementation",
  );
  const reviewers = profiles.filter((profile) => profile.role === "review");
  const validation = task.validationPlan[0];
  const update = (patch: Partial<TaskDefinition>) =>
    onChange({ ...task, ...patch });
  const updateValidation = (
    patch: Partial<TaskDefinition["validationPlan"][number]>,
  ) => update({ validationPlan: [{ ...validation, ...patch }] });
  return (
    <form
      className="planning-workspace__quick-task"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const acceptance = task.acceptance
          .filter((criterion) => criterion.description.trim())
          .map((criterion) => ({
            ...criterion,
            description: criterion.description.trim(),
          }));
        onFreeze(
          {
            ...task,
            title: task.title.trim(),
            objective: task.objective.trim(),
            status: "ready",
            allowedPaths: task.allowedPaths
              .map((path) => path.trim())
              .filter(Boolean),
            acceptance,
            validationPlan: [
              {
                ...validation,
                acceptanceIds: acceptance.map((criterion) => criterion.id),
              },
            ],
          },
          reviewerId,
        );
      }}
    >
      <div className="planning-workspace__list-heading">
        <h3>{text("간단 작업 카드", "Quick task card")}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {text("접기", "Collapse")}
        </Button>
      </div>
      <p className="planning-workspace__muted">
        {text(
          "작업 범위와 완료 기준을 확인한 후 이 작업만의 기준선을 만듭니다. 기존 기획 초안은 유지되며 AI 실행은 다음 단계에서 직접 시작합니다.",
          "Review the scope and acceptance criteria to freeze a baseline for this task. Existing planning drafts stay intact; start AI execution explicitly in the next step.",
        )}
      </p>
      <label className="planning-workspace__text-field">
        {text("하려는 작업", "What to do")}
        <textarea
          rows={3}
          value={task.objective}
          disabled={readOnly}
          onChange={(event) =>
            update({
              objective: event.target.value,
              title: event.target.value.split("\n")[0].slice(0, 300),
            })
          }
          placeholder={text(
            "예: 설정 화면에 글자 크기 조절을 추가해줘",
            "e.g. Add a font size control to settings",
          )}
        />
      </label>
      <label className="planning-workspace__text-field">
        {text("작업할 경로 · 한 줄에 하나", "Allowed paths · one per line")}
        <textarea
          rows={2}
          value={task.allowedPaths.join("\n")}
          disabled={readOnly}
          onChange={(event) =>
            update({ allowedPaths: event.target.value.split("\n") })
          }
          placeholder="src/renderer"
        />
      </label>
      <label className="planning-workspace__text-field">
        {text("완료 기준 · 한 줄에 하나", "Acceptance criteria · one per line")}
        <textarea
          rows={3}
          value={task.acceptance
            .map((criterion) => criterion.description)
            .join("\n")}
          disabled={readOnly}
          onChange={(event) =>
            update({
              acceptance: event.target.value
                .split("\n")
                .map((description, index) => ({
                  id:
                    task.acceptance[index]?.id ??
                    `acceptance-${crypto.randomUUID()}`,
                  description,
                })),
            })
          }
        />
      </label>
      <div className="planning-workspace__field-row">
        <Field label={text("검증 방법", "Validation method")}>
          <Select
            disabled={readOnly}
            value={validation.method}
            onChange={(event) =>
              updateValidation({
                method: event.target.value as typeof validation.method,
              })
            }
          >
            <option value="command">{text("명령 실행", "Command")}</option>
            <option value="inspection">
              {text("독립 검토", "Inspection")}
            </option>
            <option value="device">{text("실제 기기", "Device")}</option>
          </Select>
        </Field>
        <Field label={text("검증 환경", "Validation environment")}>
          <Input
            value={validation.environment}
            disabled={readOnly}
            onChange={(event) =>
              updateValidation({ environment: event.target.value })
            }
            placeholder={text("예: Windows 11", "e.g. Windows 11")}
          />
        </Field>
      </div>
      {validation.method === "command" ? (
        <Field label={text("검증 명령", "Validation command")}>
          <Input
            disabled={readOnly}
            value={validation.command ?? ""}
            onChange={(event) =>
              updateValidation({ command: event.target.value })
            }
            placeholder="pnpm test"
          />
        </Field>
      ) : (
        <Field label={text("확인할 내용과 방법", "What and how to validate")}>
          <Input
            disabled={readOnly}
            value={validation.description}
            onChange={(event) =>
              updateValidation({ description: event.target.value })
            }
          />
        </Field>
      )}
      {implementations.length && reviewers.length ? (
        <div className="planning-workspace__field-row">
          <Field label={text("구현 역할", "Implementation role")}>
            <Select
              value={task.profileId ?? ""}
              disabled={readOnly}
              onChange={(event) =>
                update({ profileId: event.target.value || undefined })
              }
            >
              <option value="">{text("역할 선택", "Select role")}</option>
              {implementations.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={text("독립 검토 역할", "Independent review role")}>
            <Select
              value={reviewerId}
              disabled={readOnly}
              onChange={(event) => setReviewerId(event.target.value)}
            >
              <option value="">{text("역할 선택", "Select role")}</option>
              {reviewers.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : (
        <div>
          <p>
            {text(
              "구현과 독립 검토 역할이 필요합니다.",
              "An implementation role and an independent review role are required.",
            )}
          </p>
          <Button disabled={disabled} onClick={onInitializeRoles}>
            {text("기본 역할 준비", "Initialize default roles")}
          </Button>
        </div>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={
          disabled ||
          !task.objective.trim() ||
          !task.profileId ||
          !reviewerId ||
          !task.acceptance.some((criterion) => criterion.description.trim()) ||
          !validation.environment.trim() ||
          (validation.method === "command" && !validation.command?.trim())
        }
      >
        {text(
          "작업 기준 확정하고 실행 준비로",
          "Freeze task scope and prepare execution",
        )}
      </Button>
    </form>
  );
}
