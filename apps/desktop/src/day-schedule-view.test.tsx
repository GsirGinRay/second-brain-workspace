import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";
import { PX_PER_HOUR } from "./day-schedule";
import { DaySchedule } from "./day-schedule-view";
import { addToSelection, getSelectedIdsOfKind } from "./global-shift-marquee";

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

test("dragging a marquee-selected group by its grip reorders the whole batch inside the tray", () => {
  stubPointer();
  const drops: Array<{ draggedId: string; targetId: string; place: string; draggedIds?: string[] }> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[]}
          trayTasks={[task("a", "第一件事", ""), task("b", "第二件事", ""), task("c", "第三件事", "")]}
          showTray
          labels={labels}
          onSchedule={() => undefined}
          onCreateAt={() => undefined}
          onReorderTray={(drop) => drops.push(drop)}
        />,
      );
    });
    const cards = container.querySelectorAll<HTMLElement>("[data-tray-card-id]");
    const handles = container.querySelectorAll<HTMLElement>(".schedule-tray-drag-handle");
    assert.equal(cards.length, 3, "three tray cards render");
    // A box-selection marked a and b (mirrored through the app-wide module).
    addToSelection("a", "task");
    addToSelection("b", "task");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => cards[2] ?? null;
    try {
      flushSync(() => {
        handles[0]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 91, clientX: 30, clientY: 20 }) as unknown as Event);
        handles[0]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 91, clientX: 30, clientY: 60 }) as unknown as Event);
        handles[0]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 91, clientX: 30, clientY: 60 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.deepEqual(drops[0], { draggedId: "a", targetId: "c", place: "after", draggedIds: ["a", "b"] }, "the whole selection travels with the grip");
  } finally {
    container.remove();
  }
});

test("dragging a marquee-selected timeline group into the tray unschedules every selected task", () => {
  stubPointer();
  const cleared: string[] = [];
  const clearedBatches: string[][] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("a", "已排", "09:00"), task("b", "也排了", "10:00")]}
          showTray
          labels={labels}
          onSchedule={() => undefined}
          onClearTime={(id) => cleared.push(id)}
          onClearTimeBatch={(ids) => clearedBatches.push(ids)}
          onCreateAt={() => undefined}
        />,
      );
    });
    const blocks = container.querySelectorAll<HTMLElement>(".timed-block");
    const tray = container.querySelector<HTMLElement>("[data-unscheduled-tray]");
    assert.equal(blocks.length, 2, "two timed blocks render");
    assert.ok(tray, "unscheduled tray exists");
    addToSelection("a", "task");
    addToSelection("b", "task");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => tray;
    try {
      flushSync(() => {
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 92, clientX: 300, clientY: 10 }) as unknown as Event);
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 92, clientX: 50, clientY: 10 }) as unknown as Event);
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 92, clientX: 50, clientY: 10 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.deepEqual(clearedBatches, [["a", "b"]], "the whole selection is unscheduled in one transaction");
    assert.deepEqual(cleared, [], "no single-task clear fires alongside the batch");
  } finally {
    container.remove();
  }
});

test("dropping a marquee-selected group on the all-day row clears the whole batch", () => {
  stubPointer();
  const cleared: string[] = [];
  const clearedBatches: string[][] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[]}
          allDayTasks={[task("a", "整日一", ""), task("b", "整日二", "")]}
          showTray={false}
          labels={labels}
          onSchedule={() => undefined}
          onClearTime={(id) => cleared.push(id)}
          onClearTimeBatch={(ids) => clearedBatches.push(ids)}
          onCreateAt={() => undefined}
        />,
      );
    });
    const chips = container.querySelectorAll<HTMLElement>(".all-day-chip");
    const allDayRow = container.querySelector<HTMLElement>("[data-schedule-all-day]");
    assert.equal(chips.length, 2, "two all-day chips render");
    assert.ok(allDayRow, "all-day row exists");
    addToSelection("a", "task");
    addToSelection("b", "task");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => allDayRow;
    try {
      flushSync(() => {
        chips[0]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 93, clientX: 20, clientY: 20 }) as unknown as Event);
        chips[0]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 93, clientX: 40, clientY: 30 }) as unknown as Event);
        chips[0]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 93, clientX: 40, clientY: 30 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.deepEqual(clearedBatches, [["a", "b"]], "the whole selection is cleared in one transaction");
    assert.deepEqual(cleared, [], "no single-task clear fires alongside the batch");
  } finally {
    container.remove();
  }
});

