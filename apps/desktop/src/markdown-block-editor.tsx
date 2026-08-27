import React, { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { MarkdownPreview, type MarkdownEditorLocale } from "./markdown-editor";

interface MarkdownBlock {
  id: string;
  source: string;
}

const TASK_LINE = /^(\s*[-*+]\s+)\[([ xX])\](\s*.*)$/;

/**
 * Line-start list/quote prefixes recognised while typing. The marker includes
 * its trailing space so continuations reproduce it verbatim; ordered numbers
 * are copied literally because rendering normalises them anyway.
 */
const LIST_PREFIX = /^(\s*)([-*+][ \t]+\[[ xX]\][ \t]?|[-*+][ \t]+|>[ \t]?|[0-9]+[.、][ \t]*)(.*)$/;

/**
 * Typing `- [ ] ` (or `[ ] `) followed by a space at the start of a block
 * converts it into a live checklist immediately — the one trigger whose empty
 * shell is itself meaningful UI.
 */
const TODO_INPUT_RULE = /^(\s*)([-*+][ \t]+)?\[[ xX]\][ \t]$/;

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
  // No per-source trimming: a block that legitimately ends with spaces must
  // keep serializing identically, otherwise the value-sync effect mistakes our
  // own output for an external edit and resets the editing state mid-stroke.
  return blocks.map((block) => block.source).filter((source) => source.trim()).join("\n\n");
}

function isTaskBlock(source: string): boolean {
  const lines = source.split("\n");
  return lines.length > 0 && lines.every((line) => TASK_LINE.test(line));
}

export type BlockKind =
  | "task"
  | "heading"
  | "bullet"
  | "ordered"
  | "quote"
  | "divider"
  | "code"
  | "paragraph";

