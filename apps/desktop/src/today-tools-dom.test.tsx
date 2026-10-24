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
const { WeeklyReviewDialog } = await import("./weekly-review-ui");
const { useReminders } = await import("./reminders-ui");

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

test("focus mode walks the queue: done completes and advances, skip only advances", async () => {
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
    await tick();
    render(view());
    assert.deepEqual(completed, ["a"]);
    assert.match(container.querySelector(".focus-card h2")!.textContent!, /任務b/);
    click(buttonByText(container, "先跳過"));
    assert.match(container.querySelector(".focus-card h2")!.textContent!, /任務c/);
    click(buttonByText(container, "完成，下一件"));
    await tick();
    render(view());
    assert.match(container.textContent!, /全部完成了/);
    assert.deepEqual(completed, ["a", "c"]);
  } finally {
    cleanup();
  }
});

test("focus mode keeps the task when its save fails", async () => {
  let saved = false;
  const view = () => (
    <FocusMode
      queue={[task("a"), task("b")]}
      language="zh-TW"
      t={t}
      onComplete={() => Promise.resolve(saved)}
      onOpenTask={() => undefined}
      onClose={() => undefined}
    />
  );
  const { container, render, cleanup } = mount(view());
  try {
    click(buttonByText(container, "完成，下一件"));
    await tick();
    render(view());
    assert.match(container.querySelector(".focus-card h2")!.textContent!, /任務a/);
    assert.match(container.querySelector(".focus-error")!.textContent!, /沒有存檔成功/);
    saved = true;
    click(buttonByText(container, "完成，下一件"));
    await tick();
    render(view());
    assert.match(container.querySelector(".focus-card h2")!.textContent!, /任務b/);
    assert.equal(container.querySelector(".focus-error"), null);
  } finally {
    cleanup();
  }
});

test("reminders report failing after several notifications fail in a row", async () => {
  // Three tasks starting in 5 minutes (Taipei time) are all due with a 10-minute lead.
  const soon = new Date(Date.now() + 8 * 3_600_000 + 5 * 60_000).toISOString();
  const due = ["r1", "r2", "r3"].map((id) => task(id, { taskDate: soon.slice(0, 10), startTime: soon.slice(11, 16) }));
  localStorage.clear();
  let shouldFail = true;
  const notify = () => shouldFail ? Promise.reject(new Error("blocked")) : Promise.resolve();
  function Probe({ tasks }: { tasks: BrainTaskSnapshot[] }) {
    const failing = useReminders({ tasks, settings: { enabled: true, leadMinutes: 10, digestTime: null }, language: "zh-TW", notify });
    return <output>{failing ? "failing" : "ok"}</output>;
  }
  const { container, render, cleanup } = mount(<Probe tasks={due.slice(0, 2)} />);
  try {
    await tick();
    render(<Probe tasks={due.slice(0, 2)} />);
    assert.equal(container.textContent, "ok");
  } finally {
    cleanup();
  }
  const second = mount(<Probe tasks={due} />);
  try {
    await tick();
    second.render(<Probe tasks={due} />);
    assert.equal(second.container.textContent, "failing");
  } finally {
    second.cleanup();
    shouldFail = false;
    localStorage.clear();
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
    // A rule outside the presets opens as a custom rule with its editor shown.
    assert.ok(labels.includes("自訂：每月 5 號"));
    assert.ok(container.querySelector(".recurrence-custom"));
    assert.ok(labels.includes("每週四"));
    assert.ok(labels.includes("每月 22 號"));
  } finally {
    cleanup();
  }
});

test("the custom repeat option opens an editor for weekdays and units", () => {
  let value: string | null = "every week on Thursday";
  function Harness() {
    const [current, setCurrent] = React.useState<string | null>(value);
    return <RecurrenceSelect value={current} taskDate="2026-10-22" today={TODAY} locale="zh-TW" label="重複" onChange={(next) => { value = next; setCurrent(next); }} />;
  }
  const host = mount(<Harness />);
  try {
    const select = host.container.querySelector<HTMLSelectElement>(".recurrence-field select")!;
    flushSync(() => {
      select.value = "__custom__";
      select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    assert.ok(host.container.querySelector(".recurrence-custom"), "the editor opens");
    const monday = [...host.container.querySelectorAll<HTMLButtonElement>(".recurrence-weekdays button")].find((button) => button.textContent === "一")!;
    click(monday);
    assert.equal(value, "every week on Monday, Thursday");
    const unit = host.container.querySelector<HTMLSelectElement>(".recurrence-custom select[aria-label='單位']")!;
    flushSync(() => {
      unit.value = "month";
      unit.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    assert.equal(value, "every month on the 22nd", "a month repeat starts on the task's day");
    assert.ok(host.container.querySelector(".recurrence-custom select[aria-label='日期']"));
  } finally {
    host.cleanup();
  }
});

test("the weekly review shows this week's numbers and pages back a week", () => {
  // TODAY (2026-10-20) is a Tuesday; the week starts on Monday 10-19.
  const tasks = [
    task("a", { status: "done", completedAt: "2026-10-19", projectName: "官網", durationMinutes: 60 }),
    task("b", { status: "done", completedAt: TODAY, projectName: "官網" }),
    task("c", { status: "done", completedAt: "2026-10-13" }),
    task("late", { taskDate: "2026-10-18" }),
  ];
  const { container, cleanup } = mount(<WeeklyReviewDialog tasks={tasks} today={TODAY} language="zh-TW" t={t} onClose={() => undefined} />);
  try {
    const stats = container.querySelector(".review-stats")!.textContent!;
    assert.match(stats, /2件完成/);
    assert.match(stats, /比上週同期多 1 件/);
    assert.match(stats, /1 小時預估投入時間/);
    assert.match(stats, /2天連續有完成/);
    assert.match(stats, /目前有 1 件逾期/);
    assert.match(container.querySelector(".review-projects")!.textContent!, /官網.*2/);
    click(container.querySelector("button[aria-label='上一週']"));
    assert.match(container.querySelector(".review-week-nav")!.textContent!, /上週10\/12 – 10\/18/);
    assert.match(container.querySelector(".review-stats")!.textContent!, /1件完成/);
  } finally {
    cleanup();
  }
});
