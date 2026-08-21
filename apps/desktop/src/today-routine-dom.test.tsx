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

function renderToday(tasks: BrainTaskSnapshot[], routineTemplate: RoutineTemplate): Rendered {
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
        onSave={(next) => saved.push(next.map((item) => ({ ...item })))}
        onDelete={() => undefined}
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
