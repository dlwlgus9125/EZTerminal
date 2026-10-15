import { useState } from "react";
import type {
  PlanningItem,
  PlanningOperation,
  PlanningSnapshot,
} from "../shared/planning";
import { useAppTranslation } from "./i18n";
import { Badge, Button, EmptyState, Field, Input, Select } from "./ui";

export function planningStructureRows(
  snapshot: PlanningSnapshot,
): { id: string; depth: number; parentId?: string }[] {
  const pages = snapshot.draft.items.filter(
    (item) => item.kind === "information",
  );
  const ids = new Set(pages.map((item) => item.id));
  const edges = snapshot.draft.links.filter(
    (link) =>
      link.kind === "contains" && ids.has(link.fromId) && ids.has(link.toId),
  );
  const rows: { id: string; depth: number; parentId?: string }[] = [];
  const visited = new Set<string>();
  const visit = (id: string, depth: number, parentId?: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    rows.push({ id, depth, ...(parentId ? { parentId } : {}) });
    edges
      .filter((edge) => edge.fromId === id)
      .forEach((edge) => visit(edge.toId, depth + 1, id));
  };
  pages
    .filter((page) => !edges.some((edge) => edge.toId === page.id))
    .forEach((page) => visit(page.id, 0));
  pages.forEach((page) => visit(page.id, 0));
  return rows;
}

