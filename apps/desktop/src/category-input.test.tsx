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

test("CategoryInput provides datalist and quick-select options for existing categories", () => {
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
    assert.deepEqual(options, ["工作", "生活", "提示詞/寫作"]);

    const select = container.querySelector("select.category-quick-select");
    assert.ok(select, "quick select dropdown exists");
    flushSync(() => {
      select!.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
  } finally {
    container.remove();
  }
});
