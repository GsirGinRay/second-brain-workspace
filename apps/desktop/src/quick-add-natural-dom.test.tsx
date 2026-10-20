import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { taipeiDateKey } from "@second-brain/brain-ui";
import { translate } from "./ui-preferences";

register("./asset-loader.mjs", import.meta.url);

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
globals.getComputedStyle = window.getComputedStyle.bind(window);

const { QuickAddModal } = await import("./App");

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function mount(props: { initialTitle: string; forceDate?: boolean; initialDate?: string }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: BrainTaskSnapshot[][] = [];
  flushSync(() => root.render(
    <QuickAddModal tasks={[]} projects={[]} onClose={() => undefined} onSave={(next) => { saved.push(next); }} {...props} />,
  ));
  const cleanup = () => {
    root.unmount();
    container.remove();
  };
  return { container, saved, cleanup };
}

function titleInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(".quick-add-modal label input")!;
}

function pressEnter(input: HTMLInputElement) {
  flushSync(() => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event));
}

const tomorrow = addDays(taipeiDateKey(new Date()), 1);

test("a date and time typed in the title schedule the task and leave a clean title", () => {
  const view = mount({ initialTitle: "明天下午3點開會" });
  try {
    const input = titleInput(view.container);
    const hint = view.container.querySelector(".quick-natural-hint");
    assert.ok(hint, "the recognized schedule is shown before saving");
    assert.match(hint!.textContent ?? "", /15:00/);
    pressEnter(input);
    const task = view.saved.at(-1)?.at(-1);
    assert.equal(task?.title, "開會");
    assert.equal(task?.taskDate, tomorrow);
    assert.equal(task?.startTime, "15:00");
  } finally {
    view.cleanup();
  }
});

test("keeping the words literal saves the title as typed", () => {
  const view = mount({ initialTitle: "明天下午3點開會" });
  try {
    const input = titleInput(view.container);
    const ignore = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === translate("zh-TW", "quick.natural.ignore"))!;
    flushSync(() => ignore.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(view.container.querySelector(".quick-natural-hint"), null);
    pressEnter(input);
    const task = view.saved.at(-1)?.at(-1);
    assert.equal(task?.title, "明天下午3點開會");
    assert.equal(task?.startTime, null);
  } finally {
    view.cleanup();
  }
});

test("a calendar quick add keeps its locked date and still picks up the time", () => {
  const view = mount({ forceDate: true, initialDate: "2026-12-01", initialTitle: "明天下午3點開會" });
  try {
    const input = titleInput(view.container);
    pressEnter(input);
    const task = view.saved.at(-1)?.at(-1);
    assert.equal(task?.taskDate, "2026-12-01");
    assert.equal(task?.startTime, "15:00");
    assert.equal(task?.title, "明天開會", "the date word is kept because the day is locked");
  } finally {
    view.cleanup();
  }
});

test("ordinary numbers in a title are not mistaken for dates", () => {
  const view = mount({ initialTitle: "買3本書" });
  try {
    const input = titleInput(view.container);
    assert.equal(view.container.querySelector(".quick-natural-hint"), null);
    pressEnter(input);
    assert.equal(view.saved.at(-1)?.at(-1)?.title, "買3本書");
  } finally {
    view.cleanup();
  }
});

test("a duration without a start time stays in the title", () => {
  const view = mount({ initialTitle: "讀書1小時" });
  try {
    const input = titleInput(view.container);
    assert.equal(view.container.querySelector(".quick-natural-hint"), null);
    pressEnter(input);
    const task = view.saved.at(-1)?.at(-1);
    assert.equal(task?.title, "讀書1小時");
    assert.equal(task?.durationMinutes, null);
  } finally {
    view.cleanup();
  }
});

test("late evening without a date means tonight's midnight", () => {
  const view = mount({ initialTitle: "晚上12點打電話" });
  try {
    pressEnter(titleInput(view.container));
    const task = view.saved.at(-1)?.at(-1);
    assert.equal(task?.taskDate, tomorrow);
    assert.equal(task?.startTime, "00:00");
  } finally {
    view.cleanup();
  }
});