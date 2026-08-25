import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { CategoryInput } from "./category-input";

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globals.HTMLElement = window.HTMLElement;
globals.Node = window.Node;
globals.Event = window.Event;

function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(node);
  });
  return { container, root };
}

test("CategoryInput offers existing categories through one field with a visible opener", () => {
  const existing = ["工作", "生活", "提示詞/寫作"];
  let chosen = "";
  const { container } = mount(
    <CategoryInput
      value={chosen}
      onChange={(next) => { chosen = next; }}
      existingCategories={existing}
      listId="test-categories"
      ariaLabel="分類"
    />
  );
  try {
    const input = container.querySelector("input");
    assert.ok(input);
    assert.equal(input.getAttribute("list"), "test-categories");

    const datalist = container.querySelector("datalist#test-categories");
    assert.ok(datalist);
    const options = [...datalist.querySelectorAll("option")].map((o) => o.value);
    // The component pins its collation to its UI locale; mirror that here so the
    // assertion stays valid regardless of the machine's default locale.
    const expectedOrder = [...existing].sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));
    assert.deepEqual(options, expectedOrder);

    // One control, not two: the input's own datalist is the only way in, so the same value
    // cannot be edited from two places and the arrow is the browser's, matching the selects
    // beside it.
    assert.equal(container.querySelector("select.category-quick-select"), null);
    assert.equal(container.querySelector("button.category-picker-button"), null);
    assert.equal(container.querySelectorAll("input").length, 1);
  } finally {
    container.remove();
  }
});
