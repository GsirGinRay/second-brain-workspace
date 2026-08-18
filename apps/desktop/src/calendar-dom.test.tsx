import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";

register("./asset-loader.mjs", import.meta.url);

const { Calendar } = await import("./App");

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

function task(id: string, title: string, taskDate: string | null): BrainTaskSnapshot {
  return {
    schemaVersion: 6,
    id,
    title,
    status: "todo",
    taskDate,
    priority: "normal",
    projectId: null,
    projectName: null,
    rank: id,
    sourcePath: "10-收件匣/待辦收件匣.md",
    sourceHeading: null,
    completedAt: null,
  };
}

const projects: BrainProjectSnapshot[] = [];

interface Rendered {
  container: HTMLElement;
  saved: BrainTaskSnapshot[][];
}

function renderCalendar(tasks: BrainTaskSnapshot[]): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: BrainTaskSnapshot[][] = [];
  const onSave = (next: BrainTaskSnapshot[]) => {
    saved.push(next.map((item) => ({ ...item })));
  };
  flushSync(() => {
    root.render(
      <Calendar
        tasks={tasks}
        projects={projects}
        showCompleted={false}
        onSave={onSave}
        onDelete={() => undefined}
        onPromote={() => undefined}
      />,
    );
  });
  return { container, saved };
}

function dayCell(container: HTMLElement, date: string): HTMLElement | null {
  return container.querySelector(`[data-calendar-date="${date}"]`);
}

function stubPointerDragSupport() {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture !== "function") {
    Object.defineProperty(proto, "setPointerCapture", { value: () => undefined, configurable: true, writable: true });
  }
}

function pointerDragTo(source: Element, target: HTMLElement) {
  stubPointerDragSupport();
  const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
  const original = doc.elementFromPoint;
  doc.elementFromPoint = () => target;
  try {
    source.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 4, clientY: 4 }) as unknown as Event);
    source.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 4, clientY: 4 }) as unknown as Event);
  } finally {
    doc.elementFromPoint = original;
  }
}

test("agenda shows the selected day's tasks with a date input bound to the task date", () => {
  const t = task("task-1", "買牛奶", "2026-08-15");
  const rendered = renderCalendar([t]);
  try {
    const cell = dayCell(rendered.container, "2026-08-15");
    assert.ok(cell, "day cell 2026-08-15 exists");
    flushSync(() => {
      clickEvent(cell!, "click");
    });
    const input = rendered.container.querySelector<HTMLInputElement>("input[placeholder='YYYY-MM-DD']");
    assert.ok(input, "agenda date input exists");
    assert.equal(input!.value, "2026-08-15", "input reflects the task's planned date");
    // Note: happy-dom does not deliver native input/change events to React's
    // synthetic onChange, so the save round-trip is covered by the drag tests
    // (same onSave pipeline) and the brain-core patch tests.
  } finally {
    rendered.container.remove();
  }
});

test("dragging a month task chip to another day schedules the new date", () => {
  const t = task("task-1", "買牛奶", "2026-08-15");
  const rendered = renderCalendar([t]);
  try {
    const source = rendered.container.querySelector<HTMLElement>(".calendar-task-title");
    assert.ok(source, "task chip exists");
    const target = dayCell(rendered.container, "2026-08-16");
    assert.ok(target, "target day cell exists");
    pointerDragTo(source!, target!);

    assert.equal(rendered.saved.length, 1, "onSave called once after pointer drop");
    const updated = rendered.saved[0]!.find((item) => item.id === "task-1");
    assert.equal(updated?.taskDate, "2026-08-16", "dropped task date is the new day");
  } finally {
    rendered.container.remove();
  }
});

test("dragging a task to the idea drawer unschedules it (taskDate null)", () => {
  const t = task("task-1", "買牛奶", "2026-08-15");
  const rendered = renderCalendar([t]);
  try {
    const source = rendered.container.querySelector<HTMLElement>(".calendar-task-title");
    assert.ok(source, "task chip exists");
    const drawer = rendered.container.querySelector<HTMLElement>("[data-idea-drawer]");
    assert.ok(drawer, "idea drawer exists");
    pointerDragTo(source!, drawer!);

    assert.equal(rendered.saved.length, 1, "onSave called once after drop to idea");
    const updated = rendered.saved[0]!.find((item) => item.id === "task-1");
    assert.equal(updated?.taskDate, null, "task moved to idea has no date");
  } finally {
    rendered.container.remove();
  }
});