test("releasing a tray card onto a sibling reorders the tray instead of clearing", () => {
  stubPointer();
  const drops: Array<{ draggedId: string; targetId: string; place: string }> = [];
  const cleared: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[]}
          trayTasks={[task("a", "第一件事", "09:00"), task("b", "第二件事", "10:00")]}
          showTray
          labels={labels}
          onSchedule={() => undefined}
          onClearTime={(id) => cleared.push(id)}
          onCreateAt={() => undefined}
          onReorderTray={(drop) => drops.push(drop)}
        />,
      );
    });
    const cards = container.querySelectorAll<HTMLElement>("[data-tray-card-id]");
    const handles = container.querySelectorAll<HTMLElement>(".schedule-tray-drag-handle");
    assert.equal(cards.length, 2, "two tray cards render");
    assert.equal(handles.length, 2, "each tray card has an explicit drag handle");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => cards[1] ?? null;
    try {
      flushSync(() => {
        handles[0]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 3, clientX: 30, clientY: 20 }) as unknown as Event);
        handles[0]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 3, clientX: 30, clientY: 60 }) as unknown as Event);
        handles[0]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 3, clientX: 30, clientY: 60 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.equal(cleared.length, 0, "staying inside the tray never clears the time");
    assert.deepEqual(drops[0], { draggedId: "a", targetId: "b", place: "after" });
  } finally {
    container.remove();
  }
});

test("tasks selected by a marquee that starts outside the unscheduled tray still drag as one batch", () => {
  stubPointer();
  const batches: Array<[string[], string]> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[]}
          trayTasks={[task("a", "第一件事", ""), task("b", "第二件事", "")]}
          showTray
          labels={labels}
          onSchedule={() => undefined}
          onScheduleBatch={(ids, time) => batches.push([ids, time])}
          onCreateAt={() => undefined}
        />,
      );
    });
    const cards = container.querySelectorAll<HTMLElement>("[data-tray-card-id]");
    const handles = container.querySelectorAll<HTMLElement>(".schedule-tray-drag-handle");
    const slot = container.querySelector<HTMLElement>("[data-schedule-minutes='540']");
    assert.equal(cards[0]?.dataset.globalSelectId, "a", "tray cards participate in the app-wide marquee");
    assert.equal(cards[1]?.dataset.globalSelectId, "b");
    cards.forEach((card) => {
      const id = card.dataset.globalSelectId;
      const kind = card.dataset.globalSelectKind ?? "task";
      if (id) addToSelection(id, kind);
      card.classList.add("global-shift-selected");
    });
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => slot;
    try {
      flushSync(() => {
        handles[0]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 8, clientX: 30, clientY: 20 }) as unknown as Event);
        handles[0]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 8, clientX: 300, clientY: 200 }) as unknown as Event);
        handles[0]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 8, clientX: 300, clientY: 200 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.deepEqual(batches, [[ ["a", "b"], "09:00" ]]);
  } finally {
    container.remove();
  }
});

test("Delete key removes every marquee-selected task in one call", () => {
  stubPointer();
  const batchDeletes: string[][] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[]}
          trayTasks={[task("a", "第一件事", ""), task("b", "第二件事", "")]}
          showTray
          labels={labels}
          onSchedule={() => undefined}
          onCreateAt={() => undefined}
          onDeleteBatch={(tasks) => batchDeletes.push(tasks.map((item) => item.id!))}
        />,
      );
    });
    const cards = container.querySelectorAll<HTMLElement>("[data-tray-card-id]");
    assert.equal(cards.length, 2, "two tray cards render");
    const cardRects = [
      { left: 10, top: 40, right: 200, bottom: 80, width: 190, height: 40, x: 10, y: 40, toJSON: () => ({}) },
      { left: 10, top: 90, right: 200, bottom: 130, width: 190, height: 40, x: 10, y: 90, toJSON: () => ({}) },
    ];
    cards.forEach((card, index) => {
      card.getBoundingClientRect = () => cardRects[index] as DOMRect;
    });
    const scheduleRoot = container.querySelector<HTMLElement>(".day-schedule")!;
    flushSync(() => {
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true, pointerId: 61, clientX: 12, clientY: 44 }) as unknown as Event);
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, shiftKey: true, pointerId: 61, clientX: 190, clientY: 120 }) as unknown as Event);
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 61, clientX: 190, clientY: 120 }) as unknown as Event);
    });
    assert.equal(container.querySelectorAll(".schedule-tray-card.selected").length, 2, "the marquee selects both cards");
    assert.deepEqual(getSelectedIdsOfKind("task").sort(), ["a", "b"], "the internal selection is mirrored to the app-wide module");

    flushSync(() => {
      scheduleRoot.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Delete" }) as unknown as Event);
    });
    assert.deepEqual(batchDeletes, [["a", "b"]], "Delete removes every selected task in one call");
    assert.equal(container.querySelectorAll(".schedule-tray-card.selected").length, 0, "the selection clears after the delete");
    assert.deepEqual(getSelectedIdsOfKind("task"), [], "the module mirror clears with the selection");
  } finally {
    container.remove();
  }
});

