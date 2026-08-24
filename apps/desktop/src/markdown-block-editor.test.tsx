import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { MarkdownBlockEditor } from "./markdown-block-editor";

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
globals.PointerEvent = window.PointerEvent;

function renderEditor(value: string) {
  const changes: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<MarkdownBlockEditor value={value} onChange={(next) => changes.push(next)} locale="zh-TW" />));
  return { container, changes };
}

test("a todo checkbox updates its Markdown in the single block canvas", () => {
  const rendered = renderEditor("- [ ] 撰寫初稿\n- [x] 發布\n\n## 備註");
  try {
    const checkbox = rendered.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(checkbox, "todo checkbox is interactive");
    flushSync(() => checkbox!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(rendered.changes.at(-1), "- [x] 撰寫初稿\n- [x] 發布\n\n## 備註");
  } finally {
    rendered.container.remove();
  }
});

test("dragging a Markdown block reorders the serialized Markdown", async () => {
  const rendered = renderEditor("第一段\n\n第二段");
  try {
    const handles = rendered.container.querySelectorAll<HTMLElement>("[data-markdown-drag-handle]");
    const blocks = rendered.container.querySelectorAll<HTMLElement>("[data-markdown-block-id]");
    assert.equal(handles.length, 2);
    assert.equal(blocks.length, 2);
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    if (typeof proto.setPointerCapture !== "function") Object.defineProperty(proto, "setPointerCapture", { value: () => undefined, configurable: true, writable: true });
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => blocks[0] ?? null;
    try {
      // pointermove is a continuous event in React 19: its render lands on a
      // concurrent lane, so wrap the dispatch in act() to flush it deterministically.
      await act(async () => {
        handles[1]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 8, clientY: 80 }) as unknown as Event);
        handles[1]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 7, clientX: 8, clientY: 10 }) as unknown as Event);
      });
      assert.ok(
        rendered.container.querySelector(".markdown-drop-indicator"),
        "a live insertion line marks where the block will land",
      );
      assert.ok(
        rendered.container.querySelector(".markdown-block.dragging"),
        "the dragged block is visually lifted",
      );
      await act(async () => {
        handles[1]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 7, clientX: 8, clientY: 10 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.equal(rendered.changes.at(-1), "第二段\n\n第一段");
    assert.equal(
      rendered.container.querySelector(".markdown-drop-indicator"),
      null,
      "the insertion line disappears once the drop lands",
    );
  } finally {
    rendered.container.remove();
  }
});

test("arrow keys on the drag handle move a block up or down", () => {
  const rendered = renderEditor("第一段\n\n第二段\n\n第三段");
  try {
    const handles = rendered.container.querySelectorAll<HTMLElement>("[data-markdown-drag-handle]");
    flushSync(() => {
      handles[1]!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第一段\n\n第三段\n\n第二段");
    flushSync(() => {
      handles[1]!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第一段\n\n第二段\n\n第三段");
  } finally {
    rendered.container.remove();
  }
});

test("Ctrl+Z inside the canvas undoes a reorder and Ctrl+Shift+Z reapplies it", () => {
  const rendered = renderEditor("第一段\n\n第二段");
  try {
    const handles = rendered.container.querySelectorAll<HTMLElement>("[data-markdown-drag-handle]");
    const section = rendered.container.querySelector<HTMLElement>(".markdown-block-editor");
    assert.ok(section);
    flushSync(() => {
      handles[1]!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第二段\n\n第一段");
    flushSync(() => {
      section!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "z", ctrlKey: true }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第一段\n\n第二段", "undo restores the previous arrangement");
    flushSync(() => {
      section!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "z", ctrlKey: true, shiftKey: true }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第二段\n\n第一段", "redo reapplies the undone arrangement");
  } finally {
    rendered.container.remove();
  }
});

test("deleting a block is undoable inside the editor", () => {
  const rendered = renderEditor("第一段\n\n第二段");
  try {
    const deleteButton = rendered.container.querySelectorAll<HTMLElement>(".markdown-block-delete")[1]!;
    const section = rendered.container.querySelector<HTMLElement>(".markdown-block-editor")!;
    flushSync(() => {
      deleteButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第一段");
    flushSync(() => {
      section.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "z", ctrlKey: true }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第一段\n\n第二段", "undo brings the deleted block back");
    const blocksAfterUndo = rendered.container.querySelectorAll<HTMLElement>("[data-markdown-block-id]");
    assert.equal(blocksAfterUndo.length, 2);
  } finally {
    rendered.container.remove();
  }
});

test("an empty body shows a hint instead of a blank canvas", () => {
  const rendered = renderEditor("");
  try {
    assert.ok(rendered.container.querySelector(".markdown-block-empty"), "empty state hint is shown");
    assert.ok(rendered.container.querySelector(".markdown-block-add"), "add block action remains available");
  } finally {
    rendered.container.remove();
  }
});
