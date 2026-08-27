import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { GlobalShiftMarquee, getGlobalSelectedIds } from "./global-shift-marquee";

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