test("dragging a marquee-selected timed task reschedules the whole selection", () => {
  stubPointer();
  const batches: Array<[string[], string]> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("a", "第一件事", "09:00"), task("b", "第二件事", "10:00")]}
          showTray={false}
          labels={labels}
          onSchedule={() => undefined}
          onScheduleBatch={(ids, time) => batches.push([ids, time])}
          onCreateAt={() => undefined}
        />,
      );
    });
    const blocks = container.querySelectorAll<HTMLElement>(".timed-block");
    assert.equal(blocks.length, 2, "two timed blocks render");
    const rects = [
      { left: 60, top: 504, right: 300, bottom: 546, width: 240, height: 42, x: 60, y: 504, toJSON: () => ({}) },
      { left: 60, top: 588, right: 300, bottom: 630, width: 240, height: 42, x: 60, y: 588, toJSON: () => ({}) },
    ];
    blocks.forEach((block, index) => {
      block.getBoundingClientRect = () => rects[index] as DOMRect;
    });
    const scheduleRoot = container.querySelector<HTMLElement>(".day-schedule")!;
    // Shift-drag a box over both blocks.
    flushSync(() => {
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true, pointerId: 71, clientX: 70, clientY: 510 }) as unknown as Event);
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, shiftKey: true, pointerId: 71, clientX: 290, clientY: 620 }) as unknown as Event);
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 71, clientX: 290, clientY: 620 }) as unknown as Event);
    });
    assert.equal(container.querySelectorAll(".timed-block.selected").length, 2, "the marquee selects both blocks");

    // Grab block "a" (no Shift) and drop it on the 10:00 position. The grid
    // auto-scrolls to hour 7 on mount, so clientY = canvasY - 7*PX_PER_HOUR.
    const slot = container.querySelector<HTMLElement>("[data-schedule-minutes='600']");
    assert.ok(slot, "the 10:00 slot exists");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => slot;
    try {
      flushSync(() => {
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 72, clientX: 100, clientY: 504 - PX_PER_HOUR * 7 }) as unknown as Event);
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 72, clientX: 100, clientY: 560 - PX_PER_HOUR * 7 }) as unknown as Event);
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 72, clientX: 100, clientY: 560 - PX_PER_HOUR * 7 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.deepEqual(batches, [[["a", "b"], "10:00"]], "dropping one selected task moves the whole selection");
  } finally {
    container.remove();
  }
});

