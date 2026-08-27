import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainProjectSnapshot } from "@second-brain/brain-core";
import { ProjectPicker } from "./project-picker";

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
// Deterministic frame shim: the picker defers focus into the opened menu.
globals.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(callback, 0);

function project(id: string, name: string): BrainProjectSnapshot {
  return {
    schemaVersion: 6,
    id,
    name,
    sourcePath: null,
    status: "active",
    area: null,
    priority: null,
    progress: 0,
    focusToday: false,
    startDate: null,
    endDate: null,
    completedAt: null,
  };
}

function renderPicker(props: Partial<React.ComponentProps<typeof ProjectPicker>> = {}) {
  const selections: Array<BrainProjectSnapshot | null> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(
    <ProjectPicker
      projects={[project("p-1", "官網改版"), project("p-2", "行事曆同步")]}
      valueId={null}
      onSelect={(next) => selections.push(next)}
      locale="zh-TW"
      {...props}
    />,
  ));
  return { container, selections };
}

const click = (element: Element) =>
  flushSync(() => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
const key = (element: Element, init: { key: string }) =>
  flushSync(() => element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as unknown as Event));
// Text edits ride React's continuous lane and are impractical to synthesise in
// happy-dom, so filtering is exercised through the real `initialQuery` API.
const openMenu = async (container: HTMLElement): Promise<HTMLInputElement> => {
  const input = container.querySelector<HTMLInputElement>(".project-picker-field input")!;
  flushSync(() => input.focus());
  return input;
};

test("the picker lists projects and the none option without a query", async () => {
  const rendered = renderPicker();
  try {
    await openMenu(rendered.container);
    const options = [...rendered.container.querySelectorAll<HTMLElement>(".project-picker-option strong")].map((node) => node.textContent);
    assert.ok(options.includes("無專案"), "the none option is offered first");
    assert.ok(options.includes("官網改版"));
    assert.ok(options.includes("行事曆同步"));
  } finally {
    rendered.container.remove();
  }
});

test("a seeded query filters projects and Enter selects the active match", async () => {
  const rendered = renderPicker({ valueId: null, initialQuery: "行事" });
  try {
    await openMenu(rendered.container);
    const options = [...rendered.container.querySelectorAll(".project-picker-option strong")];
    assert.equal(options.length, 2, "none + the single fuzzy match");
    key(rendered.container.querySelector<HTMLInputElement>(".project-picker-field input")!, { key: "ArrowDown" });
    key(rendered.container.querySelector<HTMLInputElement>(".project-picker-field input")!, { key: "Enter" });
    assert.equal(rendered.selections.at(-1)?.name, "行事曆同步");
  } finally {
    rendered.container.remove();
  }
});

test("a query without an exact match offers inline creation and selects it", async () => {
  const created: string[] = [];
  const rendered = renderPicker({
    initialQuery: "側邊欄重構",
    onCreateProject: async (name) => {
      created.push(name);
      return { id: "p-new", name };
    },
  });
  try {
    await openMenu(rendered.container);
    const createRow = rendered.container.querySelector(".project-picker-create");
    assert.ok(createRow, "the create row appears for unmatched queries");
    await act(async () => {
      createRow!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(created, ["側邊欄重構"]);
    assert.equal(rendered.selections.at(-1)?.id, "p-new", "the new project becomes the selection");
    assert.equal(rendered.selections.at(-1)?.name, "側邊欄重構");
  } finally {
    rendered.container.remove();
  }
});

test("an exact-name query hides the create row so duplicates can never be made", async () => {
  const rendered = renderPicker({ initialQuery: "官網改版", onCreateProject: async () => null });
  try {
    await openMenu(rendered.container);
    assert.equal(
      rendered.container.querySelector(".project-picker-create"),
      null,
      "same-name projects would rebind scans to the wrong document",
    );
  } finally {
    rendered.container.remove();
  }
});

test("the compact chip opens the same menu and switches projects", () => {
  const rendered = renderPicker({ variant: "compact", valueId: "p-1" });
  try {
    const chip = rendered.container.querySelector<HTMLButtonElement>(".project-picker-chip")!;
    assert.match(chip.textContent ?? "", /官網改版/);
    click(chip);
    const options = [...rendered.container.querySelectorAll<HTMLElement>(".project-picker-option")];
    const none = options.find((option) => option.textContent === "無專案")!;
    click(none);
    assert.equal(rendered.selections.at(-1), null, "clearing the association saves immediately");
  } finally {
    rendered.container.remove();
  }
});