/** Both representations project the same persisted items and edges, without a second canvas document. */
export function PlanningStructureEditor({
  mode,
  snapshot,
  disabled,
  onPatch,
  onEditItem,
  onOpenDesign,
}: {
  mode: "information" | "flow";
  snapshot: PlanningSnapshot;
  disabled: boolean;
  onPatch: (operations: PlanningOperation[], summary: string) => void;
  onEditItem: (id: string) => void;
  onOpenDesign: () => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith("ko");
  const text = (korean: string, english: string) => (ko ? korean : english);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const nodes = snapshot.draft.items.filter((item) => item.kind === mode);
  const selected = nodes.find((item) => item.id === selectedId);
  const allNodes = [...nodes, ...snapshot.draft.scenes];
  const edges = snapshot.draft.links.filter(
    (link) =>
      link.kind === (mode === "information" ? "contains" : "navigates-to") &&
      (nodes.some((item) => item.id === link.fromId) ||
        nodes.some((item) => item.id === link.toId)),
  );
  const rows =
    mode === "information"
      ? planningStructureRows(snapshot)
      : nodes.map((node) => ({ id: node.id, depth: 0, parentId: undefined }));
  const selectedEdges = selected
    ? edges.filter(
        (edge) => edge.fromId === selected.id || edge.toId === selected.id,
      )
    : [];
  const missingDestinations =
    mode === "flow"
      ? nodes.filter(
          (node) =>
            node.flowStep?.kind !== "end" &&
            !edges.some((edge) => edge.fromId === node.id),
        )
      : [];
  const add = (kind: "action" | "condition" | "end" = "action"): void => {
    const value: PlanningItem = {
      id: `item-${crypto.randomUUID()}`,
      revision: 0,
      kind: mode,
      title:
        mode === "information"
          ? text("새 페이지", "New page")
          : kind === "end"
            ? text("종료 결과", "End result")
            : kind === "condition"
              ? text("조건 분기", "Condition")
              : text("새 행동", "New action"),
      body: "",
      acceptance: [],
      status: "draft",
      ...(mode === "flow" ? { flowStep: { kind } } : {}),
    };
    onPatch(
      [{ op: "item.put", value }],
      text(`추가: ${value.title}`, `Add: ${value.title}`),
    );
    setSelectedId(value.id);
  };
  const saveConnection = (): void => {
    if (!selected || !target) return;
    const operations: PlanningOperation[] = [];
    if (mode === "information") {
      for (const edge of edges.filter((edge) => edge.toId === target))
        operations.push({ op: "entity.delete", kind: "link", id: edge.id });
    }
    operations.push({
      op: "link.put",
      value: {
        id: `link-${crypto.randomUUID()}`,
        revision: 0,
        kind: mode === "information" ? "contains" : "navigates-to",
        fromId: selected.id,
        toId: target,
        note: note.trim(),
      },
    });
    onPatch(
      operations,
      text("구조·흐름 연결 변경", "Update structure or flow connection"),
    );
    setTarget("");
    setNote("");
  };
  return (
    <div className="planning-workspace__structure">
      <div className="planning-workspace__list-heading">
        <h2>
          {mode === "information"
            ? text("정보 구조", "Information architecture")
            : text("사용자 흐름", "User flow")}
        </h2>
        <div className="planning-workspace__actions">
          <Button
            size="sm"
            aria-pressed={view === "canvas"}
            onClick={() => setView("canvas")}
          >
            {text("구조 보기", "Diagram")}
          </Button>
          <Button
            size="sm"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            {text("단계 목록", "Step list")}
          </Button>
        </div>
      </div>
      <div className="planning-workspace__actions">
        <Button size="sm" disabled={disabled} onClick={() => add()}>
          {mode === "information"
            ? text("페이지 추가", "Add page")
            : text("행동 추가", "Add action")}
        </Button>
        {mode === "flow" && (
          <>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => add("condition")}
            >
              {text("조건 분기 추가", "Add condition")}
            </Button>
            <Button size="sm" disabled={disabled} onClick={() => add("end")}>
              {text("종료 결과 추가", "Add end result")}
            </Button>
            <Button size="sm" onClick={onOpenDesign}>
              {text("화면 설계로", "Open screen designs")}
            </Button>
          </>
        )}
      </div>
      {missingDestinations.length > 0 && (
        <p className="planning-workspace__message" role="status">
          {text(
            "다음 화면 또는 종료 결과를 연결하세요:",
            "Connect the next screen or end result:",
          )}{" "}
          {missingDestinations.map((item) => item.title).join(", ")}
        </p>
      )}
      {nodes.length === 0 ? (
        <EmptyState
          title={
            mode === "information"
              ? text("첫 페이지를 추가하세요", "Add your first page")
              : text(
                  "사용자의 첫 행동을 추가하세요",
                  "Add the first user action",
                )
          }
        />
      ) : (
        <>
          <ol
            className={
              view === "canvas"
                ? "planning-workspace__structure-canvas"
                : "planning-workspace__structure-list"
            }
          >
            {rows.map((row) => {
              const node = nodes.find((item) => item.id === row.id)!;
              const outgoing = edges.filter((edge) => edge.fromId === node.id);
              const parent = row.parentId
                ? nodes.find((item) => item.id === row.parentId)
                : undefined;
              return (
                <li
                  key={node.id}
                  style={
                    {
                      "--planning-depth": Math.min(row.depth, 6),
                    } as React.CSSProperties
                  }
                >
                  <button
                    className="planning-workspace__structure-node"
                    aria-pressed={selected?.id === node.id}
                    onClick={() => {
                      setSelectedId(node.id);
                      setTarget("");
                      setNote("");
                    }}
                  >
                    {parent && <small>{parent.title} →</small>}
                    <strong>{node.title}</strong>
                    <small>
                      {mode === "flow"
                        ? node.flowStep?.kind === "end"
                          ? text("종료", "End")
                          : node.flowStep?.kind === "condition"
                            ? text("조건 분기", "Condition")
                            : text("행동", "Action")
                        : text(
                            `하위 페이지 ${outgoing.length}개`,
                            `${outgoing.length} child pages`,
                          )}
                    </small>
                    <Badge
                      variant={
                        node.status === "ready"
                          ? "success"
                          : node.status === "review-needed"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {node.status}
                    </Badge>
                  </button>
                  {mode === "flow" && outgoing.length > 0 && (
                    <ul className="planning-workspace__flow-edges">
                      {outgoing.map((edge) => (
                        <li key={edge.id}>
                          <span>{edge.note || text("다음", "Next")}</span>
                          <span aria-hidden="true"> → </span>
                          <strong>
                            {allNodes.find((entry) => entry.id === edge.toId)
                              ?.title ?? edge.toId}
                          </strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          {selected && (
            <section className="planning-workspace__structure-properties">
              <div className="planning-workspace__list-heading">
                <h3>{selected.title}</h3>
                <Button size="sm" onClick={() => onEditItem(selected.id)}>
                  {text("내용과 완료 기준 편집", "Edit content and criteria")}
                </Button>
              </div>
              {selected.body && (
                <p className="planning-workspace__proposal">{selected.body}</p>
              )}
              {mode === "flow" && (
                <Field label={text("단계 종류", "Step kind")}>
                  <Select
                    value={selected.flowStep?.kind ?? "action"}
                    disabled={disabled}
                    onChange={(event) =>
                      onPatch(
                        [
                          {
                            op: "item.put",
                            value: {
                              ...selected,
                              flowStep: {
                                kind: event.target.value as
                                  "action" | "condition" | "end",
                              },
                            },
                          },
                        ],
                        text("흐름 단계 종류 변경", "Change flow step kind"),
                      )
                    }
                  >
                    <option value="action">{text("행동", "Action")}</option>
                    <option value="condition">
                      {text("조건 분기", "Condition")}
                    </option>
                    <option value="end">
                      {text("종료 결과", "End result")}
                    </option>
                  </Select>
                </Field>
              )}
              <ul className="planning-workspace__history">
                {selectedEdges.map((edge) => (
                  <li key={edge.id}>
                    <span>
                      {allNodes.find((entry) => entry.id === edge.fromId)
                        ?.title ?? edge.fromId}{" "}
                      →{" "}
                      {allNodes.find((entry) => entry.id === edge.toId)
                        ?.title ?? edge.toId}
                      <small>{edge.note}</small>
                    </span>
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        onPatch(
                          [{ op: "entity.delete", kind: "link", id: edge.id }],
                          text("연결 해제", "Remove connection"),
                        )
                      }
                    >
                      {text("연결 해제", "Disconnect")}
                    </Button>
                  </li>
                ))}
              </ul>
              {(mode !== "flow" || selected.flowStep?.kind !== "end") && (
                <div className="planning-workspace__connection-form">
                  <Field
                    label={
                      mode === "information"
                        ? text("하위 페이지", "Child page")
                        : text("다음 화면 또는 결과", "Next screen or result")
                    }
                  >
                    <Select
                      value={target}
                      disabled={disabled}
                      onChange={(event) => setTarget(event.target.value)}
                    >
                      <option value="">
                        {text("대상 선택", "Choose target")}
                      </option>
                      {(mode === "information" ? nodes : allNodes)
                        .filter((entry) => entry.id !== selected.id)
                        .map((entry) => (
                          <option value={entry.id} key={entry.id}>
                            {entry.title}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label={text("조건·설명", "Condition or note")}>
                    <Input
                      value={note}
                      disabled={disabled}
                      maxLength={4000}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={text(
                        "예: 성공 / 실패 / 취소",
                        "For example: success / failure / cancel",
                      )}
                    />
                  </Field>
                  <Button
                    size="sm"
                    disabled={disabled || !target}
                    onClick={saveConnection}
                  >
                    {text("연결", "Connect")}
                  </Button>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
