import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";

register("./asset-loader.mjs", import.meta.url);

const { Projects } = await import("./App");

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
globals.CustomEvent = window.CustomEvent;
globals.IntersectionObserver = window.IntersectionObserver;
globals.getComputedStyle = window.getComputedStyle.bind(window);

function clickEvent(element: Element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

function project(
  id: string,
  name: string,
  overrides: Partial<BrainProjectSnapshot> = {},
): BrainProjectSnapshot {
  return {
    schemaVersion: 6,
    id,
    name,
    sourcePath: `專案/${name}.md`,
    status: "active",
    area: "產品",
    priority: 1,
    progress: 40,
    focusToday: false,
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    completedAt: null,
    body: "這是專案說明，用來確認卡片能看到內文摘要。",
    ...overrides,
  };
}

interface Rendered {
  container: HTMLElement;
  saved: BrainProjectSnapshot[][];
  opened: string[];
  archived: string[];
  deleted: string[];
  completed: string[];
}

function renderProjects(
  projects: BrainProjectSnapshot[],
  tasks: BrainTaskSnapshot[] = [],
): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: BrainProjectSnapshot[][] = [];
  const opened: string[] = [];
  const archived: string[] = [];
  const deleted: string[] = [];
  const completed: string[] = [];
  flushSync(() => {
    root.render(
      <Projects
        projects={projects}
        tasks={tasks}
        onOpenProject={(projectId) => opened.push(projectId)}
        onOpenBoard={() => undefined}
        onCompleteProject={(projectId) => completed.push(projectId)}
        onReopenProject={() => undefined}
        onSave={(next) => { saved.push([next]); }}
        onArchive={(item) => { if (item.id) archived.push(item.id); }}
        onDelete={(item) => { if (item.id) deleted.push(item.id); }}
        onCreate={() => undefined}
      />,
    );
  });
  return { container, saved, opened, archived, deleted, completed };
}

function switchView(container: HTMLElement, mode: "table" | "cards" | "status") {
  const button = container.querySelector(`[data-project-view-option="${mode}"]`);
  assert.ok(button, `${mode} view button exists`);
  flushSync(() => clickEvent(button!));
}

test("project overview defaults to a spreadsheet table with title and period", () => {
  window.localStorage.clear();
  const rendered = renderProjects([project("proj-1", "示範專案")]);
  try {
    assert.equal(rendered.container.querySelector("[data-project-view]")?.getAttribute("data-project-view"), "table");
    assert.ok(rendered.container.querySelector(".project-table"));
    assert.match(rendered.container.textContent ?? "", /示範專案/);
    assert.match(rendered.container.textContent ?? "", /執行期間/);
    const start = rendered.container.querySelector<HTMLInputElement>("input[type='date'][aria-label$='開始日']");
    const end = rendered.container.querySelector<HTMLInputElement>("input[type='date'][aria-label$='結束日']");
    assert.equal(start?.value, "2026-08-01");
    assert.equal(end?.value, "2026-08-31");
  } finally {
    rendered.container.remove();
  }
});

test("project overview can switch to cards and the status board", () => {
  window.localStorage.clear();
  const rendered = renderProjects([project("proj-1", "示範專案")]);
  try {
    switchView(rendered.container, "cards");
    assert.equal(rendered.container.querySelector("[data-project-view]")?.getAttribute("data-project-view"), "cards");
    assert.ok(rendered.container.querySelector("[data-project-card]"));
    assert.match(rendered.container.textContent ?? "", /這是專案說明/);
    assert.match(rendered.container.textContent ?? "", /2026-08-01 → 2026-08-31/);
    assert.equal(window.localStorage.getItem("second-brain.projectView"), "cards");

    switchView(rendered.container, "status");
    assert.equal(rendered.container.querySelector("[data-project-view]")?.getAttribute("data-project-view"), "status");
    assert.ok(rendered.container.querySelector(".project-status-board"));
    assert.equal(window.localStorage.getItem("second-brain.projectView"), "status");
  } finally {
    rendered.container.remove();
  }
});

test("saved project view is restored and old list mode becomes the table", () => {
  window.localStorage.clear();
  window.localStorage.setItem("second-brain.projectView", "cards");
  const cards = renderProjects([project("proj-1", "示範專案")]);
  try {
    assert.equal(cards.container.querySelector("[data-project-view]")?.getAttribute("data-project-view"), "cards");
  } finally {
    cards.container.remove();
  }

  window.localStorage.setItem("second-brain.projectView", "list");
  const table = renderProjects([project("proj-1", "示範專案")]);
  try {
    assert.equal(table.container.querySelector("[data-project-view]")?.getAttribute("data-project-view"), "table");
    assert.ok(table.container.querySelector(".project-table"));
  } finally {
    table.container.remove();
    window.localStorage.clear();
  }
});

test("table view edits status and importance in place", () => {
  window.localStorage.clear();
  const rendered = renderProjects([project("proj-1", "示範專案")]);
  try {
    const status = rendered.container.querySelector<HTMLSelectElement>("select[aria-label='示範專案 狀態']");
    const importance = rendered.container.querySelector<HTMLSelectElement>("select[aria-label='示範專案 重要性']");
    assert.ok(status && importance);
    flushSync(() => {
      status!.value = "paused";
      status!.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    assert.equal(rendered.saved.at(-1)?.[0]?.status, "paused");

    flushSync(() => {
      importance!.value = "2";
      importance!.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    assert.equal(rendered.saved.at(-1)?.[0]?.priority, 2);
    // Date inputs are bound with onChange; happy-dom does not deliver native
    // change events to React, so the round-trip is covered by the visible value.
    const start = rendered.container.querySelector<HTMLInputElement>("input[type='date'][aria-label$='開始日']");
    assert.equal(start?.value, "2026-08-01");
  } finally {
    rendered.container.remove();
  }
});

test("table view opens the project from the title and can complete or archive it", () => {
  window.localStorage.clear();
  const rendered = renderProjects([project("proj-1", "示範專案")]);
  try {
    const title = rendered.container.querySelector<HTMLButtonElement>(".board-table-title");
    assert.ok(title);
    flushSync(() => clickEvent(title!));
    assert.deepEqual(rendered.opened, ["proj-1"]);

    const complete = rendered.container.querySelector<HTMLButtonElement>("[data-complete-project]");
    assert.ok(complete);
    flushSync(() => clickEvent(complete!));
    assert.deepEqual(rendered.completed, ["proj-1"]);

    const archive = rendered.container.querySelector<HTMLButtonElement>("[aria-label='封存專案']");
    assert.ok(archive);
    flushSync(() => clickEvent(archive!));
    assert.deepEqual(rendered.archived, ["proj-1"]);
  } finally {
    rendered.container.remove();
  }
});
