import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { blockMenuPlacement, deriveBlockKind, MarkdownBlockEditor, parseStyledBlock } from "./markdown-block-editor";

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

test("Markdown markers identify their visual block type immediately", () => {
  assert.deepEqual(deriveBlockKind("# "), { kind: "heading", level: 1 });
  assert.deepEqual(deriveBlockKind("- "), { kind: "bullet" });
  assert.deepEqual(deriveBlockKind("1. "), { kind: "ordered" });
  assert.deepEqual(deriveBlockKind("> "), { kind: "quote" });
  assert.deepEqual(deriveBlockKind("---"), { kind: "divider" });
  assert.deepEqual(deriveBlockKind("```"), { kind: "code" });
});

test("the block menu stays inside a narrow side panel viewport and flips above the row", () => {
  assert.deepEqual(
    blockMenuPlacement({ left: 390, top: 680, bottom: 704 }, 420, 720),
    { left: 108, width: 300, maxHeight: 520, bottom: 44, top: "auto" },
  );
  assert.deepEqual(
    blockMenuPlacement({ left: 8, top: 20, bottom: 44 }, 260, 720),
    { left: 12, width: 236, maxHeight: 520, top: 48, bottom: "auto" },
  );
});

test("structural Markdown markers stay in storage but disappear from the live field", () => {
  const heading = renderEditor("# The idea");
  try {
    assert.equal(openTextarea(heading.container, 0).value, "The idea");
  } finally {
    heading.container.remove();
  }
  const bullet = renderEditor("- First point");
  try {
    assert.equal(openTextarea(bullet.container, 0).value, "First point");
    assert.equal(bullet.container.querySelector(".markdown-structural-edit-row>span")?.textContent, "•");
  } finally {
    bullet.container.remove();
  }
});
globals.PointerEvent = window.PointerEvent;
// Continuation/caret restores are deferred by one frame.
globals.requestAnimationFrame = (callback: (time: number) => void) => setTimeout(callback, 0);

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

test("Shift marquee selects multiple Markdown blocks and one handle moves them with one undo", async () => {
  const rendered = renderEditor("第一段\n\n第二段\n\n第三段\n\n第四段");
  try {
    const section = rendered.container.querySelector<HTMLElement>(".markdown-block-editor");
    const blocks = rendered.container.querySelectorAll<HTMLElement>("[data-markdown-block-id]");
    const handles = rendered.container.querySelectorAll<HTMLElement>("[data-markdown-drag-handle]");
    assert.ok(section);
    assert.equal(blocks.length, 4);
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    if (typeof proto.setPointerCapture !== "function") Object.defineProperty(proto, "setPointerCapture", { value: () => undefined, configurable: true, writable: true });
    if (typeof proto.releasePointerCapture !== "function") Object.defineProperty(proto, "releasePointerCapture", { value: () => undefined, configurable: true, writable: true });
    blocks.forEach((block, index) => {
      const top = 20 + index * 50;
      block.getBoundingClientRect = () => ({
        x: 20,
        y: top,
        left: 20,
        top,
        right: 220,
        bottom: top + 40,
        width: 200,
        height: 40,
        toJSON: () => ({}),
      });
    });

    await act(async () => {
      section!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 11, clientX: 10, clientY: 65, shiftKey: true }) as unknown as Event);
      section!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 11, clientX: 230, clientY: 165, shiftKey: true }) as unknown as Event);
    });
    assert.ok(rendered.container.querySelector("[data-markdown-selection-marquee]"), "the translucent blue box is visible while selecting");
    assert.equal(rendered.container.querySelectorAll(".markdown-block.selected").length, 2, "only the two intersected blocks have translucent blue backgrounds");
    await act(async () => {
      section!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 11, clientX: 230, clientY: 165, shiftKey: true }) as unknown as Event);
    });
    assert.equal(rendered.container.querySelector("[data-markdown-selection-marquee]"), null);

    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => blocks[3] ?? null;
    try {
      await act(async () => {
        handles[1]!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 12, clientX: 8, clientY: 80 }) as unknown as Event);
        handles[1]!.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 12, clientX: 8, clientY: 205 }) as unknown as Event);
      });
      assert.equal(rendered.container.querySelectorAll(".markdown-block.dragging").length, 2, "both selected blocks lift together");
      await act(async () => {
        handles[1]!.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 12, clientX: 8, clientY: 205 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }

    assert.equal(rendered.changes.length, 1, "the batch reorder serializes once");
    assert.equal(rendered.changes.at(-1), "第一段\n\n第四段\n\n第二段\n\n第三段");
    flushSync(() => {
      section!.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "z", ctrlKey: true }) as unknown as Event);
    });
    assert.equal(rendered.changes.at(-1), "第一段\n\n第二段\n\n第三段\n\n第四段", "one undo restores the whole group move");
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

