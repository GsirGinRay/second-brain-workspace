import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { translate } from "./ui-preferences";

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

const { FocusMode, WaitingPanel, WrapUpDialog } = await import("./today-tools");
const { RecurrenceSelect } = await import("./recurrence-picker");

const t = (key: string, values?: Record<string, string | number>) => translate("zh-TW", key, values);
const TODAY = "2026-10-20";

const task = (id: string, patch: Partial<BrainTaskSnapshot> = {}): BrainTaskSnapshot => ({
  id,
  title: `任務${id}`,
  status: "todo",
  taskDate: TODAY,
  priority: "normal",
  projectId: null,
  projectName: null,
  rank: id,
  sourcePath: null,
  sourceHeading: null,
  completedAt: null,
  startTime: null,
  durationMinutes: null,
  ...patch,
});

function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next: React.ReactElement) => flushSync(() => root.render(next));
  render(element);
  return {
    container,
    render,
    cleanup: () => { root.unmount(); container.remove(); },
  };
}

function click(element: Element | null | undefined) {
  assert.ok(element, "element to click");
  flushSync(() => (element as HTMLElement).click());
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

test("focus mode walks the queue: done completes and advances, skip only advances", () => {
  const completed: string[] = [];
  let queue = [task("a"), task("b"), task("c")];
  const view = () => (
    <FocusMode
      queue={queue}
      language="zh-TW"
      t={t}
      onComplete={(item) => { completed.push(item.id!); queue = queue.map((entry) => entry.id === item.id ? { ...entry, status: "done" } : entry); }}
      onOpenTask={() => undefined}
      onClose={() => undefined}
    />
  );
  const { container, render, cleanup } = mount(view());
  try {
    assert.match(container.querySelector(".focus-card h2")!.textContent!, /任務a/);
    click(buttonByText(container, "完成，下一件"));
    render(view());
    assert.deepEqual(completed, ["a"]);
    assert.match(container.querySelector(".focus-card h2")!.textContent!, /任務b/);
    click(buttonByText(container, "先跳過"));
    assert.match(container.querySelector(".focus-card h2")!.textContent!, /任務c/);
    click(buttonByText(container, "完成，下一件"));
    render(view());
    assert.match(container.textContent!, /全部完成了/);
    assert.deepEqual(completed, ["a", "c"]);
  } finally {
    cleanup();
  }
});

test("the waiting panel lists waiting tasks and marks them received", () => {
  const received: string[] = [];
  const { container, cleanup } = mount(
    <WaitingPanel
      tasks={[task("w1", { status: "waiting", taskDate: "2026-10-18" }), task("w2", { status: "waiting", taskDate: "2026-10-25" }), task("open")]}
      today={TODAY}
      t={t}
      onOpenTask={() => undefined}
      onReceived={(item) => received.push(item.id!)}
    />,
  );
  try {
    const rows = container.querySelectorAll(".waiting-list li");
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.classList.contains("is-due"));
    assert.match(container.textContent!, /1 件該追進度了/);
    click(rows[0]!.querySelector(".secondary-button"));
    assert.deepEqual(received, ["w1"]);
  } finally {
    cleanup();
  }
  const empty = mount(<WaitingPanel tasks={[task("open")]} today={TODAY} t={t} onOpenTask={() => undefined} onReceived={() => undefined} />);
  assert.equal(empty.container.innerHTML, "");
  empty.cleanup();
});

test("wrap-up moves the selected unfinished tasks to tomorrow", () => {
  let moved: { ids: string[]; date: string } | null = null;
  const { container, cleanup } = mount(
    <WrapUpDialog
      tasks={[task("a"), task("b"), task("done", { status: "done", completedAt: TODAY })]}
      today={TODAY}
      t={t}
      onMove={(ids, date) => { moved = { ids: [...ids], date }; }}
      onClose={() => undefined}
    />,
  );
  try {
    assert.match(container.querySelector(".wrap-up-stats")!.textContent!, /1今天完成/);
    const boxes = container.querySelectorAll<HTMLInputElement>(".wrap-up-list input");
    assert.equal(boxes.length, 2);
    click(boxes[1]);
    click(buttonByText(container, "移到明天"));
    assert.deepEqual(moved, { ids: ["a"], date: "2026-10-21" });
  } finally {
    cleanup();
  }
});

test("the repeat picker offers presets anchored on the task date", () => {
  const changes: (string | null)[] = [];
  const { container, cleanup } = mount(
    <RecurrenceSelect value="every month on the 5th" taskDate="2026-10-22" today={TODAY} locale="zh-TW" label="重複" onChange={(value) => changes.push(value)} />,
  );
  try {
    const labels = [...container.querySelectorAll("option")].map((option) => option.textContent);
    assert.deepEqual(labels.slice(0, 2), ["不重複", "每月 5 號"]);
    assert.ok(labels.includes("每週四"));
    assert.ok(labels.includes("每月 22 號"));
  } finally {
    cleanup();
  }
});
