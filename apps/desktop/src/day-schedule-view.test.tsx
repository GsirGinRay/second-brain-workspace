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

test("double-clicking a timeline title opens the in-place editor", () => {
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
          onSchedule={() => undefined}
          onCreateAt={() => undefined}
          onRename={() => undefined}
        />,
      );
    });
    const title = container.querySelector(".timed-block-title, .inline-title-button, button[aria-label='雙擊編輯']");
    assert.ok(title, "timeline title control exists");
    flushSync(() => {
      title!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
    });
    assert.ok(container.querySelector("textarea, input"), "title editor opens");
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