test("a plain drag on the canvas box-selects tasks without Shift; a plain click stays a click", () => {
  stubPointer();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("a", "第一件事", "09:00"), task("b", "第二件事", "10:00")]}
          showTray={false}
          labels={labels}
          onSchedule={() => undefined}
          onCreateAt={() => undefined}
        />,
      );
    });
    const blocks = container.querySelectorAll<HTMLElement>(".timed-block");
    const rects = [
      { left: 60, top: 504, right: 300, bottom: 546, width: 240, height: 42, x: 60, y: 504, toJSON: () => ({}) },
      { left: 60, top: 588, right: 300, bottom: 630, width: 240, height: 42, x: 60, y: 588, toJSON: () => ({}) },
    ];
    blocks.forEach((block, index) => {
      block.getBoundingClientRect = () => rects[index] as DOMRect;
    });
    const scheduleRoot = container.querySelector<HTMLElement>(".day-schedule")!;

    // A press-and-release without movement is an ordinary click.
    flushSync(() => {
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 81, clientX: 20, clientY: 20 }) as unknown as Event);
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 81, clientX: 20, clientY: 20 }) as unknown as Event);
    });
    assert.equal(container.querySelectorAll(".timed-block.selected").length, 0, "a plain click selects nothing");
    assert.equal(container.querySelector(".day-schedule.marquee-selecting"), null, "no marquee rectangle without movement");

    // Dragging from empty canvas box-selects the intersecting tasks.
    flushSync(() => {
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 82, clientX: 20, clientY: 20 }) as unknown as Event);
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 82, clientX: 290, clientY: 620 }) as unknown as Event);
      scheduleRoot.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 82, clientX: 290, clientY: 620 }) as unknown as Event);
    });
    assert.equal(container.querySelectorAll(".timed-block.selected").length, 2, "a plain drag box-selects both tasks");
  } finally {
    container.remove();
  }
});

test("Alt+ArrowUp/Down reorders tray cards from the keyboard", () => {
  const drops: Array<{ draggedId: string; targetId: string; place: string }> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[]}
          trayTasks={[task("a", "第一件事", "09:00"), task("b", "第二件事", "10:00")]}
          showTray
          labels={labels}
          onSchedule={() => undefined}
          onCreateAt={() => undefined}
          onReorderTray={(drop) => drops.push(drop)}
        />,
      );
    });
    const cards = container.querySelectorAll<HTMLElement>("[data-tray-card-id]");
    flushSync(() => {
      cards[1]!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp", altKey: true }) as unknown as Event);
    });
    assert.deepEqual(drops[0], { draggedId: "b", targetId: "a", place: "before" });
    flushSync(() => {
      cards[0]!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", altKey: true }) as unknown as Event);
    });
    assert.deepEqual(drops[1], { draggedId: "a", targetId: "b", place: "after" });
  } finally {
    container.remove();
  }
});

test("dragging a marquee-selected timed task slides the whole selection together", () => {
  stubPointer();
  const batches: Array<[string[], string]> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <DaySchedule
          date="2026-08-21"
          timedTasks={[task("a", "第一件事", "09:00"), task("b", "第二件事", "10:00")]}
          showTray={false}
          labels={labels}
          onSchedule={() => undefined}
          onScheduleBatch={(ids, time) => batches.push([ids, time])}
          onCreateAt={() => undefined}
        />,
      );
    });
    const blocks = container.querySelectorAll<HTMLElement>(".timed-block");
    assert.equal(blocks.length, 2);
    addToSelection("a", "task");
    addToSelection("b", "task");
    const scheduleRoot = container.querySelector<HTMLElement>(".day-schedule")!;
    const grid = container.querySelector<HTMLElement>("[data-day-schedule-grid]")!;
    assert.ok(grid, "grid exists");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => grid;
    try {
      // Grab "a" (the block body — not a six-dot handle) and drag one hour down.
      // The grid auto-scrolls to hour 7 on mount, so clientY = canvasY - 7*56.
      flushSync(() => {
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 95, clientX: 100, clientY: 504 - PX_PER_HOUR * 7 }) as unknown as Event);
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 95, clientX: 100, clientY: 560 - PX_PER_HOUR * 7 }) as unknown as Event);
      });
      assert.equal(blocks[0]!.style.top, "560px", "the grabbed block follows the pointer");
      assert.equal(blocks[1]!.style.top, "616px", "the other selected block slides by the same delta");
      assert.equal(blocks[1]!.classList.contains("dragging"), true, "the whole batch shows dragging feedback");
      assert.match(blocks[1]!.querySelector("small")?.textContent ?? "", /^11:00/, "each block's time label ticks along");
      flushSync(() => {
        blocks[0]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 95, clientX: 100, clientY: 560 - PX_PER_HOUR * 7 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.deepEqual(batches, [[["a", "b"], "10:00"]], "the drop still persists the whole batch");
  } finally {
    container.remove();
  }
});

const fullLabels = {
  ...labels,
  important: "今日最重要",
  deleteAgain: "再按一次確認",
};

