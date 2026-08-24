import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { MarkdownBlockEditor } from "./markdown-block-editor";

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
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

test("dragging a Markdown block reorders the serialized Markdown", () => {
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
      flushSync(() => {
        handles[1]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 8, clientY: 80 }) as unknown as Event);
        handles[1]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 7, clientX: 8, clientY: 10 }) as unknown as Event);
        handles[1]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 7, clientX: 8, clientY: 10 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }
    assert.equal(rendered.changes.at(-1), "第二段\n\n第一段");
  } finally {
    rendered.container.remove();
  }
});
