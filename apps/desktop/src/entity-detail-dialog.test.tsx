import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";
import { ProjectDetailDialog, TaskDetailDialog } from "./entity-detail-dialog";

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globals.HTMLElement = window.HTMLElement;
globals.Node = window.Node;
globals.Event = window.Event;
globals.MouseEvent = window.MouseEvent;
globals.KeyboardEvent = window.KeyboardEvent;
globals.PointerEvent = window.PointerEvent;

const task: BrainTaskSnapshot = {
  schemaVersion: 6,
  id: "detail-task",
  title: "完整任務",
  status: "todo",
  taskDate: "2026-08-22",
  startTime: null,
  durationMinutes: null,
  timeZone: null,
  priority: "high",
  projectId: null,
  projectName: null,
  rank: "00000001",
  sourcePath: "tasks.md",
  sourceHeading: null,
  completedAt: null,
  body: "- [ ] 核對內容\n\n## 說明",
};

function detailTask(overrides: Partial<BrainTaskSnapshot> = {}): BrainTaskSnapshot {
  return { ...task, ...overrides };
}

function projectDetail(overrides: Partial<BrainProjectSnapshot> = {}): BrainProjectSnapshot {
  return {
    schemaVersion: 6,
    id: "project-detail",
    name: "專案詳情",
    sourcePath: "projects/project-detail.md",
    status: "active",
    area: "工作",
    priority: 2,
    progress: 25,
    focusToday: false,
    startDate: null,
    endDate: null,
    completedAt: null,
    body: "",
    ...overrides,
  };
}

