import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
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
  const project: BrainProjectSnapshot = {
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
  };
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
        locale="zh-TW"
        t={(key) => key}
        onClose={() => undefined}
        onSave={() => true}
        onOpenBoard={() => { openedBoard = true; }}
        onComplete={() => undefined}
        onReopen={() => undefined}
        onArchive={() => undefined}
        onDelete={() => undefined}
      />,
    ));
    assert.ok(container.querySelector(".markdown-block-editor"));
    assert.equal(container.querySelectorAll(".markdown-block").length, 0);
    const openBoard = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("project.action.open"));
    assert.ok(openBoard);
    flushSync(() => openBoard!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(openedBoard, true);
  } finally {
    root.unmount();
    container.remove();
  }
});
