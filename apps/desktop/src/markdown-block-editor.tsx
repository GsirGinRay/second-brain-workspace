import React, { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { MarkdownPreview, type MarkdownEditorLocale } from "./markdown-editor";

interface MarkdownBlock {
  id: string;
  source: string;
}

const TASK_LINE = /^(\s*[-*+]\s+)\[([ xX])\](\s*.*)$/;

/** Structural edits are undoable inside the editor; textareas keep native undo. */
const EDITOR_HISTORY_LIMIT = 50;

function newBlockId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `markdown-block-${Date.now()}-${Math.random()}`;
}

export function splitMarkdownBlocks(value: string): string[] {
  if (!value.trim()) return [];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: "```" | "~~~" | null = null;
  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of value.replace(/\r\n/g, "\n").split("\n")) {
    const marker = line.match(/^\s*(```|~~~)/)?.[1] as "```" | "~~~" | undefined;
    if (marker) fence = fence === marker ? null : (fence ?? marker);
    if (!fence && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function createBlocks(value: string): MarkdownBlock[] {
  return splitMarkdownBlocks(value).map((source) => ({ id: newBlockId(), source }));
}

function serializeBlocks(blocks: MarkdownBlock[]): string {
  return blocks.map((block) => block.source.trimEnd()).filter((source) => source.trim()).join("\n\n");
}

function isTaskBlock(source: string): boolean {
  const lines = source.split("\n");
  return lines.length > 0 && lines.every((line) => TASK_LINE.test(line));
}

function moveItem(items: MarkdownBlock[], from: number, to: number): MarkdownBlock[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (!moved) return items;
  next.splice(to, 0, moved);
  return next;
}

export function MarkdownBlockEditor({
  value,
  onChange,
  locale = "zh-TW",
}: {
  value: string;
  onChange: (value: string) => void;
  locale?: MarkdownEditorLocale;
}) {
  const zh = locale === "zh-TW";
  const [blocks, setBlocks] = useState<MarkdownBlock[]>(() => createBlocks(value));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Index of the insertion gap currently highlighted while dragging (0 = before the
  // first block, blocks.length = after the last one).
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragRef = useRef<{ id: string; startY: number; moved: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });

  useEffect(() => {
    if (value !== serializeBlocks(blocks)) {
      setBlocks(createBlocks(value));
      setEditingId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: MarkdownBlock[]) => {
    setBlocks(next);
    onChange(serializeBlocks(next));
  };

  const pushHistory = () => {
    historyRef.current.past.push(serializeBlocks(blocks));
    while (historyRef.current.past.length > EDITOR_HISTORY_LIMIT) historyRef.current.past.shift();
    historyRef.current.future = [];
  };

  const applySerialized = (source: string) => {
    setBlocks(createBlocks(source));
    setEditingId(null);
    onChange(source);
  };

  const undoBlocks = () => {
    const previous = historyRef.current.past.pop();
    if (!previous) return;
    historyRef.current.future.push(serializeBlocks(blocks));
    applySerialized(previous);
  };

  const redoBlocks = () => {
    const next = historyRef.current.future.pop();
    if (!next) return;
    historyRef.current.past.push(serializeBlocks(blocks));
    applySerialized(next);
  };

  // Ctrl+Z / Ctrl+Shift+Z inside the canvas restores the previous arrangement.
  // Inside a textarea the browser's native text undo applies instead.
  const handleHistoryShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) redoBlocks();
    else undoBlocks();
  };

  const updateBlock = (id: string, source: string) => {
    commit(blocks.map((block) => block.id === id ? { ...block, source } : block));
  };
  const removeBlock = (id: string) => {
    if (!blocks.some((block) => block.id === id)) return;
    pushHistory();
    commit(blocks.filter((block) => block.id !== id));
    if (editingId === id) setEditingId(null);
  };
  const toggleTask = (blockId: string, lineIndex: number, checked: boolean) => {
    const block = blocks.find((item) => item.id === blockId);
    if (!block) return;
    pushHistory();
    const lines = block.source.split("\n");
    lines[lineIndex] = lines[lineIndex]!.replace(TASK_LINE, (_line, prefix: string, _checked: string, content: string) => `${prefix}[${checked ? "x" : " "}]${content}`);
    updateBlock(blockId, lines.join("\n"));
  };
  const moveBlock = (id: string, delta: -1 | 1) => {
    const from = blocks.findIndex((block) => block.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= blocks.length) return;
    pushHistory();
    commit(moveItem(blocks, from, to));
  };

  /**
   * Which insertion gap the pointer is over (0 = above the first block,
   * blocks.length = below the last one). Primary targeting comes from whatever
   * block sits under the pointer: its upper half inserts before it, its lower
   * half after it. When the pointer is over empty canvas near the list instead,
   * the list's own bounds decide between appending and cancelling, so drops
   * outside the editor never cause a surprise reorder.
   */
  const computeDropIndex = (clientX: number, clientY: number): number | null => {
    const list = listRef.current;
    if (!list) return null;
    const items = Array.from(list.querySelectorAll<HTMLElement>("[data-markdown-block-id]"));
    const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-markdown-block-id]");
    if (hit) {
      const index = items.indexOf(hit);
      if (index >= 0) {
        const rect = hit.getBoundingClientRect();
        // Without layout information (tests) the upper-half rule keeps drops stable.
        if (rect.height > 0 && clientY > rect.top + rect.height / 2) return index + 1;
        return index;
      }
    }
    const listRect = list.getBoundingClientRect();
    if (listRect.height <= 0) return null;
    if (
      clientY < listRect.top - 32 ||
      clientY > listRect.bottom + 32 ||
      clientX < listRect.left - 80 ||
      clientX > listRect.right + 80
    ) {
      return null;
    }
    return items.length;
  };

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragRef.current = { id, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) > 4) {
      drag.moved = true;
      setDraggingId(drag.id);
    }
    if (drag.moved) setDropIndex(computeDropIndex(event.clientX, event.clientY));
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const target = drag?.moved ? computeDropIndex(event.clientX, event.clientY) : null;
    dragRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
    if (!drag?.moved || target == null) return;
    const from = blocks.findIndex((block) => block.id === drag.id);
    if (from < 0) return;
    let to = target;
    if (from < to) to -= 1; // removing the dragged block shifts later indices left
    if (to === from) return;
    pushHistory();
    commit(moveItem(blocks, from, to));
  };
  const cancelDrag = () => {
    dragRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
  };

  const renderIndicator = (at: number) =>
    draggingId && dropIndex === at ? (
      <div className="markdown-drop-indicator" aria-hidden="true" />
    ) : null;

  return (
    <section className="markdown-block-editor" aria-label={zh ? "Markdown 內容" : "Markdown content"} onKeyDown={handleHistoryShortcut}>
      <div className="markdown-block-list" ref={listRef}>
        {blocks.map((block, index) => (
          <React.Fragment key={block.id}>
            {renderIndicator(index)}
            <article
              data-markdown-block-id={block.id}
              className={`markdown-block ${draggingId === block.id ? "dragging" : ""}`}
            >
              <div className="markdown-block-tools">
                <button
                  type="button"
                  className="markdown-block-grip"
                  data-markdown-drag-handle
                  aria-label={zh ? `拖曳區塊 ${index + 1}` : `Drag block ${index + 1}`}
                  title={zh ? "拖曳排序（上下拖動）" : "Drag to reorder"}
                  onPointerDown={(event) => beginDrag(event, block.id)}
                  onPointerMove={moveDrag}
                  onPointerUp={finishDrag}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={() => {
                    if (dragRef.current?.id === block.id) cancelDrag();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveBlock(block.id, -1);
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveBlock(block.id, 1);
                    }
                  }}
                >
                  <GripVertical aria-hidden="true" />
                </button>
                <span className="markdown-block-move">
                  <button
                    type="button"
                    aria-label={zh ? "上移此區塊" : "Move block up"}
                    title={zh ? "上移（或按住把手 ↑）" : "Move up"}
                    disabled={index === 0}
                    onClick={() => moveBlock(block.id, -1)}
                  >
                    <ChevronUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={zh ? "下移此區塊" : "Move block down"}
                    title={zh ? "下移（或按住把手 ↓）" : "Move down"}
                    disabled={index === blocks.length - 1}
                    onClick={() => moveBlock(block.id, 1)}
                  >
                    <ChevronDown aria-hidden="true" />
                  </button>
                </span>
              </div>
              <div className="markdown-block-content">
                {editingId === block.id ? (
                  <textarea
                    autoFocus
                    value={block.source}
                    rows={Math.max(2, block.source.split("\n").length)}
                    aria-label={zh ? "編輯 Markdown 區塊" : "Edit Markdown block"}
                    onChange={(event) => updateBlock(block.id, event.target.value)}
                    onBlur={() => setEditingId(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" || (event.ctrlKey && event.key === "Enter")) {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : isTaskBlock(block.source) ? (
                  <div className="markdown-task-block">
                    {block.source.split("\n").map((line, lineIndex) => {
                      const match = line.match(TASK_LINE)!;
                      return (
                        <label key={`${block.id}:${lineIndex}`}>
                          <input
                            type="checkbox"
                            checked={match[2]!.toLowerCase() === "x"}
                            onChange={(event) => toggleTask(block.id, lineIndex, event.currentTarget.checked)}
                          />
                          <button type="button" onClick={() => setEditingId(block.id)}>{match[3]!.trim()}</button>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    className="markdown-block-preview"
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("a,button,input")) setEditingId(block.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setEditingId(block.id);
                      }
                    }}
                  >
                    <MarkdownPreview value={block.source} locale={locale} />
                  </div>
                )}
              </div>
              <button
                type="button"
                className="markdown-block-delete"
                aria-label={zh ? "刪除 Markdown 區塊" : "Delete Markdown block"}
                title={zh ? "刪除區塊（Ctrl+Z 可復原）" : "Delete block (Ctrl+Z to undo)"}
                onClick={() => removeBlock(block.id)}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </article>
          </React.Fragment>
        ))}
        {renderIndicator(blocks.length)}
      </div>
      {blocks.length === 0 && (
        <p className="markdown-block-empty">
          {zh ? "尚無詳細內容。用下方按鈕新增段落或待辦清單，像 Notion 一樣自由編排。" : "No detail yet. Add a paragraph or checklist below and arrange it freely."}
        </p>
      )}
      <button
        type="button"
        className="markdown-block-add"
        onClick={() => {
          pushHistory();
          const block = { id: newBlockId(), source: zh ? "新的段落" : "New paragraph" };
          commit([...blocks, block]);
          setEditingId(block.id);
        }}
      >
        <Plus aria-hidden="true" />
        {zh ? "新增區塊" : "Add block"}
      </button>
    </section>
  );
}