test("an empty body does not show instructional copy", () => {
  const rendered = renderEditor("");
  try {
    assert.equal(rendered.container.querySelector(".markdown-block-empty"), null);
    assert.doesNotMatch(rendered.container.textContent ?? "", /尚無詳細內容|No detail yet/);
    assert.equal(rendered.container.querySelectorAll(".markdown-block").length, 1, "an editable blank block is ready immediately");
    assert.match(rendered.container.querySelector<HTMLTextAreaElement>(".markdown-block-input")?.placeholder ?? "", /輸入文字/);
  } finally {
    rendered.container.remove();
  }
});

/** Enters a block's edit mode and returns its textarea. */
function openTextarea(container: HTMLElement, index: number): HTMLTextAreaElement {
  const editSurface = container.querySelectorAll<HTMLElement>(".markdown-block-content")[index]!;
  // The preview may contain its own buttons (code copy); only the block's own
  // text button or preview surface switches it into editing.
  const trigger = editSurface.querySelector<HTMLElement>(".markdown-task-block button, .markdown-block-preview, .markdown-block-divider")!;
  flushSync(() => trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  return container.querySelector<HTMLTextAreaElement>(".markdown-block-input")!;
}

function pressKey(textarea: HTMLTextAreaElement, init: { key: string; ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean }) {
  flushSync(() => {
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    }) as unknown as Event);
  });
}

function setCaret(textarea: HTMLTextAreaElement, start: number) {
  Object.defineProperty(textarea, "selectionStart", { value: start, configurable: true });
  Object.defineProperty(textarea, "selectionEnd", { value: start, configurable: true });
}

test("a complete checkbox marker immediately exposes a live checkbox and content field", () => {
  const rendered = renderEditor("- [ ]");
  try {
    assert.ok(rendered.container.querySelector('.markdown-task-block input[type="checkbox"]'), "the checkbox is visible without Enter");
    const textarea = openTextarea(rendered.container, 0);
    assert.ok(textarea.classList.contains("markdown-task-input"), "editing keeps the live checkbox beside the content field");
    assert.equal(textarea.value, "", "the Markdown marker is hidden from the task content field");
  } finally {
    rendered.container.remove();
  }
});

test("slash commands transform a block with the keyboard", () => {
  const rendered = renderEditor("/h1");
  try {
    const textarea = openTextarea(rendered.container, 0);
    assert.ok(rendered.container.querySelector(".markdown-slash-menu"));
    pressKey(textarea, { key: "Enter" });
    assert.equal(rendered.changes.at(-1), "# ");
  } finally {
    rendered.container.remove();
  }
});

test("block background colors persist in an ignored Markdown comment", () => {
  const rendered = renderEditor("The idea /blue background");
  try {
    const textarea = openTextarea(rendered.container, 0);
    pressKey(textarea, { key: "Enter" });
    const saved = rendered.changes.at(-1) ?? "";
    assert.deepEqual(parseStyledBlock(saved), {
      content: "The idea",
      style: { color: "default", background: "blue" },
    });
    assert.equal(rendered.container.querySelector(".markdown-block")?.getAttribute("data-block-background"), "blue");
  } finally {
    rendered.container.remove();
  }
});

