import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";
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
    cards.forEach((card) => card.classList.add("global-shift-selected"));
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
  assert.ok(danger, "an armed two-step delete replaces window.confirm");
  click(danger);
  assert.equal(deleted.length, 0, "first click only arms");
  assert.ok(danger.className.includes("armed"));
  click(danger);
  assert.deepEqual(deleted, ["t1"], "second click deletes");
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
  assert.ok(actions.querySelector('button:not(.danger-confirm)'), "complete stays an inline icon button");
  const danger = actions.querySelector<HTMLButtonElement>(".danger-confirm")!;
  click(danger);
  assert.equal(deleted.length, 0, "delete waits for the confirming second click");
  click(danger);
  assert.equal(deleted.at(-1)?.id, "a");
  assert.equal(completed.length, 0, "arming never completes the task");
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
