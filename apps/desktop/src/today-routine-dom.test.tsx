import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createDefaultRoutineTemplate } from "@second-brain/brain-core";
import type { BrainProjectSnapshot, BrainTaskSnapshot, RoutineTemplate } from "@second-brain/brain-core";
import { taipeiDateKey } from "@second-brain/brain-ui";

register("./asset-loader.mjs", import.meta.url);

const { Today } = await import("./App");

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

function clickEvent(element: Element, type: string) {
  element.dispatchEvent(new window.MouseEvent(type, { bubbles: true }) as unknown as Event);
}

const projects: BrainProjectSnapshot[] = [];

interface Rendered {
  container: HTMLElement;
  saved: BrainTaskSnapshot[][];
}

function renderToday(
  tasks: BrainTaskSnapshot[],
  routineTemplate: RoutineTemplate,
  overrides: { onDelete?: (task: BrainTaskSnapshot) => void } = {},
): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: BrainTaskSnapshot[][] = [];
  flushSync(() => {
    root.render(
      <Today
        tasks={tasks}
        projects={projects}
        showCompleted={false}
        onShowCompletedChange={() => undefined}
        onSave={(next) => saved.push(next.map((item) => ({ ...item })))}
        onDelete={overrides.onDelete ?? (() => undefined)}
        onOpenTask={() => undefined}
        onQuickAdd={() => undefined}
        routineTemplate={routineTemplate}
        onRoutineTemplateChange={() => undefined}
      />,
    );
  });
  return { container, saved };
}

function startDay(rendered: Rendered) {
  const button = rendered.container.querySelector<HTMLElement>(".start-day-button");
  assert.ok(button, "the start-day button is rendered");
  flushSync(() => {
    clickEvent(button!, "click");
  });
}

test("starting the day from a template with several P1 rows saves exactly one P1", () => {
  const template = createDefaultRoutineTemplate("11111111-1111-4111-8111-111111111111");
  template.items[0]!.priority = "highest";
  template.items[2]!.priority = "highest";
  template.items[4]!.priority = "highest";
  const rendered = renderToday([], template);
  try {
    startDay(rendered);

    assert.equal(rendered.saved.length, 1, "onSave is called once");
    const tasks = rendered.saved[0]!;
    assert.deepEqual(tasks.filter((item) => item.priority === "highest").map((item) => item.title),
      [template.items[0]!.title], "only the first ranked P1 row stays P1");
    assert.equal(tasks.filter((item) => item.priority === "high").length, 2, "the other P1 rows land as P2");
  } finally {
    rendered.container.remove();
  }
});

test("starting the day leaves a task the user already starred as the only P1", () => {
  const template = createDefaultRoutineTemplate("22222222-2222-4222-8222-222222222222");
  template.items[0]!.priority = "highest";
  const starred: BrainTaskSnapshot = {
    schemaVersion: 6,
    id: "starred-task",
    title: "手動選定的最重要",
    status: "todo",
    // Today reads the day from the Taipei clock, so the fixture has to agree with it.
    taskDate: taipeiDateKey(new Date()),
    priority: "highest",
    projectId: null,
    projectName: null,
    rank: "00000000",
    sourcePath: "10-收件匣/待辦收件匣.md",
    sourceHeading: null,
    completedAt: null,
  };
  const rendered = renderToday([starred], template);
  try {
    startDay(rendered);

    const tasks = rendered.saved[0]!;
    assert.deepEqual(tasks.filter((item) => item.priority === "highest").map((item) => item.title),
      ["手動選定的最重要"], "the starred task keeps the crown, the template row yields");
  } finally {
    rendered.container.remove();
  }
});

test("today shows a 24-hour schedule and creates a task at the clicked hour", () => {
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    });
  }
  const rendered = renderToday([], createDefaultRoutineTemplate("33333333-3333-4333-8333-333333333333"));
  try {
    const slot = rendered.container.querySelector<HTMLElement>('[data-schedule-minutes="540"]');
    assert.ok(slot, "09:00 hour slot exists");
    assert.equal(rendered.container.querySelectorAll(".hour-slot").length, 24);
    flushSync(() => {
      clickEvent(slot!, "click");
    });
    const input = rendered.container.querySelector<HTMLInputElement>(".day-schedule-composer input");
    assert.ok(input, "inline composer opens on the clicked hour");
    input!.value = "寫週報";
    flushSync(() => {
      rendered.container.querySelector("form.day-schedule-composer")?.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
    assert.ok(rendered.saved.length >= 1, "creating from the hour slot saves a task");
    const created = rendered.saved.at(-1)!.find((item) => item.title === "寫週報");
    assert.equal(created?.startTime, "09:00");
    assert.equal(created?.taskDate, taipeiDateKey(new Date()));
  } finally {
    rendered.container.remove();
  }
});

