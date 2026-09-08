import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { CategoryInput } from "./category-input";

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
(globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globals.HTMLElement = window.HTMLElement;
globals.Node = window.Node;
globals.Event = window.Event;
globals.MouseEvent = window.MouseEvent;
globals.KeyboardEvent = window.KeyboardEvent;
globals.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(callback, 0);

function mount(value: string, existing: string[] = ["FAQ", "產業"], initialQuery = "") {
  const changes: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(
    <CategoryInput
      value={value}
      onChange={(next) => changes.push(next)}
      existingCategories={existing}
      listId="test-categories"
      ariaLabel="分類"
      initialQuery={initialQuery}
    />,
  ));
  return { container, changes };
}

const click = (element: Element) =>
  flushSync(() => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
const key = (element: Element, init: { key: string }) =>
  flushSync(() => element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as unknown as Event));

test("a closed category field shows the value without a search icon", () => {
  const { container } = mount("FAQ");
  try {
    assert.match(container.querySelector(".project-picker-trigger")?.textContent ?? "", /FAQ/);
    assert.equal(container.querySelector(".project-picker-menu"), null);
    assert.equal(container.querySelector(".project-picker-field"), null);
  } finally {
    container.remove();
  }
});

test("CategoryInput lists existing categories when opened", () => {
  const { container } = mount("");
  try {
    click(container.querySelector(".project-picker-trigger")!);
    const names = [...container.querySelectorAll<HTMLElement>(".project-picker-option strong")].map((node) => node.textContent);
    assert.ok(names.includes("無分類"));
    assert.ok(names.includes("FAQ"));
    assert.ok(names.includes("產業"));
    assert.ok(container.querySelector(".project-picker-menu input"), "search lives in the open menu");
  } finally {
    container.remove();
  }
});

test("Enter on a missing category name creates it", async () => {
  const { container, changes } = mount("", ["FAQ", "產業"], "Skool經營");
  try {
    click(container.querySelector(".project-picker-trigger")!);
    const input = container.querySelector<HTMLInputElement>(".project-picker-menu input")!;
    flushSync(() => input.focus());
    assert.ok(container.querySelector(".project-picker-create"), "unmatched names offer 新增分類");
    await act(async () => {
      key(input, { key: "Enter" });
    });
    assert.equal(changes.at(-1), "Skool經營");
  } finally {
    container.remove();
  }
});

test("choosing an existing category from the menu sets it", () => {
  const { container, changes } = mount("");
  try {
    click(container.querySelector(".project-picker-trigger")!);
    const faq = [...container.querySelectorAll<HTMLButtonElement>(".project-picker-option")].find((option) => option.textContent?.includes("FAQ"));
    assert.ok(faq);
    click(faq!);
    assert.equal(changes.at(-1), "FAQ");
  } finally {
    container.remove();
  }
});