export interface DerivedBlock {
  kind: BlockKind;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Detects the Notion-style flavour of a block from its raw Markdown source so
 * the editor can restyle the textarea live (e.g. `# Hello` becomes a big
 * heading the moment the user types the space) and pick the right non-edit
 * renderer. The markers stay in the source — Markdown is still the source of
 * truth — they just drive the visual treatment.
 */
export function deriveBlockKind(source: string): DerivedBlock {
  const lines = source.split("\n");
  const first = lines[0] ?? "";
  if (isTaskBlock(source)) return { kind: "task" };
  if (lines.length === 1 && /^---+$/.test(first.trim())) return { kind: "divider" };
  if (lines.length === 1) {
    const heading = first.match(/^(\s*)(#{1,6})\s+(.*)$/);
    if (heading) return { kind: "heading", level: heading[2]!.length as 1 | 2 | 3 | 4 | 5 | 6 };
    if (/^\s*```/.test(first)) return { kind: "code" };
  }
  if (lines.every((line) => /^\s*>/.test(line))) return { kind: "quote" };
  if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) return { kind: "bullet" };
  if (lines.every((line) => /^\s*\d+[.)、]\s+/.test(line))) return { kind: "ordered" };
  return { kind: "paragraph" };
}

function moveItem(items: MarkdownBlock[], from: number, to: number): MarkdownBlock[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (!moved) return items;
  next.splice(to, 0, moved);
  return next;
}

export interface ParsedListPrefix {
  indent: string;
  marker: string;
  content: string;
}

/** Splits a line into indentation, list marker (with trailing space) and content. */
export function parseListPrefix(line: string): ParsedListPrefix | null {
  const match = line.match(LIST_PREFIX);
  if (!match) return null;
  return { indent: match[1] ?? "", marker: match[2] ?? "", content: match[3] ?? "" };
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

  /** Leaves edit mode, dropping the block when it ended up empty. */
  const finishEditing = (id: string) => {
    const block = blocks.find((item) => item.id === id);
    if (block && !block.source.trim() && blocks.length > 1) {
      pushHistory();
      commit(blocks.filter((item) => item.id !== id));
    }
    setEditingId(null);
  };

  const addBlock = (afterIndex?: number, source = "") => {
    pushHistory();
    const block = { id: newBlockId(), source };
    const next = [...blocks];
    next.splice(afterIndex === undefined ? blocks.length : afterIndex + 1, 0, block);
    commit(next);
    setEditingId(block.id);
  };

  /**
   * Notion-style typing helpers inside a block textarea.
   * Returns true when the event was consumed.
   */
  const handleTextKeydown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    block: MarkdownBlock,
  ): boolean => {
    const textarea = event.currentTarget;
    // Chinese/Japanese IME confirmations arrive as Enter with isComposing set;
    // they must never be read as structural edits.
    if (event.nativeEvent.isComposing || (event.nativeEvent as { keyCode?: number }).keyCode === 229) return false;

    // Inline wrapping shortcuts.
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i")) {
      event.preventDefault();
      const prefix = event.key.toLowerCase() === "b" ? "**" : "*";
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = block.source.slice(start, end);
      const placeholder = selected || (prefix === "**" ? (zh ? "粗體文字" : "bold text") : (zh ? "斜體文字" : "italic text"));
      pushHistory();
      updateBlock(block.id, block.source.slice(0, start) + prefix + placeholder + prefix + block.source.slice(end));
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(start + prefix.length, start + prefix.length + placeholder.length);
      });
      return true;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return false;

    // `- [ ] ` + space becomes a live checklist straight away.
    if (event.key === " ") {
      const caret = textarea.selectionStart;
      const lineStart = block.source.lastIndexOf("\n", caret - 1) + 1;
      const prospective = block.source.slice(lineStart, caret) + " ";
      if (TODO_INPUT_RULE.test(prospective) && caret === block.source.length) {
        const normalized = `${prospective.trimEnd()} `;
        event.preventDefault();
        pushHistory();
        updateBlock(block.id, block.source.slice(0, lineStart) + normalized.replace(/^[-*+][ \t]+/, "- "));
        setEditingId(null);
        return true;
      }
      return false;
    }

    if (event.key !== "Enter" || event.shiftKey) return false;

    const caret = textarea.selectionStart;
    const lineStart = block.source.lastIndexOf("\n", caret - 1) + 1;
    const lineEndIndex = block.source.indexOf("\n", caret);
    const lineEnd = lineEndIndex === -1 ? block.source.length : lineEndIndex;
    const line = block.source.slice(lineStart, lineEnd);
    const relCaret = caret - lineStart;

    // ``` + Enter opens a fenced code block.
    if (line.trim() === "```") {
      event.preventDefault();
      pushHistory();
      updateBlock(block.id, `${block.source.slice(0, lineStart)}\`\`\`\n\n\`\`\``);
      setEditingId(null);
      return true;
    }

    // --- on its own line + Enter becomes a divider.
    if (/^\s*---\s*$/.test(line)) {
      event.preventDefault();
      pushHistory();
      updateBlock(block.id, `${block.source.slice(0, lineStart)}---`);
      setEditingId(null);
      return true;
    }

    const parsed = parseListPrefix(line);
    if (parsed) {
      event.preventDefault();
      if (parsed.content.trim() === "") {
        // Second Enter on an empty item drops the marker: back to plain text.
        pushHistory();
        const stripped = block.source.slice(0, lineStart) + parsed.indent + block.source.slice(lineEnd);
        updateBlock(block.id, stripped);
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(lineStart + parsed.indent.length, lineStart + parsed.indent.length);
        });
      } else {
        // Enter continues the list with the same marker.
        pushHistory();
        const before = line.slice(0, relCaret);
        const after = line.slice(relCaret);
        const insertion = `\n${parsed.indent}${parsed.marker}`;
        updateBlock(
          block.id,
          block.source.slice(0, lineStart) + before + insertion + after + block.source.slice(lineEnd),
        );
        const anchor = lineStart + before.length + insertion.length;
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(anchor, anchor);
        });
      }
      return true;
    }

    if (line.trim() === "") {
      // Empty paragraph: Enter closes the block without spawning empties.
      event.preventDefault();
      finishEditing(block.id);
      return true;
    }

    // Plain text: Enter commits the block (revealing its live preview) and
    // opens a fresh block right below for continued writing.
    event.preventDefault();
    pushHistory();
    const head = block.source.slice(0, lineStart + relCaret);
    const tail = block.source.slice(lineStart + relCaret);
    const created = { id: newBlockId(), source: tail };
    const next = blocks.flatMap((item) => item.id === block.id ? [{ ...item, source: head }, created] : [item]);
    commit(next);
    setEditingId(created.id);
    return true;
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
        {blocks.map((block, index) => {
          const { kind, level } = deriveBlockKind(block.source);
          const isEditing = editingId === block.id;
          const kindClass = `kind-${kind}${level ? `-h${level}` : ""}`;
          return (
          <React.Fragment key={block.id}>
            {renderIndicator(index)}
            <article
              data-markdown-block-id={block.id}
              data-block-kind={kind}
              className={`markdown-block ${kindClass} ${isEditing ? "editing" : ""} ${draggingId === block.id ? "dragging" : ""}`}
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
                <button
                  type="button"
                  className="markdown-block-add-inline"
                  aria-label={zh ? "在下方新增區塊" : "Add a block below"}
                  title={zh ? "新增區塊" : "Add block"}
                  onClick={() => addBlock(index)}
                >
                  <Plus aria-hidden="true" />
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
                {isEditing ? (
                  <textarea
                    autoFocus
                    value={block.source}
                    rows={1}
                    className={`markdown-block-input ${kindClass}`}
                    aria-label={zh ? "編輯 Markdown 區塊" : "Edit Markdown block"}
                    onChange={(event) => updateBlock(block.id, event.target.value)}
                    onBlur={() => finishEditing(block.id)}
                    ref={(element) => {
                      if (!element) return;
                      element.style.height = "auto";
                      element.style.height = `${element.scrollHeight}px`;
                    }}
                    onKeyDown={(event) => {
                      if (handleTextKeydown(event, block)) return;
                      if (event.key === "Escape" || (event.ctrlKey && event.key === "Enter")) {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : kind === "task" ? (
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
                ) : kind === "divider" ? (
                  <div
                    className="markdown-block-divider"
                    role="separator"
                    tabIndex={0}
                    onClick={() => setEditingId(block.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEditingId(block.id); }
                    }}
                  />
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
          );
        })}
        {renderIndicator(blocks.length)}
      </div>
      {blocks.length === 0 && (
        <p className="markdown-block-empty">
          {zh
            ? "尚無詳細內容。直接輸入文字，按 Enter 建立下一個區塊；行首打「- [ ] 」變待辦清單、「# 」變標題、「---」變分隔線，像 Notion 一樣自由編排。"
            : "No detail yet. Type freely and press Enter for the next block; start a line with “- [ ] ” for a checklist, “# ” for a heading, “---” for a divider."}
        </p>
      )}
      <button
        type="button"
        className="markdown-block-add"
        onClick={() => addBlock()}
      >
        <Plus aria-hidden="true" />
        {zh ? "新增區塊" : "Add block"}
      </button>
    </section>
  );
}
