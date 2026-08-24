import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { PX_PER_HOUR } from "./day-schedule";
import { DaySchedule } from "./day-schedule-view";

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globals.HTMLElement = window.HTMLElement;
globals.Node = window.Node;
globals.Event = window.Event;
globals.KeyboardEvent = window.KeyboardEvent;
globals.MouseEvent = window.MouseEvent;
globals.PointerEvent = window.PointerEvent;

function task(id: string, title: string, startTime: string): BrainTaskSnapshot {
  return {
    schemaVersion: 6,
    id,
    title,
    status: "todo",
    taskDate: "2026-08-21",
    startTime,
    durationMinutes: 30,
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: id,
    sourcePath: "tasks.md",
    sourceHeading: null,
    completedAt: null,
  };
}

const labels = {
  unscheduled: "未排程",
  dropToSchedule: "拖來排程",
  addAtTime: (time: string) => `新增 ${time}`,
  empty: "空",
  editTitle: "雙擊編輯",
  editPriority: "調整優先度",
  complete: "完成",
  reopen: "重開",
  delete: "刪除",
  resize: "調整時長",
};

function stubPointer() {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture !== "function") {
    Object.defineProperty(proto, "setPointerCapture", { value: () => undefined, configurable: true, writable: true });
  }
}

test("clicking a timeline task opens the shared detail without inline editing", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const opened: string[] = [];
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("a", "原稿", "09:00")]}
          showTray={false}
          labels={labels}
          onSchedule={() => undefined}
          onCreateAt={() => undefined}
          onOpenTask={(taskId) => opened.push(taskId)}
        />,
      );
    });
    const timedBlock = container.querySelector(".timed-block");
    assert.ok(timedBlock, "timeline task exists");
    flushSync(() => {
      timedBlock!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(opened, ["a"]);
    assert.equal(container.querySelector("textarea, input"), null);
  } finally {
    container.remove();
  }
});

test("dragging the resize handle changes duration without moving the start time", () => {
  stubPointer();
  const resized: Array<[string, number]> = [];
  const scheduled: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("a", "原稿", "09:00")]}
          showTray={false}
          labels={labels}
          onSchedule={() => scheduled.push("moved")}
          onCreateAt={() => undefined}
          onResize={(id, duration) => resized.push([id, duration])}
        />,
      );
    });
    const handle = container.querySelector<HTMLElement>("[data-resize-handle]");
    assert.ok(handle, "resize handle exists");
    flushSync(() => {
      handle!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientY: 10 }) as unknown as Event);
      handle!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 1, clientY: 10 + PX_PER_HOUR / 4 }) as unknown as Event);
      handle!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientY: 10 + PX_PER_HOUR / 4 }) as unknown as Event);
    });
    assert.equal(scheduled.length, 0, "resize does not reschedule start time");
    assert.equal(resized[0]?.[0], "a");
    assert.equal(resized[0]?.[1], 45);
  } finally {
    container.remove();
  }
});

test("dragging an existing timed task changes its start time", () => {
  stubPointer();
  const scheduled: Array<[string, string]> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("task-1", "會議", "09:00")]}
          showTray={false}
          labels={labels}
          onSchedule={(id, time) => scheduled.push([id, time])}
          onCreateAt={() => undefined}
        />,
      );
    });
    const block = container.querySelector<HTMLElement>(".timed-block");
    const grid = container.querySelector<HTMLElement>("[data-day-schedule-grid]");
    assert.ok(block, "timed block exists");
    assert.ok(grid, "grid exists");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => grid;
    try {
      const startY = (9 - 7) * PX_PER_HOUR + 10;
      flushSync(() => {
        block!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: startY }) as unknown as Event);
        block!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: startY + PX_PER_HOUR * 2 }) as unknown as Event);
        block!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: startY + PX_PER_HOUR * 2 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.equal(scheduled.length, 1, "timed task scheduled to new time");
    assert.equal(scheduled[0]?.[0], "task-1");
    assert.equal(scheduled[0]?.[1], "11:00");
  } finally {
    container.remove();
  }
});

test("dragging a timed task to the unscheduled tray clears its time", () => {
  stubPointer();
  const cleared: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("task-1", "會議", "09:00")]}
          showTray={true}
          labels={labels}
          onSchedule={() => undefined}
          onClearTime={(id) => cleared.push(id)}
          onCreateAt={() => undefined}
        />,
      );
    });
    const block = container.querySelector<HTMLElement>(".timed-block");
    const tray = container.querySelector<HTMLElement>("[data-unscheduled-tray]");
    assert.ok(block, "timed block exists");
    assert.ok(tray, "unscheduled tray exists");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => tray;
    try {
      flushSync(() => {
        block!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 300, clientY: 10 }) as unknown as Event);
        block!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 1, clientX: 50, clientY: 10 }) as unknown as Event);
        block!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 50, clientY: 10 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.equal(cleared.length, 1, "task cleared to tray");
    assert.equal(cleared[0], "task-1");
  } finally {
    container.remove();
  }
});