test("task detail is a single live Markdown canvas and saves checked todos", () => {
  const saved: BrainTaskSnapshot[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <TaskDetailDialog
        task={task}
        projects={[]}
        locale="zh-TW"
        t={(key) => key}
        onClose={() => undefined}
        onSave={(next) => { saved.push(next); return true; }}
        onDelete={() => undefined}
      />,
    ));
    assert.ok(container.querySelector(".markdown-block-editor"), "live block canvas is visible immediately");
    assert.equal(container.querySelector(".markdown-editor"), null, "legacy write/preview editor is absent");
    assert.equal(container.querySelector('[role="tablist"]'), null, "there is no write/preview mode switch");
    const checkbox = container.querySelector<HTMLInputElement>('.markdown-task-block input[type="checkbox"]');
    assert.ok(checkbox);
    flushSync(() => checkbox!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("app.save"));
    assert.ok(save);
    flushSync(() => save!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(saved.at(-1)?.body, "- [x] 核對內容\n\n## 說明");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("project detail opens an empty live canvas and keeps the board action separate", () => {
  const project = projectDetail();
  let openedBoard = false;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <ProjectDetailDialog
        project={project}
        openTasks={2}
        doingTasks={1}
        existingAreas={["工作"]}
        projectTasks={[]}
        locale="zh-TW"
        t={(key) => key}
        onClose={() => undefined}
        onSave={() => true}
        onOpenBoard={() => { openedBoard = true; }}
        onComplete={() => undefined}
        onReopen={() => undefined}
        onArchive={() => undefined}
        onDelete={() => undefined}
        onAddProjectTask={() => undefined}
        onToggleProjectTask={() => undefined}
        onOpenProjectTask={() => undefined}
        onDeleteProjectTask={() => undefined}
      />,
    ));
    assert.ok(container.querySelector(".markdown-block-editor"));
    assert.equal(container.querySelectorAll(".markdown-block").length, 1, "an empty project starts with one editable block");
    const preview = container.querySelector<HTMLElement>(".markdown-block-preview");
    assert.ok(preview, "empty project has a live markdown canvas");
    flushSync(() => preview!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.ok(container.querySelector(".markdown-block-input"));
    const openBoard = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("project.action.open"));
    assert.ok(openBoard);
    flushSync(() => openBoard!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(openedBoard, true);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("clicking outside auto-saves dirty task edits instead of discarding them", async () => {
  const saved: BrainTaskSnapshot[] = [];
  let closed = false;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <TaskDetailDialog
        task={task}
        projects={[]}
        locale="zh-TW"
        t={(key) => key}
        onClose={() => { closed = true; }}
        onSave={(next) => { saved.push(next); return true; }}
        onDelete={() => undefined}
      />,
    ));
    // Make the draft dirty through the title-row checkbox (typing is not
    // reproducible for controlled inputs in this DOM shim).
    const toggle = container.querySelector<HTMLButtonElement>(".task-complete")!;
    assert.ok(toggle, "a completion toggle exists in the form");
    flushSync(() => toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    await act(async () => {
      const backdrop = container.querySelector<HTMLElement>(".detail-backdrop")!;
      // bubbles:true is required for the event to reach React's root-delegated
      // listener; the handler's target===currentTarget check still passes.
      backdrop.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(saved.at(-1)?.status, "done", "the outside click saved the flipped status");
    assert.equal(closed, true, "the dialog closes after a successful autosave");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("the task detail delete button asks in a dialog before deleting", () => {
  let deleted = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <TaskDetailDialog
        task={detailTask()}
        projects={[]}
        locale="zh-TW"
        t={(key) => key}
        onClose={() => undefined}
        onSave={() => true}
        onDelete={() => { deleted += 1; }}
      />,
    ));
    const danger = container.querySelector<HTMLButtonElement>(".danger-confirm")!;
    assert.ok(danger, "a delete control is rendered");
    flushSync(() => danger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(deleted, 0, "opening the dialog does not delete");
    const accept = document.querySelector<HTMLButtonElement>(".delete-confirm-accept");
    assert.ok(accept, "the dialog asks for an explicit confirm");
    flushSync(() => accept!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(deleted, 1, "confirming the dialog deletes");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("panel detail is non-modal when wide and becomes modal when the viewport narrows", async () => {
  const originalWidth = window.innerWidth;
  let closed = false;
  Object.defineProperty(window, "innerWidth", { value: 1200, writable: true, configurable: true });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <TaskDetailDialog
        task={detailTask()}
        projects={[]}
        locale="zh-TW"
        surface="panel"
        t={(key) => key}
        onClose={() => { closed = true; }}
        onSave={() => true}
        onDelete={() => undefined}
      />,
    ));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog.classList.contains("detail-dialog-panel"));
    assert.equal(dialog.getAttribute("aria-modal"), null, "wide side panel leaves the surrounding view available");

    await act(async () => {
      document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(closed, true, "clicking the main workspace closes the docked panel after autosave");

    await act(async () => {
      Object.defineProperty(window, "innerWidth", { value: 700, writable: true, configurable: true });
      window.dispatchEvent(new window.Event("resize"));
    });
    assert.equal(dialog.getAttribute("aria-modal"), "true", "narrow fallback restores modal semantics");
  } finally {
    root.unmount();
    container.remove();
    Object.defineProperty(window, "innerWidth", { value: originalWidth, writable: true, configurable: true });
  }
});

test("project detail lists its tasks and the composer adds one bound to the project", async () => {
  const project = projectDetail();
  const added: string[] = [];
  const toggled: BrainTaskSnapshot[] = [];
  const childTask = detailTask({ id: "child-1", title: "設計導覽列", projectId: "project-detail", projectName: "專案詳情", rank: "00000002" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <ProjectDetailDialog
        project={project}
        openTasks={1}
        doingTasks={0}
        existingAreas={[]}
        projectTasks={[childTask]}
        locale="zh-TW"
        t={(key) => key}
        onClose={() => undefined}
        onSave={() => true}
        onOpenBoard={() => undefined}
        onComplete={() => undefined}
        onReopen={() => undefined}
        onArchive={() => undefined}
        onDelete={() => undefined}
        onAddProjectTask={(title) => added.push(title)}
        onToggleProjectTask={(t) => toggled.push(t)}
        onOpenProjectTask={() => undefined}
        onDeleteProjectTask={() => undefined}
      />,
    ));
    const section = container.querySelector(".detail-task-section");
    assert.ok(section, "a dedicated project tasks section exists");
    assert.ok(section!.textContent?.includes("設計導覽列"), "the project's open tasks are listed");
    const composer = container.querySelector<HTMLInputElement>(".detail-task-composer input")!;
    const addButton = container.querySelector<HTMLButtonElement>(".detail-task-add");
    assert.ok(addButton, "the composer has an explicit create button, not only a picker of existing tasks");
    composer.value = "撰寫驗收清單";
    // Native form submit is the one event path that reliably reaches React here.
    flushSync(() => container.querySelector<HTMLFormElement>(".detail-task-composer")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    assert.deepEqual(added, ["撰寫驗收清單"], "submitting the composer adds the task through the project callback");
    assert.equal(composer.value, "", "the composer clears after committing");
    assert.equal(toggled.length, 0);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("task detail can save as knowledge from the current draft without completing the task", () => {
  const savedAs: BrainTaskSnapshot[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <TaskDetailDialog
        task={detailTask({ body: "會議結論" })}
        projects={[]}
        locale="zh-TW"
        t={(key) => key}
        onClose={() => undefined}
        onSave={() => true}
        onDelete={() => undefined}
        onSaveAsKnowledge={(task) => savedAs.push(task)}
      />,
    ));
    const saveAs = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("knowledge.action.save"));
    assert.ok(saveAs, "save as knowledge is available from task detail");
    flushSync(() => saveAs!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(savedAs.length, 1);
    assert.equal(savedAs[0]?.title, "完整任務");
    assert.equal(savedAs[0]?.status, "todo", "saving as knowledge does not complete the task");
    assert.equal(savedAs[0]?.body, "會議結論");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("project detail lists related knowledge and opens the selected note", () => {
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(
      <ProjectDetailDialog
        project={projectDetail()}
        openTasks={0}
        doingTasks={0}
        existingAreas={[]}
        projectTasks={[]}
        locale="zh-TW"
        t={(key) => key}
        onClose={() => undefined}
        onSave={() => true}
        onOpenBoard={() => undefined}
        onComplete={() => undefined}
        onReopen={() => undefined}
        onArchive={() => undefined}
        onDelete={() => undefined}
        onAddProjectTask={() => undefined}
        onToggleProjectTask={() => undefined}
        onOpenProjectTask={() => undefined}
        onDeleteProjectTask={() => undefined}
        relatedKnowledge={[{ id: "note-1", name: "會議紀錄", category: "方法" }]}
        onOpenKnowledge={(id) => opened.push(id)}
      />,
    ));
    const section = container.querySelector(".detail-knowledge-section");
    assert.ok(section, "related knowledge is listed on the project page");
    assert.ok(section!.textContent?.includes("會議紀錄"));
    const openNote = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("會議紀錄"));
    assert.ok(openNote);
    flushSync(() => openNote!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.deepEqual(opened, ["note-1"]);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("project detail adopts an externally completed project instead of keeping a stale draft", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    openTasks: 1,
    doingTasks: 0,
    existingAreas: [] as string[],
    projectTasks: [] as BrainTaskSnapshot[],
    locale: "zh-TW" as const,
    t: (key: string) => key,
    onClose: () => undefined,
    onSave: () => true,
    onOpenBoard: () => undefined,
    onComplete: () => undefined,
    onReopen: () => undefined,
    onArchive: () => undefined,
    onDelete: () => undefined,
    onAddProjectTask: () => undefined,
    onToggleProjectTask: () => undefined,
    onOpenProjectTask: () => undefined,
    onDeleteProjectTask: () => undefined,
  };
  try {
    flushSync(() => root.render(<ProjectDetailDialog project={projectDetail()} {...props} />));
    const status = container.querySelector<HTMLSelectElement>("select");
    assert.equal(status?.value, "active");
    assert.ok(container.querySelector("[data-complete-project]"), "complete stays reachable without scrolling past the canvas");
    flushSync(() => root.render(<ProjectDetailDialog project={projectDetail({ status: "done", progress: 100, completedAt: "2026-08-22" })} {...props} />));
    assert.equal(container.querySelector<HTMLSelectElement>("select")?.value, "done", "external completion replaces the stale active draft");
    assert.equal(container.querySelector("[data-complete-project]"), null);
    assert.ok([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("project.action.reopen")));
  } finally {
    root.unmount();
    container.remove();
  }
});