test("dragging an unscheduled today task onto an hour slot sets the start time", () => {
  const today = taipeiDateKey(new Date());
  const open: BrainTaskSnapshot = {
    schemaVersion: 6,
    id: "open-today",
    title: "打電話給客戶",
    status: "todo",
    taskDate: today,
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: "00000001",
    sourcePath: "10-收件匣/待辦收件匣.md",
    sourceHeading: null,
    completedAt: null,
  };
  const rendered = renderToday([open], createDefaultRoutineTemplate("44444444-4444-4444-8444-444444444444"));
  try {
    const card = rendered.container.querySelector<HTMLElement>(".schedule-tray-card");
    const handle = rendered.container.querySelector<HTMLElement>(".schedule-tray-drag-handle");
    const slot = rendered.container.querySelector<HTMLElement>('[data-schedule-minutes="600"]');
    assert.ok(card, "unscheduled tray card exists");
    assert.ok(handle, "the card exposes an explicit drag handle");
    assert.ok(slot, "10:00 hour slot exists");
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    if (typeof proto.setPointerCapture !== "function") {
      Object.defineProperty(proto, "setPointerCapture", { value: () => undefined, configurable: true, writable: true });
    }
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => slot;
    try {
      handle!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 4, clientY: 4 }) as unknown as Event);
      handle!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 4, clientY: 4 }) as unknown as Event);
    } finally {
      doc.elementFromPoint = original;
    }
    assert.equal(rendered.saved.length, 1, "drop onto the hour grid saves once");
    const updated = rendered.saved[0]!.find((item) => item.id === "open-today");
    assert.equal(updated?.startTime, "10:00");
    assert.equal(updated?.taskDate, today);
  } finally {
    rendered.container.remove();
  }
});

test("the task title no longer starts a drag that can accidentally open details", () => {
  const today = taipeiDateKey(new Date());
  const open: BrainTaskSnapshot = {
    schemaVersion: 6,
    id: "title-drag-task",
    title: "抓住標題拖曳",
    status: "todo",
    taskDate: today,
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: "00000001",
    sourcePath: "10-收件匣/待辦收件匣.md",
    sourceHeading: null,
    completedAt: null,
  };
  const rendered = renderToday([open], createDefaultRoutineTemplate("55555555-5555-4555-8555-555555555555"));
  try {
    const title = rendered.container.querySelector<HTMLElement>(".schedule-tray-card .inline-title-button");
    const slot = rendered.container.querySelector<HTMLElement>('[data-schedule-minutes="600"]');
    assert.ok(title, "the task title is rendered inside the card");
    assert.ok(slot, "10:00 hour slot exists");
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    if (typeof proto.setPointerCapture !== "function") {
      Object.defineProperty(proto, "setPointerCapture", { value: () => undefined, configurable: true, writable: true });
    }
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => slot;
    try {
      flushSync(() => {
        title!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2, clientX: 8, clientY: 8 }) as unknown as Event);
        title!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 2, clientX: 160, clientY: 80 }) as unknown as Event);
        title!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 2, clientX: 160, clientY: 80 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.equal(rendered.saved.length, 0, "pointer movement on the title never schedules; only the six-dot handle drags");
  } finally {
    rendered.container.remove();
  }
});

test("deleting a today task arms in place and deletes on the second click", () => {
  const today = taipeiDateKey(new Date());
  const open: BrainTaskSnapshot = {
    schemaVersion: 6,
    id: "delete-me",
    title: "要刪掉的任務",
    status: "todo",
    taskDate: today,
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: "00000001",
    sourcePath: "10-收件匣/待辦收件匣.md",
    sourceHeading: null,
    completedAt: null,
  };
  const deleted: BrainTaskSnapshot[] = [];
  const rendered = renderToday(
    [open],
    createDefaultRoutineTemplate("66666666-6666-4666-8666-666666666666"),
    { onDelete: (task) => deleted.push(task) },
  );
  try {
    const danger = rendered.container.querySelector<HTMLButtonElement>(".schedule-tray-actions .danger-confirm");
    assert.ok(danger, "the tray card carries the armed two-step delete");
    flushSync(() => clickEvent(danger!, "click"));
    assert.equal(deleted.length, 0, "the first click only arms the button");
    assert.ok(danger!.className.includes("armed"), "the armed state is visible on the button itself");
    flushSync(() => clickEvent(danger!, "click"));
    assert.deepEqual(deleted.map((task) => task.id), ["delete-me"], "the second click deletes exactly once");
  } finally {
    rendered.container.remove();
  }
});

test("starring a today task promotes it through toggleMostImportant via onSave", () => {
  const today = taipeiDateKey(new Date());
  const open: BrainTaskSnapshot = {
    schemaVersion: 6,
    id: "star-me",
    title: "今天最重要的事",
    status: "todo",
    taskDate: today,
    startTime: null,
    durationMinutes: null,
    timeZone: null,
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: "00000001",
    sourcePath: "10-收件匣/待辦收件匣.md",
    sourceHeading: null,
    completedAt: null,
  };
  const rendered = renderToday([open], createDefaultRoutineTemplate("77777777-7777-4777-8777-777777777777"));
  try {
    const star = rendered.container.querySelector<HTMLButtonElement>(".schedule-tray-card .tray-star");
    assert.ok(star, "the tray card exposes the importance star");
    flushSync(() => clickEvent(star!, "click"));
    assert.equal(rendered.saved.length, 1, "starring saves once");
    const updated = rendered.saved[0]!.find((item) => item.id === "star-me");
    assert.equal(updated?.priority, "highest", "the starred task becomes today's most important");
  } finally {
    rendered.container.remove();
  }
});
