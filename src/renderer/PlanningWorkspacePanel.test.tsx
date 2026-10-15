// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlanningCommandSchema,
  type PlanningCommand,
  type PlanningSnapshot,
} from "../shared/planning";
import {
  PlanningWorkspacePanel,
  type PlanningWorkspaceAccess,
} from "./PlanningWorkspacePanel";
import type {
  PlanningDraftStorage,
  PlanningWorkspaceDraft,
} from "./planning-draft-state";

vi.mock("./i18n", () => ({
  useAppTranslation: () => ({ i18n: { language: "en" } }),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const empty = (): PlanningSnapshot => ({
  schemaVersion: 1,
  projectId: "project-1",
  revision: 0,
  draft: {
    id: "draft-1",
    items: [],
    links: [],
    scenes: [],
    components: [],
    profiles: [],
    tasks: [],
    assets: [],
  },
  baselines: [],
  history: [],
  profileProposals: [],
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(access: PlanningWorkspaceAccess): Promise<void> {
  await act(async () =>
    root.render(
      <PlanningWorkspacePanel
        projectId="project-1"
        projectName="Test project"
        access={access}
        initialSection="planning"
      />,
    ),
  );
}
function button(name: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) =>
      item.textContent === name || item.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
async function click(name: string): Promise<void> {
  await act(async () => button(name).click());
}
function field(label: string): HTMLInputElement {
  const node = [...container.querySelectorAll("label")].find(
    (item) => item.textContent?.replace("*", "").trim() === label,
  );
  const control = node?.htmlFor
    ? container.querySelector<HTMLInputElement>(`[id="${node.htmlFor}"]`)
    : node?.querySelector<HTMLInputElement>("textarea,input");
  if (!control) throw new Error(`Missing field: ${label}`);
  return control;
}
async function input(label: string, value: string): Promise<void> {
  const control = field(label);
  await act(async () => {
    const prototype =
      control.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(): Promise<void> {
  await act(async () =>
    container
      .querySelector("form.planning-workspace__editor")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

describe("PlanningWorkspacePanel authority and drafts", () => {
  it("sends a schema-valid item command and retains draft across sections", async () => {
    const snapshot = empty();
    const execute = vi.fn(async (command: PlanningCommand) => {
      PlanningCommandSchema.parse(command);
      if (
        command.type !== "planning.patch" ||
        command.payload.operations[0].op !== "item.put"
      )
        throw new Error("unexpected command");
      return {
        ok: true as const,
        commandId: command.commandId,
        revision: 1,
        changeId: "change-1",
        duplicate: false,
        snapshot: {
          ...snapshot,
          revision: 1,
          draft: {
            ...snapshot.draft,
            items: [{ ...command.payload.operations[0].value, revision: 1 }],
          },
        },
      };
    });
    await render({
      getPlanningSnapshot: async () => ({ ok: true, snapshot }),
      executePlanningCommand: execute,
    });
    await click("Add planning item");
    await input("Title", "Preserve terminals");
    await input("Content", "Keep the existing PTY alive.");
    await click("Conversations");
    await click("Planning");
    expect(field("Title").value).toBe("Preserve terminals");
    await submit();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toMatchObject({
      projectId: "project-1",
      expectedRevision: 0,
      payload: {
        operations: [
          {
            op: "item.put",
            value: {
              title: "Preserve terminals",
              body: "Keep the existing PTY alive.",
            },
          },
        ],
      },
    });
    expect(container.textContent).toContain("Saved · revision 1");
    expect(button("Save").disabled).toBe(true);
  });

  it("keeps an uncertain mutation immutable and reconciles using its exact command ID", async () => {
    const snapshot = empty();
    const execute = vi
      .fn<PlanningWorkspaceAccess["executePlanningCommand"]>()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({
        ok: false,
        error: "unavailable",
        message: "Host is offline",
      });
    await render({
      getPlanningSnapshot: async () => ({ ok: true, snapshot }),
      executePlanningCommand: execute,
    });
    await click("Add planning item");
    await input("Title", "Retained draft");
    await submit();
    expect(field("Title").value).toBe("Retained draft");
    expect(field("Title").disabled).toBe(true);
    await click("Check save result");
    expect(execute.mock.calls[1][0]).toEqual(execute.mock.calls[0][0]);
    expect(container.textContent).toContain("Host is offline");
  });

  it("refreshes a stale snapshot without losing edits and then uses the current authority revision", async () => {
    let snapshot = empty();
    const execute = vi
      .fn<PlanningWorkspaceAccess["executePlanningCommand"]>()
      .mockResolvedValue({
        ok: false,
        error: "stale",
        message: "Refresh required",
        revision: 3,
      });
    await render({
      getPlanningSnapshot: async () => ({ ok: true, snapshot }),
      executePlanningCommand: execute,
    });
    await click("Add planning item");
    await input("Title", "My unsaved requirement");
    await submit();
    snapshot = { ...snapshot, revision: 3 };
    await click("Refresh");
    expect(field("Title").value).toBe("My unsaved requirement");
    await submit();
    expect(execute.mock.calls[1][0].expectedRevision).toBe(3);
    expect(execute.mock.calls[1][0].commandId).not.toBe(
      execute.mock.calls[0][0].commandId,
    );
  });

  it("keeps separate item drafts and blocks baseline freeze while any item is unsaved", async () => {
    await render({
      getPlanningSnapshot: async () => ({ ok: true, snapshot: empty() }),
      executePlanningCommand: vi.fn(),
    });
    await click("Add planning item");
    await input("Title", "First requirement");
    await click("Add planning item");
    await input("Title", "Second requirement");
    await act(async () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".planning-workspace__item",
        ),
      ]
        .find((item) => item.textContent?.includes("First requirement"))!
        .click(),
    );
    expect(field("Title").value).toBe("First requirement");
    await click("Review");
    await input("Baseline name", "Release baseline");
    expect(button("Freeze reviewed baseline").disabled).toBe(true);
    expect(container.textContent).toContain("Save 2 unsaved items first.");
  });

  it("restores device drafts without replay and saves exact command identity before transport", async () => {
    let stored: PlanningWorkspaceDraft | null = null;
    const draftStorage: PlanningDraftStorage = {
      loadDraft: async () => stored,
      saveDraft: async (value) => {
        stored = structuredClone(value);
      },
    };
    const snapshot = empty();
    const execute = vi.fn<PlanningWorkspaceAccess["executePlanningCommand"]>(
      async (command) => {
        expect(stored?.uncertain).toEqual(command);
        throw new Error("Connection lost");
      },
    );
    const access: PlanningWorkspaceAccess = {
      getPlanningSnapshot: async () => ({ ok: true, snapshot }),
      executePlanningCommand: execute,
    };
    const mount = async () =>
      act(async () =>
        root.render(
          <PlanningWorkspacePanel
            projectId="project-1"
            projectName="Test"
            access={access}
            draftStorage={draftStorage}
            initialSection="planning"
          />,
        ),
      );
    await mount();
    await click("Add planning item");
    await input("Title", "Recover me");
    await submit();
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(field("Title").value).toBe("Recover me");
    expect(execute).toHaveBeenCalledOnce();
    expect(button("Check save result")).toBeTruthy();
    await click("Check save result");
    expect(execute.mock.calls[1][0]).toEqual(execute.mock.calls[0][0]);
  });

  it("blocks host mutation if device persistence fails", async () => {
    const execute = vi.fn();
    const access: PlanningWorkspaceAccess = {
      getPlanningSnapshot: async () => ({ ok: true, snapshot: empty() }),
      executePlanningCommand: execute,
    };
    const draftStorage: PlanningDraftStorage = {
      loadDraft: async () => null,
      saveDraft: async () => {
        throw new Error("Disk full");
      },
    };
    await act(async () =>
      root.render(
        <PlanningWorkspacePanel
          projectId="project-1"
          projectName="Test"
          access={access}
          draftStorage={draftStorage}
          initialSection="planning"
        />,
      ),
    );
    await click("Add planning item");
    await input("Title", "Do not lose me");
    await submit();
    expect(execute).not.toHaveBeenCalled();
    expect(field("Title").value).toBe("Do not lose me");
    expect(container.textContent).toContain("Disk full");
  });

  it("records task acceptance and validation IDs without executing any task", async () => {
    const snapshot = empty();
    const execute = vi.fn<PlanningWorkspaceAccess["executePlanningCommand"]>(
      async (command) => {
        PlanningCommandSchema.parse(command);
        return { ok: false, error: "stale", message: "Keep the editable task" };
      },
    );
    await render({
      getPlanningSnapshot: async () => ({ ok: true, snapshot }),
      executePlanningCommand: execute,
    });
    await click("Tasks");
    await click("Add task definition");
    await input("Task title", "Preserve PTY state");
    await input(
      "Objective and scope",
      "Tab navigation must keep the process alive.",
    );
    await input(
      "Allowed paths · project-relative, one per line",
      "src/renderer\n",
    );
    await click("Add criterion");
    await input("Criterion 1", "The existing session ID is unchanged");
    await click("Add validation");
    await input(
      "Validation description",
      "Switch tabs and verify the session ID",
    );
    await input("Environment", "Windows 11");
    await act(async () => {
      const label = [...container.querySelectorAll("label")].find(
        (node) => node.textContent === "The existing session ID is unchanged",
      );
      label!.querySelector<HTMLInputElement>("input")!.click();
    });
    await act(async () =>
      container
        .querySelector('[role="tabpanel"]:not([hidden]) form')!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    const command = execute.mock.calls[0][0];
    if (
      command.type !== "planning.patch" ||
      command.payload.operations[0].op !== "task.put"
    )
      throw new Error("Expected a task definition patch");
    const task = command.payload.operations[0].value;
    expect(task.allowedPaths).toEqual(["src/renderer"]);
    expect(task.validationPlan[0].acceptanceIds).toEqual([
      task.acceptance[0].id,
    ]);
    expect(task.status).toBe("draft");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("adds the eight role presets only on explicit action", async () => {
    const execute = vi
      .fn<PlanningWorkspaceAccess["executePlanningCommand"]>()
      .mockResolvedValue({
        ok: false,
        error: "stale",
        message: "Refresh required",
      });
    await render({
      getPlanningSnapshot: async () => ({ ok: true, snapshot: empty() }),
      executePlanningCommand: execute,
    });
    await click("Tasks");
    await click("Role profiles");
    expect(execute).not.toHaveBeenCalled();
    await click("Add default roles");
    const command = PlanningCommandSchema.parse(execute.mock.calls[0][0]);
    if (command.type !== "planning.patch") throw new Error("Expected a patch");
    expect(command.payload.operations).toHaveLength(8);
    expect(
      command.payload.operations.every(
        (operation) =>
          operation.op === "profile.put" && operation.value.revision === 0,
      ),
    ).toBe(true);
  });
});