test("the six-dot menu exposes nested Notion-style block actions", () => {
  const rendered = renderEditor("原始內容");
  const click = (element: Element) => flushSync(() => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const menuButton = (label: string) => Array.from(rendered.container.querySelectorAll<HTMLButtonElement>(".markdown-block-menu button"))
    .find((button) => button.textContent?.includes(label));
  try {
    const grip = rendered.container.querySelector<HTMLElement>("[data-markdown-drag-handle]");
    assert.ok(grip);
    click(grip!);
    assert.ok(menuButton("轉換成"), "block conversion is a top-level action");
    assert.ok(menuButton("顏色"), "color is a top-level action");
    assert.ok(menuButton("建立複本"), "duplicate is a top-level action");

    click(menuButton("轉換成")!);
    const heading4 = menuButton("標題 4");
    assert.ok(heading4, "Heading 4 is available as a Markdown-native block type");
    click(heading4!);
    assert.equal(rendered.changes.at(-1), "#### 原始內容");

    click(grip!);
    click(menuButton("顏色")!);
    const blueBackground = rendered.container.querySelector<HTMLButtonElement>('[aria-label="藍色底色"]');
    assert.ok(blueBackground);
    click(blueBackground!);
    assert.deepEqual(parseStyledBlock(rendered.changes.at(-1) ?? ""), {
      content: "#### 原始內容",
      style: { color: "default", background: "blue" },
    });
  } finally {
    rendered.container.remove();
  }
});

test("duplicating from the six-dot menu inserts a full styled copy below", () => {
  const rendered = renderEditor("可複製區塊\n<!-- sbw:block-style color=red background=yellow -->");
  try {
    const grip = rendered.container.querySelector<HTMLElement>("[data-markdown-drag-handle]");
    flushSync(() => grip!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    const duplicate = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>(".markdown-block-menu button"))
      .find((button) => button.textContent?.includes("建立複本"));
    assert.ok(duplicate);
    flushSync(() => duplicate!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    assert.equal(rendered.container.querySelectorAll("[data-markdown-block-id]").length, 2);
    assert.equal(rendered.changes.at(-1), "可複製區塊\n<!-- sbw:block-style color=red background=yellow -->\n\n可複製區塊\n<!-- sbw:block-style color=red background=yellow -->");
  } finally {
    rendered.container.remove();
  }
});

test("Enter on a todo item creates a separately draggable checkbox block", () => {
  const rendered = renderEditor("- [ ] 撰寫初稿");
  try {
    const textarea = openTextarea(rendered.container, 0);
    const end = "- [ ] 撰寫初稿".length;
    setCaret(textarea, end);
    pressKey(textarea, { key: "Enter" });
    assert.equal(rendered.changes.at(-1), "- [ ] 撰寫初稿\n\n- [ ] ", "the next checkbox is its own Markdown block");
    assert.equal(rendered.container.querySelectorAll("[data-markdown-block-id]").length, 2, "both checkboxes have independent drag handles");
  } finally {
    rendered.container.remove();
  }
});

test("Enter continues lists as separately draggable blocks", () => {
  const rendered = renderEditor("1. First");
  try {
    const textarea = openTextarea(rendered.container, 0);
    setCaret(textarea, "First".length);
    pressKey(textarea, { key: "Enter" });
    assert.equal(rendered.changes.at(-1), "1. First\n\n2. ");
    assert.equal(rendered.container.querySelectorAll("[data-markdown-block-id]").length, 2);
    assert.equal(rendered.container.querySelector<HTMLTextAreaElement>(".markdown-block-input")?.value, "");
  } finally {
    rendered.container.remove();
  }
});

test("a second Enter on an empty todo item reverts the line to plain text", () => {
  const rendered = renderEditor("- [ ] ");
  try {
    const textarea = openTextarea(rendered.container, 0);
    setCaret(textarea, "- [ ] ".length);
    pressKey(textarea, { key: "Enter" });
    assert.equal(rendered.changes.at(-1), "", "the marker is stripped and the line becomes normal text");
  } finally {
    rendered.container.remove();
  }
});

test("IME composition Enter never triggers structural edits", () => {
  const rendered = renderEditor("- [ ] 撰寫初稿");
  try {
    const textarea = openTextarea(rendered.container, 0);
    setCaret(textarea, "- [ ] 撰寫初稿".length);
    pressKey(textarea, { key: "Enter", isComposing: true });
    assert.equal(rendered.changes.length, 0, "composing Enter is left to the input method");
  } finally {
    rendered.container.remove();
  }
});

test("Ctrl+B wraps the selection in bold inside a block", () => {
  const rendered = renderEditor("重點段落");
  try {
    const textarea = openTextarea(rendered.container, 0);
    Object.defineProperty(textarea, "selectionStart", { value: 0, configurable: true });
    Object.defineProperty(textarea, "selectionEnd", { value: "重點段落".length, configurable: true });
    pressKey(textarea, { key: "b", ctrlKey: true });
    assert.equal(rendered.changes.at(-1), "**重點段落**");
  } finally {
    rendered.container.remove();
  }
});

test("Enter on a paragraph commits it to preview and opens a fresh block below", () => {
  const rendered = renderEditor("第一段");
  try {
    const textarea = openTextarea(rendered.container, 0);
    setCaret(textarea, "第一段".length);
    pressKey(textarea, { key: "Enter" });
    assert.equal(rendered.changes.at(-1), "第一段");
    assert.equal(
      rendered.container.querySelectorAll("[data-markdown-block-id]").length,
      2,
      "a new empty block continues the writing flow",
    );
    assert.ok(rendered.container.querySelector(".markdown-block-input"), "the new block is ready to type into");
  } finally {
    rendered.container.remove();
  }
});

test("``` plus Enter and --- plus Enter produce code and divider blocks", () => {
  const fence = renderEditor("```");
  try {
    const textarea = openTextarea(fence.container, 0);
    setCaret(textarea, 3);
    pressKey(textarea, { key: "Enter" });
    assert.equal(fence.changes.at(-1), "```\n\n```");
  } finally {
    fence.container.remove();
  }
  const divider = renderEditor("---");
  try {
    const textarea = openTextarea(divider.container, 0);
    setCaret(textarea, 3);
    pressKey(textarea, { key: "Enter" });
    assert.equal(divider.changes.at(-1), "---");
  } finally {
    divider.container.remove();
  }
});
