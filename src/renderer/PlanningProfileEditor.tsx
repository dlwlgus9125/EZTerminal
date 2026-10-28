import { Glyph, glyphIcon } from './ui/Glyph';
import { useState } from "react";
import type {
  PlanningOperation,
  PlanningRoleProfile,
  PlanningSnapshot,
} from "../shared/planning";
import { planningProfilePresets } from "../shared/planning-profile-presets";
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
import { ChatMarkdown } from "./chat/markdown/ChatMarkdown";

export type PlanningProfileDrafts = Readonly<
  Record<string, { value: PlanningRoleProfile; dirty: boolean }>
>;
export function PlanningProfileEditor({
  snapshot,
  drafts,
  disabled,
  readOnly,
  onDraftChange,
  onPatch,
  onApplyProposal,
}: {
  readonly snapshot: PlanningSnapshot;
  readonly drafts: PlanningProfileDrafts;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly onDraftChange: (profile: PlanningRoleProfile) => void;
  readonly onPatch: (operations: PlanningOperation[], summary: string) => void;
  readonly onApplyProposal: (proposalId: string) => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const text = (korean: string, english: string) => (ko ? korean : english);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entries = new Map(
    snapshot.draft.profiles.map((profile) => [profile.id, profile]),
  );
  for (const [key, draft] of Object.entries(drafts))
    entries.set(key, draft.value);
  const selected = selectedId ? entries.get(selectedId) : undefined;
  const roles: Record<PlanningRoleProfile["role"], string> = {
    planning: text("기획", "Planning"),
    design: text("설계", "Design"),
    implementation: text("구현", "Implementation"),
    review: text("검토", "Review"),
    integration: text("통합", "Integration"),
  };
  const tools: Record<PlanningRoleProfile["allowedTools"][number], string> = {
    "planning.read": text("기획 읽기", "Read planning"),
    "planning.patch": text("기획 변경 제안", "Propose planning changes"),
    "project.read": text("프로젝트 읽기", "Read project"),
    "project.write": text("프로젝트 수정", "Write project"),
    "terminal.execute": text("명령 실행", "Execute commands"),
    "review.read": text("검토 근거 읽기", "Read review evidence"),
  };
  const update = (patch: Partial<PlanningRoleProfile>): void => {
    if (selected) onDraftChange({ ...selected, ...patch });
  };
  const create = (): void => {
    const profile: PlanningRoleProfile = {
      id: `profile-${crypto.randomUUID()}`,
      revision: 0,
      title: "",
      role: "planning",
      instructions: "",
      contextRefs: [],
      allowedTools: ["planning.read", "project.read"],
      retryLimit: 2,
    };
    onDraftChange(profile);
    setSelectedId(profile.id);
  };
  const missingPresets = planningProfilePresets(ko ? "ko" : "en").filter(
    (profile) => !entries.has(profile.id),
  );
  return (
    <div
      className="planning-workspace__split"
      data-editing={Boolean(selected) || undefined}
    >
      <aside className="planning-workspace__list">
        <div className="planning-workspace__list-heading">
          <h2>{text("역할 프로필", "Role profiles")}</h2>
          <IconButton
            icon={glyphIcon('plus')}
            aria-label={text("역할 프로필 추가", "Add role profile")}
            disabled={readOnly}
            onClick={create}
          />
        </div>
        {missingPresets.length > 0 && (
          <Button
            size="sm"
            disabled={disabled}
            onClick={() =>
              onPatch(
                missingPresets.map((value) => ({ op: "profile.put", value })),
                text("기본 역할 프로필 추가", "Add default role profiles"),
              )
            }
          >
            {text("기본 역할 추가", "Add default roles")}
          </Button>
        )}
        {[...entries.values()].map((profile) => (
          <button
            className="planning-workspace__item"
            key={profile.id}
            aria-pressed={selectedId === profile.id}
            onClick={() => setSelectedId(profile.id)}
          >
            <strong>
              {profile.title || text("제목 없는 역할", "Untitled role")}
            </strong>
            <small>
              {roles[profile.role]} · r{profile.revision}
            </small>
            {drafts[profile.id]?.dirty && (
              <Badge>{text("미저장", "Unsaved")}</Badge>
            )}
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
                [{ op: "profile.put", value: selected }],
                text(
                  `역할 프로필 저장: ${selected.title}`,
                  `Save role profile: ${selected.title}`,
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
                "변경은 다음 실행부터 적용됩니다.",
                "Changes apply to future executions.",
              )}
            </span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={
                disabled ||
                !selected.title.trim() ||
                !drafts[selected.id]?.dirty
              }
              leadingIcon={<Glyph name="save" />}
            >
              {text("저장", "Save")}
            </Button>
          </div>
          <Field label={text("역할 이름", "Role name")} required>
            <Input
              value={selected.title}
              disabled={readOnly}
              maxLength={300}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <div className="planning-workspace__field-row">
            <Field label={text("담당 단계", "Stage")}>
              <Select
                value={selected.role}
                disabled={readOnly}
                onChange={(event) => {
                  const role = event.target
                    .value as PlanningRoleProfile["role"];
                  update({
                    role,
                    allowedTools:
                      role === "planning"
                        ? selected.allowedTools.filter(
                            (tool) =>
                              tool !== "project.write" &&
                              tool !== "terminal.execute",
                          )
                        : selected.allowedTools,
                  });
                }}
              >
                {Object.entries(roles).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={text("기본 프로필 상속", "Parent profile")}>
              <Select
                value={selected.parentProfileId ?? ""}
                disabled={readOnly}
                onChange={(event) =>
                  update({ parentProfileId: event.target.value || undefined })
                }
              >
                <option value="">{text("없음", "None")}</option>
                {snapshot.draft.profiles
                  .filter((profile) => profile.id !== selected.id)
                  .map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.title}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <label className="planning-workspace__text-field">
            {text("역할 프롬프트", "Role instructions")}
            <textarea
              rows={12}
              value={selected.instructions}
              disabled={readOnly}
              maxLength={200_000}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </label>
          <fieldset className="planning-workspace__checks" disabled={readOnly}>
            <legend>{text("허용 도구", "Allowed tools")}</legend>
            {Object.entries(tools).map(([tool, label]) => {
              const value = tool as PlanningRoleProfile["allowedTools"][number];
              return (
                <label key={tool}>
                  <input
                    type="checkbox"
                    disabled={
                      selected.role === "planning" &&
                      (tool === "project.write" || tool === "terminal.execute")
                    }
                    checked={selected.allowedTools.includes(value)}
                    onChange={() =>
                      update({
                        allowedTools: selected.allowedTools.includes(value)
                          ? selected.allowedTools.filter(
                              (entry) => entry !== value,
                            )
                          : [...selected.allowedTools, value],
                      })
                    }
                  />
                  {label}
                </label>
              );
            })}
          </fieldset>
          <Field
            label={text("실패 후 추가 수정 횟수", "Additional repair attempts")}
            description={text(
              "기본값은 2회입니다. 취소와 미확정 요청의 확인은 수정 횟수를 사용하지 않습니다.",
              "Defaults to 2. Cancellation and uncertain-delivery reconciliation do not consume repair attempts.",
            )}
          >
            <Input
              type="number"
              min={0}
              max={20}
              value={selected.retryLimit}
              disabled={readOnly}
              onChange={(event) =>
                update({
                  retryLimit: Math.max(
                    0,
                    Math.min(20, Number(event.target.value)),
                  ),
                })
              }
            />
          </Field>
          <fieldset className="planning-workspace__checks" disabled={readOnly}>
            <legend>
              {text(
                "역할에 제공할 기획 문맥",
                "Planning context for this role",
              )}
            </legend>
            {snapshot.draft.items.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={selected.contextRefs.some(
                    (ref) => ref.id === item.id,
                  )}
                  onChange={() =>
                    update({
                      contextRefs: selected.contextRefs.some(
                        (ref) => ref.id === item.id,
                      )
                        ? selected.contextRefs.filter(
                            (ref) => ref.id !== item.id,
                          )
                        : [
                            ...selected.contextRefs,
                            {
                              id: item.id,
                              kind: "item",
                              revision: item.revision,
                            },
                          ],
                    })
                  }
                />
                {item.title} · r{item.revision}
              </label>
            ))}
          </fieldset>
          <p className="planning-workspace__muted">
            {text(
              "모델과 연결은 실행 준비에서 직접 선택하고 지원 여부를 확인합니다. 사용할 수 없는 연결을 다른 제공자로 자동 변경하지 않습니다.",
              "Choose a provider and model during execution preparation and check its supported capabilities. Unavailable providers are never replaced automatically.",
            )}
          </p>
          {snapshot.profileProposals
            .filter((proposal) => proposal.profileId === selected.id)
            .map((proposal) => (
              <section className="planning-workspace__card" key={proposal.id}>
                <Badge
                  variant={
                    proposal.status === "pending" ? "warning" : "neutral"
                  }
                >
                  {proposal.status === "pending"
                    ? text("AI 변경 제안", "AI change proposal")
                    : proposal.status === "applied"
                      ? text("적용됨", "Applied")
                      : text("기준 변경됨", "Stale")}
                </Badge>
                <p>{proposal.reason}</p>
                <small>
                  r{proposal.baseVersion} → {proposal.proposed.title}
                </small>
                <ChatMarkdown markdown={proposal.proposed.instructions} />
                <p>
                  {proposal.proposed.allowedTools
                    .map((tool) => tools[tool])
                    .join(" · ")}
                </p>
                {proposal.status === "pending" && (
                  <Button
                    disabled={disabled || Boolean(drafts[selected.id]?.dirty)}
                    onClick={() => onApplyProposal(proposal.id)}
                  >
                    {text("제안 검토 후 적용", "Apply reviewed proposal")}
                  </Button>
                )}
              </section>
            ))}
        </form>
      ) : (
        <EmptyState
          title={text(
            "단계별 AI 역할을 정하세요",
            "Define AI roles for each stage",
          )}
          description={text(
            "기본 8개 역할의 프롬프트, 권한, 문맥과 수정 횟수를 검토하고 조정할 수 있습니다.",
            "Review and adjust prompts, permissions, context and repair limits for the eight default roles.",
          )}
          action={
            <Button disabled={readOnly} onClick={create}>
              {text("역할 프로필 추가", "Add role profile")}
            </Button>
          }
        />
      )}
    </div>
  );
}
