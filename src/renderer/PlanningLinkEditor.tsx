import { useState } from "react";
import { Glyph, glyphIcon } from './ui/Glyph';
import type {
  PlanningLink,
  PlanningOperation,
  PlanningSnapshot,
} from "../shared/planning";
import { Button, Field, IconButton, Input, Select } from "./ui";
import { useAppTranslation } from "./i18n";

export function PlanningLinkEditor({
  snapshot,
  sourceId,
  disabled,
  onPatch,
}: {
  readonly snapshot: PlanningSnapshot;
  readonly sourceId: string;
  readonly disabled: boolean;
  readonly onPatch: (operations: PlanningOperation[], summary: string) => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const [targetId, setTargetId] = useState("");
  const [kind, setKind] = useState<PlanningLink["kind"]>("references");
  const [note, setNote] = useState("");
  const entries = [
    ...snapshot.draft.items,
    ...snapshot.draft.scenes,
    ...snapshot.draft.tasks,
  ];
  const links = snapshot.draft.links.filter(
    (link) => link.fromId === sourceId || link.toId === sourceId,
  );
  const kinds: Record<PlanningLink["kind"], string> = {
    contains: ko ? "하위 페이지" : "Contains",
    "depends-on": ko ? "선행 항목" : "Depends on",
    implements: ko ? "구현 대상" : "Implements",
    describes: ko ? "상세 설명" : "Describes",
    "navigates-to": ko ? "이동 화면" : "Navigates to",
    references: ko ? "참조" : "References",
  };
  const saved = entries.some((entry) => entry.id === sourceId);
  return (
    <section className="planning-workspace__connections">
      <h3>{ko ? "연결과 참조" : "Connections and references"}</h3>
      {links.map((link) => (
        <div className="planning-workspace__connection" key={link.id}>
          <span>
            <small>
              {kinds[link.kind]} ·{" "}
              {link.fromId === sourceId
                ? ko
                  ? "연결한 항목"
                  : "Outgoing"
                : ko
                  ? "참조한 항목"
                  : "Incoming"}
            </small>
            <strong>
              {entries.find(
                (entry) =>
                  entry.id ===
                  (link.fromId === sourceId ? link.toId : link.fromId),
              )?.title ?? (link.fromId === sourceId ? link.toId : link.fromId)}
            </strong>
            {link.note && <p>{link.note}</p>}
          </span>
          <IconButton
            icon={glyphIcon('trash')}
            disabled={disabled}
            aria-label={ko ? "연결 삭제" : "Delete connection"}
            onClick={() =>
              onPatch(
                [{ op: "entity.delete", kind: "link", id: link.id }],
                ko ? "기획 연결 삭제" : "Remove planning connection",
              )
            }
          />
        </div>
      ))}
      {!links.length && (
        <p className="planning-workspace__muted">
          {ko
            ? "다른 기획, 화면, 작업을 연결해 변경 영향을 추적합니다."
            : "Connect plans, screens and tasks to track change impact."}
        </p>
      )}
      {saved ? (
        <div className="planning-workspace__connection-form">
          <Field label={ko ? "연결 관계" : "Relationship"}>
            <Select
              value={kind}
              disabled={disabled}
              onChange={(event) =>
                setKind(event.target.value as PlanningLink["kind"])
              }
            >
              {Object.entries(kinds).map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ko ? "대상 항목" : "Target item"}>
            <Select
              value={targetId}
              disabled={disabled}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">
                {ko ? "연결할 항목 선택" : "Select an item"}
              </option>
              {entries
                .filter((entry) => entry.id !== sourceId)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
            </Select>
          </Field>
          <Button
            disabled={disabled || !targetId}
            leadingIcon={<Glyph name="link" />}
            onClick={() =>
              onPatch(
                [
                  {
                    op: "link.put",
                    value: {
                      id: `link-${crypto.randomUUID()}`,
                      revision: 0,
                      fromId: sourceId,
                      toId: targetId,
                      kind,
                      note: note.trim(),
                    },
                  },
                ],
                ko ? "기획 항목 연결" : "Connect planning items",
              )
            }
          >
            {ko ? "연결" : "Connect"}
          </Button>
          <Field
            label={
              ko ? "조건 또는 연결 설명" : "Condition or relationship note"
            }
          >
            <Input
              value={note}
              disabled={disabled}
              maxLength={4000}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                ko
                  ? "예: 저장 성공 후 / 취소한 경우"
                  : "For example: after saving / on cancel"
              }
            />
          </Field>
        </div>
      ) : (
        <p className="planning-workspace__muted">
          {ko
            ? "항목을 저장하면 연결을 추가할 수 있습니다."
            : "Save this item before adding connections."}
        </p>
      )}
    </section>
  );
}