const projects: BrainProjectSnapshot[] = [
  {
    schemaVersion: 6,
    id: "p1",
    name: "官網改版",
    sourcePath: null,
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

function renderTray(extra: Partial<React.ComponentProps<typeof DaySchedule>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <DaySchedule
        date="2026-08-21"
        timedTasks={[task("t1", "排程會議", "09:00")]}
        trayTasks={[task("a", "待夾任務", "14:00")]}
        showTray
        labels={fullLabels}
        locale="zh-TW"
        projects={projects}
        onSchedule={() => undefined}
        onCreateAt={() => undefined}
        {...extra}
      />,
    );
  });
  return { container, root };
}

function click(element: Element) {
  flushSync(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
}

test("tray cards expose an importance star that reports the task id", () => {
  const starred: string[] = [];
  const { container } = renderTray({ onStar: (taskId) => starred.push(taskId) });
  const star = container.querySelector<HTMLButtonElement>(".schedule-tray-card .tray-star");
  assert.ok(star, "the tray card carries a star control");
  assert.equal(star!.className.includes("active"), false, "normal priority starts unstarred");
  click(star!);
  assert.deepEqual(starred, ["a"]);
});

test("the timed block keeps star, complete and armed delete inline in its head", () => {
  const starred: string[] = [];
  const deleted: string[] = [];
  const { container } = renderTray({
    onStar: (taskId) => starred.push(taskId),
    onDelete: (t: BrainTaskSnapshot) => deleted.push(t.id ?? ""),
  });
  const head = container.querySelector<HTMLElement>(".timed-block-head");
  assert.ok(head, "timed blocks use a single head row");
  const actions = head!.querySelector<HTMLElement>(".timed-block-inline-actions");
  assert.ok(actions, "actions sit inside the head instead of floating absolutely");
  click(actions!.querySelector<HTMLButtonElement>(".tray-star")!);
  assert.deepEqual(starred, ["t1"]);
  const danger = actions!.querySelector<HTMLButtonElement>(".danger-confirm")!;
  assert.ok(danger, "delete opens a confirmation dialog");
  click(danger);
  assert.equal(deleted.length, 0, "opening the dialog does not delete");
  const accept = document.querySelector<HTMLButtonElement>(".delete-confirm-accept");
  assert.ok(accept, "the dialog asks for an explicit confirm");
  click(accept!);
  assert.deepEqual(deleted, ["t1"], "confirming the dialog deletes");
});

test("tray meta shows the start time beside complete and armed delete", () => {
  const completed: string[] = [];
  const deleted: Array<BrainTaskSnapshot | undefined> = [];
  const { container } = renderTray({
    onComplete: (t) => completed.push(t.id ?? ""),
    onDelete: (t) => deleted.push(t),
  });
  const card = container.querySelector<HTMLElement>("[data-tray-card-id]")!;
  const when = card.querySelector<HTMLElement>(".tray-when");
  assert.ok(when, "start time renders inside the meta row");
  assert.equal(when!.textContent, "14:00");
  const actions = card.querySelector<HTMLElement>(".schedule-tray-actions")!;
  assert.ok(card.querySelector(".task-complete"), "complete is a square checkbox on the title row");
  const danger = actions.querySelector<HTMLButtonElement>(".danger-confirm")!;
  click(danger);
  assert.equal(deleted.length, 0, "delete waits for the confirmation dialog");
  click(document.querySelector<HTMLButtonElement>(".delete-confirm-accept")!);
  assert.equal(deleted.at(-1)?.id, "a");
  assert.equal(completed.length, 0, "opening delete never completes the task");
});

test("the tray project picker switches a task between projects in place", () => {
  const picks: Array<[string, string | null]> = [];
  const { container } = renderTray({ onPickProject: (taskId, projectId) => picks.push([taskId, projectId]) });
  const chip = container.querySelector<HTMLButtonElement>(".schedule-tray-project .project-picker-chip");
  assert.ok(chip, "each tray card embeds a compact project picker");
  assert.ok(chip!.textContent?.includes("無專案"), "unassigned tasks read 無專案");
  click(chip!);
  const options = [...container.querySelectorAll<HTMLButtonElement>(".project-picker-menu .project-picker-option")];
  assert.ok(options.some((option) => option.textContent?.includes("官網改版")), "the menu lists real projects");
  const target = options.find((option) => option.textContent?.includes("官網改版"))!;
  click(target);
  assert.deepEqual(picks, [["a", "p1"]]);
});
