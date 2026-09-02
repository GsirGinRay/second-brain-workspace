import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  GLOBAL_SELECTION_DELETE_EVENT,
  GlobalShiftMarquee,
  addToSelection,
  clearGlobalSelection,
  consumeGlobalMarqueeClick,
  getGlobalSelectedIds,
} from "./global-shift-marquee";

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.HTMLElement = window.HTMLElement;
globals.PointerEvent = window.PointerEvent;
globals.DOMRect = window.DOMRect;
(globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("Shift dragging anywhere draws one blue box and selects every intersecting draggable item", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<GlobalShiftMarquee />));

  const first = document.createElement("article");
  first.dataset.globalSelectId = "task-1";
  first.getBoundingClientRect = () => new DOMRect(20, 20, 80, 40);
  const second = document.createElement("article");
  second.dataset.globalSelectId = "task-2";
  second.getBoundingClientRect = () => new DOMRect(20, 80, 80, 40);
  const outside = document.createElement("article");
  outside.dataset.globalSelectId = "task-3";
  outside.getBoundingClientRect = () => new DOMRect(300, 300, 80, 40);
  document.body.append(first, second, outside);

  act(() => {
    document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true, clientX: 10, clientY: 10, pointerId: 7 }) as unknown as Event);
    document.body.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, shiftKey: true, clientX: 120, clientY: 140, pointerId: 7 }) as unknown as Event);
  });
  assert.ok(container.querySelector("[data-global-selection-marquee]"));
  assert.deepEqual(getGlobalSelectedIds("task-1"), ["task-1", "task-2"]);
  assert.equal(first.classList.contains("global-shift-selected"), true);
  assert.equal(second.classList.contains("global-shift-selected"), true);
  assert.equal(outside.classList.contains("global-shift-selected"), false);

  act(() => document.body.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 120, clientY: 140, pointerId: 7 }) as unknown as Event));
  assert.equal(container.querySelector("[data-global-selection-marquee]"), null);

  act(() => root.unmount());
  first.remove();
  second.remove();
  outside.remove();
  container.remove();
});

test("a plain drag inside a plain-marquee scope box-selects without Shift", () => {
  clearGlobalSelection();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<GlobalShiftMarquee />));

  const scope = document.createElement("section");
  scope.setAttribute("data-plain-marquee-scope", "");
  document.body.append(scope);
  const first = document.createElement("article");
  first.dataset.globalSelectId = "task-1";
  first.getBoundingClientRect = () => new DOMRect(20, 20, 80, 40);
  const second = document.createElement("article");
  second.dataset.globalSelectId = "task-2";
  second.getBoundingClientRect = () => new DOMRect(20, 80, 80, 40);
  scope.append(first, second);

  act(() => {
    // The press lands on the scope background (not on a chip) without Shift.
    scope.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 5, clientY: 5, pointerId: 9 }) as unknown as Event);
    document.body.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, clientX: 120, clientY: 140, pointerId: 9 }) as unknown as Event);
  });
  assert.ok(container.querySelector("[data-global-selection-marquee]"), "the marquee rectangle appears for a plain drag");
  assert.deepEqual(getGlobalSelectedIds("task-1"), ["task-1", "task-2"]);
  assert.equal(first.classList.contains("global-shift-selected"), true);
  assert.equal(second.classList.contains("global-shift-selected"), true);

  act(() => document.body.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 120, clientY: 140, pointerId: 9 }) as unknown as Event));
  assert.equal(container.querySelector("[data-global-selection-marquee]"), null);
  assert.equal(consumeGlobalMarqueeClick(), true, "the trailing click after a plain box-drag is swallowed");
  assert.equal(consumeGlobalMarqueeClick(), false, "the suppression is a one-shot window, not sticky");

  act(() => root.unmount());
  scope.remove();
  container.remove();
});

test("a plain press inside a scope that never drags stays a normal click", () => {
  clearGlobalSelection();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<GlobalShiftMarquee />));

  const scope = document.createElement("section");
  scope.setAttribute("data-plain-marquee-scope", "");
  document.body.append(scope);
  const first = document.createElement("article");
  first.dataset.globalSelectId = "task-1";
  first.getBoundingClientRect = () => new DOMRect(20, 20, 80, 40);
  scope.append(first);

  act(() => {
    scope.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 5, clientY: 5, pointerId: 10 }) as unknown as Event);
    document.body.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 5, clientY: 5, pointerId: 10 }) as unknown as Event);
  });
  assert.equal(container.querySelector("[data-global-selection-marquee]"), null, "no marquee rectangle without movement");
  assert.deepEqual(getGlobalSelectedIds("task-1"), ["task-1"], "a plain click selects nothing");
  assert.equal(consumeGlobalMarqueeClick(), false, "a plain click is not swallowed");

  act(() => root.unmount());
  scope.remove();
  container.remove();
});

test("Delete with a mixed selection dispatches one delete event per kind and clears", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<GlobalShiftMarquee />));

  addToSelection("task-1", "task");
  addToSelection("task-2", "task");
  addToSelection("block-1", "markdown-block");
  const events: Array<{ ids: string[]; kind: string }> = [];
  const listener = (event: Event): void => {
    events.push((event as CustomEvent<{ ids: string[]; kind: string }>).detail);
  };
  // happy-dom's Window listener signature disagrees with the DOM lib Event.
  window.addEventListener(GLOBAL_SELECTION_DELETE_EVENT, listener as never);

  try {
    act(() => {
      document.body.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Delete" }) as unknown as Event);
    });
    assert.deepEqual(
      events.sort((a, b) => a.kind.localeCompare(b.kind)),
      [
        { ids: ["block-1"], kind: "markdown-block" },
        { ids: ["task-1", "task-2"], kind: "task" },
      ],
      "each surface receives exactly its own selection",
    );
    assert.deepEqual(getGlobalSelectedIds("task-1"), ["task-1"], "the selection is cleared after the delete");

    events.length = 0;
    const input = document.createElement("input");
    document.body.append(input);
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }) as unknown as Event);
    });
    assert.deepEqual(events, [], "typing surfaces keep their native delete behaviour");
    input.remove();
  } finally {
    window.removeEventListener(GLOBAL_SELECTION_DELETE_EVENT, listener as never);
    act(() => root.unmount());
    container.remove();
  }
});
