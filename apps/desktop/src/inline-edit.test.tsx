import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { InlineTitle } from "./inline-title";
import { ImportanceControl, PriorityControl } from "./priority-control";

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

function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(node);
  });
  return { container, root };
}

function dispatch(element: Element, type: string) {
  element.dispatchEvent(new window.MouseEvent(type, { bubbles: true }) as unknown as Event);
}

test("double-clicking a title opens the editor", () => {
  const { container } = mount(
    <InlineTitle value="買牛奶" onSave={() => undefined} ariaLabel="任務標題" hint="雙擊編輯" />,
  );
  try {
    const button = container.querySelector("button");
    assert.ok(button);
    flushSync(() => dispatch(button!, "dblclick"));
    const input = container.querySelector("input");
    assert.ok(input, "title editor opens");
    assert.equal((input as HTMLInputElement).value, "買牛奶");
  } finally {
    container.remove();
  }
});

test("unchanged titles are not saved", () => {
  const saved: string[] = [];
  const { container } = mount(
    <InlineTitle value="原稿" editing onSave={(title) => saved.push(title)} ariaLabel="任務標題" hint="雙擊編輯" />,
  );
  try {
    const input = container.querySelector("input");
    assert.ok(input);
    flushSync(() => {
      input!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(saved, []);
  } finally {
    container.remove();
  }
});

test("priority control reports the chosen level", () => {
  const chosen: string[] = [];
  const { container } = mount(
    <PriorityControl priority="normal" onChange={(priority) => chosen.push(priority)} />,
  );
  try {
    const trigger = container.querySelector(".priority-trigger");
    assert.ok(trigger);
    flushSync(() => dispatch(trigger!, "dblclick"));
    const option = [...container.querySelectorAll("[role='menuitem']")].find((item) => item.textContent?.includes("P2"));
    assert.ok(option, "P2 option is visible");
    flushSync(() => dispatch(option!, "click"));
    assert.deepEqual(chosen, ["high"]);
  } finally {
    container.remove();
  }
});

test("importance control can clear a 1-3 value", () => {
  const chosen: Array<number | null> = [];
  const { container } = mount(
    <ImportanceControl value={1} onChange={(value) => chosen.push(value)} />,
  );
  try {
    const trigger = container.querySelector(".priority-trigger");
    assert.ok(trigger);
    flushSync(() => dispatch(trigger!, "click"));
    const unset = [...container.querySelectorAll("[role='menuitem']")].find((item) => item.textContent === "未設定");
    assert.ok(unset);
    flushSync(() => dispatch(unset!, "click"));
    assert.deepEqual(chosen, [null]);
  } finally {
    container.remove();
  }
});
