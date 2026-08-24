import React, { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { MarkdownPreview, type MarkdownEditorLocale } from "./markdown-editor";

interface MarkdownBlock {
  id: string;
  source: string;
}

const TASK_LINE = /^(\s*[-*+]\s+)\[([ xX])\](\s*.*)$/;

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

export function MarkdownBlockEditor({
  value,
  onChange,
  locale = "zh-TW",
}: {
  value: string;
  onChange: (value: string) => void;
  locale?: MarkdownEditorLocale;
}) {
  const [blocks, setBlocks] = useState<MarkdownBlock[]>(() => createBlocks(value));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; startY: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (value !== serializeBlocks(blocks)) {
      setBlocks(createBlocks(value));
      setEditingId(null);
    }
  }, [value]);

  const commit = (next: MarkdownBlock[]) => {
    setBlocks(next);
    onChange(serializeBlocks(next));
  };
  const updateBlock = (id: string, source: string) => {
    commit(blocks.map((block) => block.id === id ? { ...block, source } : block));
  };
  const removeBlock = (id: string) => {
    commit(blocks.filter((block) => block.id !== id));
    if (editingId === id) setEditingId(null);
  };
  const toggleTask = (blockId: string, lineIndex: number, checked: boolean) => {
    const block = blocks.find((item) => item.id === blockId);
    if (!block) return;
    const lines = block.source.split("\n");
    lines[lineIndex] = lines[lineIndex]!.replace(TASK_LINE, (_line, prefix: string, _checked: string, content: string) => `${prefix}[${checked ? "x" : " "}]${content}`);
    updateBlock(blockId, lines.join("\n"));
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
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    if (!drag?.moved) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-markdown-block-id]");
    const targetId = target?.dataset.markdownBlockId;
    if (!targetId || targetId === drag.id) return;
    const from = blocks.findIndex((block) => block.id === drag.id);
    const to = blocks.findIndex((block) => block.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    commit(next);
  };
  const cancelDrag = () => {
    dragRef.current = null;
    setDraggingId(null);
  };

  return (
    <section className="markdown-block-editor" aria-label={locale === "zh-TW" ? "Markdown 內容" : "Markdown content"}>
      <div className="markdown-block-list">
        {blocks.map((block) => (
          <article
            key={block.id}
            data-markdown-block-id={block.id}
            className={`markdown-block ${draggingId === block.id ? "dragging" : ""}`}
          >
            <button
              type="button"
              className="markdown-block-grip"
              data-markdown-drag-handle
              aria-label={locale === "zh-TW" ? "拖曳 Markdown 區塊" : "Drag Markdown block"}
              title={locale === "zh-TW" ? "拖曳區塊" : "Drag block"}
              onPointerDown={(event) => beginDrag(event, block.id)}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={cancelDrag}
              onLostPointerCapture={() => {
                if (dragRef.current?.id === block.id) cancelDrag();
              }}
            >
              <GripVertical aria-hidden="true" />
            </button>
            <div className="markdown-block-content">
              {editingId === block.id ? (
                <textarea
                  autoFocus
                  value={block.source}
                  rows={Math.max(2, block.source.split("\n").length)}
                  aria-label={locale === "zh-TW" ? "編輯 Markdown 區塊" : "Edit Markdown block"}
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
                  {block.source.split("\n").map((line, index) => {
                    const match = line.match(TASK_LINE)!;
                    return (
                      <label key={`${block.id}:${index}`}>
                        <input
                          type="checkbox"
                          checked={match[2]!.toLowerCase() === "x"}
                          onChange={(event) => toggleTask(block.id, index, event.currentTarget.checked)}
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
              aria-label={locale === "zh-TW" ? "刪除 Markdown 區塊" : "Delete Markdown block"}
              title={locale === "zh-TW" ? "刪除區塊" : "Delete block"}
              onClick={() => removeBlock(block.id)}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
      <button
        type="button"
        className="markdown-block-add"
        onClick={() => {
          const block = { id: newBlockId(), source: locale === "zh-TW" ? "新的段落" : "New paragraph" };
          commit([...blocks, block]);
          setEditingId(block.id);
        }}
      >
        <Plus aria-hidden="true" />
        {locale === "zh-TW" ? "新增區塊" : "Add block"}
      </button>
    </section>
  );
}
