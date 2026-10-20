import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BrainCollectionSnapshot } from "@second-brain/brain-core";
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

const { CollectionEditor } = await import("./App");

const collection: BrainCollectionSnapshot = {
  schemaVersion: 6,
  id: "collection-1",
  name: "閱讀筆記",
  sourcePath: "知識/閱讀筆記.md",
  category: "參考",
  importance: 2,
  body: "重點",
} as BrainCollectionSnapshot;

function mount(deleteResult: boolean | undefined = undefined) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: BrainCollectionSnapshot[] = [];
  const deleted: BrainCollectionSnapshot[] = [];
  const render = (value: BrainCollectionSnapshot) => flushSync(() => root.render(
    <CollectionEditor
      collection={value}
      locale="zh-TW"
      autosaveDelayMs={20}
      onSave={(next) => { saved.push(next); return true; }}
      onDelete={async (next) => { deleted.push(next); return deleteResult ?? true; }}
    />,
  ));
  const cleanup = () => {
    root.unmount();
    container.remove();
  };
  return { container, root, saved, deleted, render, cleanup };
}

function chooseImportance(container: HTMLElement, value: string) {
  const select = [...container.querySelectorAll<HTMLSelectElement>(".project-editor-grid select")].at(-1)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  });
}

const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const statusText = (container: HTMLElement) => container.querySelector(".detail-autosave-status")?.textContent ?? "";

test("knowledge edits save themselves after a pause, with no Save button", async () => {
  const view = mount();
  try {
    view.render(collection);
    assert.equal(
      [...view.container.querySelectorAll("button")].some((button) => button.textContent?.includes(translate("zh-TW", "app.save"))),
      false,
    );
    chooseImportance(view.container, "1");
    assert.equal(view.saved.length, 0, "nothing is written while the user is still editing");
    assert.equal(statusText(view.container), translate("zh-TW", "detail.autosave.pending"));
    await pause(60);
    assert.equal(view.saved.length, 1);
    assert.equal(view.saved[0]?.importance, 1);
    view.render({ ...collection, importance: 1 });
    assert.equal(statusText(view.container), translate("zh-TW", "detail.autosave.saved"));
  } finally {
    view.cleanup();
  }
});

test("an outside change is adopted without writing it back", async () => {
  const view = mount();
  try {
    view.render(collection);
    view.render({ ...collection, importance: 3, body: "外部更新" });
    await pause(60);
    assert.equal(view.saved.length, 0, "adopting an outside edit is not a user edit");
    const select = [...view.container.querySelectorAll<HTMLSelectElement>(".project-editor-grid select")].at(-1)!;
    assert.equal(select.value, "3");
  } finally {
    view.cleanup();
  }
});

test("leaving the editor flushes a pending edit", async () => {
  const view = mount();
  view.render(collection);
  chooseImportance(view.container, "3");
  view.cleanup();
  await pause(0);
  assert.equal(view.saved.at(-1)?.importance, 3);
});

test("deleting does not write the collection back on unmount", async () => {
  const view = mount();
  view.render(collection);
  chooseImportance(view.container, "1");
  const arm = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${translate("zh-TW", "collection.action.delete")}"]`)!;
  flushSync(() => arm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes(translate("zh-TW", "confirm.deleteAgain")))!;
  assert.ok(confirm, "the delete confirmation is shown");
  flushSync(() => confirm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  assert.equal(view.deleted.length, 1);
  view.cleanup();
  await pause(60);
  assert.equal(view.saved.length, 0);
});

test("a failed delete keeps saving later edits", async () => {
  const view = mount(false);
  try {
    view.render(collection);
    const arm = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${translate("zh-TW", "collection.action.delete")}"]`)!;
    flushSync(() => arm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes(translate("zh-TW", "confirm.deleteAgain")))!;
    await act(async () => {
      confirm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    assert.equal(view.deleted.length, 1);
    chooseImportance(view.container, "3");
    await pause(60);
    assert.equal(view.saved.at(-1)?.importance, 3, "the edit after a failed delete is written");
  } finally {
    view.cleanup();
  }
});