import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";

register("./asset-loader.mjs", import.meta.url);

const { Board } = await import("./App");

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globals.localStorage = window.localStorage;
globals.HTMLElement = window.HTMLElement;
globals.Node = window.Node;
globals.Event = window.Event;
globals.KeyboardEvent = window.KeyboardEvent;
globals.MouseEvent = window.MouseEvent;
globals.PointerEvent = window.PointerEvent;
globals.DragEvent = window.DragEvent;
globals.CustomEvent = window.CustomEvent;
globals.IntersectionObserver = window.IntersectionObserver;
globals.getComputedStyle = window.getComputedStyle.bind(window);

function clickEvent(element: Element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

function task(
  id: string,
  title: string,
  overrides: Partial<BrainTaskSnapshot> = {},
): BrainTaskSnapshot {
  return {
    schemaVersion: 6,
    id,
    title,
    status: "todo",
    taskDate: "2026-08-12",
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: id,
    sourcePath: "收件匣/待辦.md",
    sourceHeading: null,
    completedAt: null,
    ...overrides,
  };
}

const projects: BrainProjectSnapshot[] = [
  {
    schemaVersion: 6,
    id: "proj-1",
    name: "示範專案",
    sourcePath: "專案/示範專案.md",
    status: "active",
    area: null,
    priority: null,
    progress: 0,
    focusToday: false,
    startDate: null,
    endDate: null,
    completedAt: null,
  },
];

interface Rendered {
  container: HTMLElement;
  saved: BrainTaskSnapshot[][];
  opened: string[];
}

function renderBoard(
  tasks: BrainTaskSnapshot[],
  options: {
    showCompleted?: boolean;
    selectedProjectId?: string | null;
    projects?: BrainProjectSnapshot[];
    onCompleteProject?: () => void;
    onReopenProject?: () => void;
  } = {},
): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: BrainTaskSnapshot[][] = [];
  const opened: string[] = [];
  flushSync(() => {
    root.render(
      <Board
        tasks={tasks}
        projects={options.projects ?? projects}
        showCompleted={options.showCompleted ?? false}
        onShowCompletedChange={() => undefined}
        onSave={(next) => { saved.push(next.map((item) => ({ ...item }))); }}
        onDelete={() => undefined}
        onOpenTask={(taskId) => opened.push(taskId)}
        selectedProjectId={options.selectedProjectId ?? null}
        onProjectFilterChange={() => undefined}
        onBackToProjects={() => undefined}
        onQuickAdd={() => undefined}
        onCompleteProject={options.onCompleteProject}
        onReopenProject={options.onReopenProject}
      />,
    );
  });
  return { container, saved, opened };
}

function switchView(container: HTMLElement, mode: "board" | "table" | "list") {
  const button = container.querySelector(`[data-board-view-option="${mode}"]`);
  assert.ok(button, `${mode} view button exists`);
  flushSync(() => clickEvent(button!));
}

test("board defaults to the kanban view and can switch to table and list", () => {
  window.localStorage.clear();
  const rendered = renderBoard([
    task("a", "寫規格"),
    task("b", "等回覆", { status: "waiting" }),
  ]);
  try {
    assert.equal(rendered.container.querySelector("[data-board-view]")?.getAttribute("data-board-view"), "board");
    assert.ok(rendered.container.querySelector(".board.five-lanes"));
    assert.equal(rendered.container.querySelectorAll("[data-board-lane]").length, 4);

    switchView(rendered.container, "table");
    assert.equal(rendered.container.querySelector("[data-board-view]")?.getAttribute("data-board-view"), "table");
    assert.ok(rendered.container.querySelector(".board-table"));
    assert.equal(rendered.container.querySelector(".board.five-lanes"), null);
    assert.match(rendered.container.textContent ?? "", /寫規格/);
    assert.equal(window.localStorage.getItem("second-brain.boardView"), "table");

    switchView(rendered.container, "list");
    assert.equal(rendered.container.querySelector("[data-board-view]")?.getAttribute("data-board-view"), "list");
    assert.ok(rendered.container.querySelector(".board-list"));
    assert.ok(rendered.container.querySelector(".board-list-row"));
    assert.equal(window.localStorage.getItem("second-brain.boardView"), "list");
  } finally {
    rendered.container.remove();
  }
});

test("saved board view is restored on the next mount", () => {
  window.localStorage.clear();
  window.localStorage.setItem("second-brain.boardView", "table");
  const rendered = renderBoard([task("a", "寫規格")]);
  try {
    assert.equal(rendered.container.querySelector("[data-board-view]")?.getAttribute("data-board-view"), "table");
    assert.ok(rendered.container.querySelector(".board-table"));
  } finally {
    rendered.container.remove();
    window.localStorage.clear();
  }
});

test("table view edits status in place and opens the task from the title", () => {
  window.localStorage.clear();
  const rendered = renderBoard([task("task-1", "寫規格")]);
  try {
    switchView(rendered.container, "table");
    const statusSelect = rendered.container.querySelector<HTMLSelectElement>(".board-table tbody tr select");
    assert.ok(statusSelect);
    assert.equal(statusSelect!.value, "todo");
    flushSync(() => {
      statusSelect!.value = "doing";
      statusSelect!.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    assert.equal(rendered.saved.at(-1)?.find((item) => item.id === "task-1")?.status, "doing");

    const title = rendered.container.querySelector<HTMLButtonElement>(".board-table-title");
    assert.ok(title);
    flushSync(() => clickEvent(title!));
    assert.deepEqual(rendered.opened, ["task-1"]);
  } finally {
    rendered.container.remove();
  }
});

test("a filtered project board offers a complete-project control without opening detail", () => {
  window.localStorage.clear();
  let completed = 0;
  const rendered = renderBoard([task("a", "寫規格", { projectId: "proj-1", projectName: "示範專案" })], {
    selectedProjectId: "proj-1",
    onCompleteProject: () => { completed += 1; },
  });
  try {
    const complete = rendered.container.querySelector<HTMLButtonElement>("[data-complete-project]");
    assert.ok(complete, "complete project is available on the board toolbar");
    flushSync(() => clickEvent(complete!));
    assert.equal(completed, 1);
  } finally {
    rendered.container.remove();
  }
});

test("the unfiltered board does not show complete project", () => {
  window.localStorage.clear();
  const rendered = renderBoard([task("a", "寫規格")]);
  try {
    assert.equal(rendered.container.querySelector("[data-complete-project]"), null);
  } finally {
    rendered.container.remove();
  }
});

test("a filtered archived project board offers reactivate instead of complete", () => {
  window.localStorage.clear();
  let reopened = 0;
  const archived = [{ ...projects[0]!, status: "archived" as const }];
  const rendered = renderBoard([task("a", "寫規格", { projectId: "proj-1", projectName: "示範專案" })], {
    selectedProjectId: "proj-1",
    projects: archived,
    onCompleteProject: () => undefined,
    onReopenProject: () => { reopened += 1; },
  });
  try {
    assert.equal(rendered.container.querySelector("[data-complete-project]"), null);
    const reopen = rendered.container.querySelector<HTMLButtonElement>("[data-reopen-project]");
    assert.ok(reopen, "archived projects can be reactivated from the board");
    flushSync(() => clickEvent(reopen!));
    assert.equal(reopened, 1);
  } finally {
    rendered.container.remove();
  }
});
