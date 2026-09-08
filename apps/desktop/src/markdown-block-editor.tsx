import React, { useEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Code2, Copy, GripVertical, Palette, Paperclip, Plus, Repeat2, Trash2 } from "lucide-react";
import { ATTACHMENT_ACCEPT, parseStandaloneAttachment, withAttachmentImageWidth } from "@second-brain/brain-core";
import { MarkdownPreview, VaultAttachmentView, type MarkdownEditorLocale } from "./markdown-editor";
import { dropHasFiles, filesFromDrop, snippetsFromFiles, useVaultAttachments } from "./attachment-context";
import { GLOBAL_SELECTION_DELETE_EVENT } from "./global-shift-marquee";

interface MarkdownBlock {
  id: string;
  source: string;
  rowId?: string;
  col?: number;
  colWidths?: number[];
}

interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

type BlockColor = "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

interface BlockStyle {
  color: BlockColor;
  background: BlockColor;
}

const DEFAULT_BLOCK_STYLE: BlockStyle = { color: "default", background: "default" };
const BLOCK_STYLE_MARKER = /\n?<!-- sbw:block-style color=(default|gray|brown|orange|yellow|green|blue|purple|pink|red) background=(default|gray|brown|orange|yellow|green|blue|purple|pink|red) -->\s*$/;

/** Block colours live in an ignored HTML comment so ordinary Markdown readers stay clean. */
export function parseStyledBlock(source: string): { content: string; style: BlockStyle } {
  const match = source.match(BLOCK_STYLE_MARKER);
  if (!match) return { content: source, style: DEFAULT_BLOCK_STYLE };
  return {
    content: source.slice(0, match.index).replace(/\n$/, ""),
    style: { color: match[1] as BlockColor, background: match[2] as BlockColor },
  };
}

function withBlockStyle(content: string, style: BlockStyle): string {
  if (style.color === "default" && style.background === "default") return content;
  return `${content}${content ? "\n" : ""}<!-- sbw:block-style color=${style.color} background=${style.background} -->`;
}

const TASK_LINE = /^(\s*[-*+]\s+)\[([ xX])\](\s*.*)$/;
const TASK_IDENTITY_COMMENT = /\s*<!--\s*(?:publisher-task|second-brain-task):\{[\s\S]*?\}\s*-->\s*$/;

/** `#task` and the identity HTML comment stay in the file; they are not title text. */
export function splitTaskIdentity(afterCheckbox: string): { lead: string; visible: string; trail: string } {
  let rest = afterCheckbox.replace(/^\s+/, "");
  const leadMatch = rest.match(/^#task\b[ \t]*/);
  const lead = leadMatch ? leadMatch[0] : "";
  if (leadMatch) rest = rest.slice(lead.length);
  const trailMatch = rest.match(TASK_IDENTITY_COMMENT);
  const trail = trailMatch ? ` ${trailMatch[0].trim()}` : "";
  const visible = (trailMatch ? rest.slice(0, trailMatch.index) : rest).replace(/\s+$/, "");
  return { lead, visible, trail };
}

export function composeTaskLine(prefix: string, checked: string, afterCheckbox: string, visible: string): string {
  const { lead, trail } = splitTaskIdentity(afterCheckbox);
  const token = lead ? "#task" : "";
  const body = [token, visible].filter((part) => part.length > 0).join(" ");
  if (!body && !trail) return `${prefix}[${checked}] `;
  return `${prefix}[${checked}] ${body}${trail}`;
}

/**
 * Line-start list/quote prefixes recognised while typing. The marker includes
 * its trailing space so continuations reproduce it verbatim; ordered numbers
 * are copied literally because rendering normalises them anyway.
 */
const LIST_PREFIX = /^(\s*)([-*+][ \t]+\[[ xX]\][ \t]?|[-*+][ \t]+|>[ \t]?|[0-9]+[.、][ \t]*)(.*)$/;

/** Structural edits are undoable inside the editor; textareas keep native undo. */
const EDITOR_HISTORY_LIMIT = 50;

/** Keeps the floating block menu inside the viewport and flips it above tight rows. */
export function blockMenuPlacement(
  rect: Pick<DOMRect, "left" | "top" | "bottom">,
  viewportWidth: number,
  viewportHeight: number,
): CSSProperties {
  const menuWidth = Math.min(300, viewportWidth - 24);
  const spaceBelow = viewportHeight - rect.bottom - 12;
  const spaceAbove = rect.top - 12;
  const opensUp = spaceBelow < 320 && spaceAbove > spaceBelow;
  return {
    left: Math.max(12, Math.min(rect.left, viewportWidth - menuWidth - 12)),
    width: menuWidth,
    maxHeight: Math.min(520, Math.max(180, opensUp ? spaceAbove : spaceBelow)),
    ...(opensUp
      ? { bottom: viewportHeight - rect.top + 4, top: "auto" }
      : { top: rect.bottom + 4, bottom: "auto" }),
  };
}

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

/** Tight notes (no blank lines) still become one Notion-like block per
 *  structural line: headings, bullets, todos, quotes, dividers. Clicking a
 *  heading then edits the title, not a blob of `##` / `- ` markers. */
function isStandaloneBlockLine(line: string): boolean {
  if (TASK_LINE.test(line)) return true;
  if (/^\s*#{1,6}\s+/.test(line)) return true;
  if (/^\s*[-*+]\s+/.test(line)) return true;
  if (/^\s*\d+[.)、]\s+/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  return /^---+$/.test(line.trim());
}

export function splitTaskAwareBlocks(value: string): string[] {
  const out: string[] = [];
  for (const block of splitMarkdownBlocks(value)) {
    const trimmed = block.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      out.push(block);
      continue;
    }
    const buffer: string[] = [];
    const flush = () => {
      if (buffer.length > 0) out.push(buffer.join("\n"));
      buffer.length = 0;
    };
    for (const line of block.split("\n")) {
      if (isStandaloneBlockLine(line)) {
        flush();
        out.push(line);
      } else {
        buffer.push(line);
      }
    }
    flush();
  }
  return out;
}

function createBlocks(value: string): MarkdownBlock[] {
  const created = parseDocumentChunks(value).map((item) => ({
    id: newBlockId(),
    source: item.source,
    rowId: item.rowId,
    col: item.col,
    colWidths: item.widths,
  }));
  return created.length > 0 ? created : [{ id: newBlockId(), source: "" }];
}

/** Reuse existing block ids when an external `value` matches current sources, so a
 *  parent re-render never remounts the textarea mid-stroke (Notion-like typing). */
function syncBlocks(previous: MarkdownBlock[], value: string): MarkdownBlock[] {
  const items = parseDocumentChunks(value);
  if (items.length === 0) {
    const empty = previous.find((block) => !block.source.trim()) ?? previous[0];
    return [{ id: empty?.id ?? newBlockId(), source: "" }];
  }
  const unused = [...previous];
  return items.map((item) => {
    const matchIndex = unused.findIndex((block) => block.source === item.source && block.rowId === item.rowId && block.col === item.col);
    if (matchIndex >= 0) {
      const [match] = unused.splice(matchIndex, 1);
      return { ...match!, rowId: item.rowId, col: item.col, colWidths: item.widths };
    }
    return { id: newBlockId(), source: item.source, rowId: item.rowId, col: item.col, colWidths: item.widths };
  });
}

const ROW_START = /^<!--\s*sbw:row\s+(\S+)\s+([\d.]+(?:\s+[\d.]+)*)\s*-->$/;
const ROW_COL = /^<!--\s*sbw:col\s*-->$/;
const ROW_END = /^<!--\s*sbw:row-end\s*-->$/;

function equalColWidths(count: number): number[] {
  const base = Math.floor(100 / count);
  const widths = Array.from({ length: count }, () => base);
  widths[count - 1] = 100 - base * (count - 1);
  return widths;
}

export function parseDocumentChunks(value: string): Array<{ source: string; rowId?: string; col?: number; widths?: number[] }> {
  const out: Array<{ source: string; rowId?: string; col?: number; widths?: number[] }> = [];
  let rowId: string | undefined;
  let col = 0;
  let widths: number[] | undefined;
  let colHasContent = false;
  const flushEmptyCol = () => {
    if (rowId && !colHasContent) {
      out.push({ source: "", rowId, col, widths });
    }
  };
  for (const chunk of splitTaskAwareBlocks(value)) {
    const line = chunk.trim();
    const start = line.match(ROW_START);
    if (start) {
      rowId = start[1];
      widths = start[2]!.split(/\s+/).map(Number);
      col = 0;
      colHasContent = false;
      continue;
    }
    if (line === "<!-- sbw:slot -->") {
      out.push({ source: "", rowId, col: rowId ? col : undefined, widths: rowId ? widths : undefined });
      colHasContent = true;
      continue;
    }
    if (ROW_COL.test(line)) {
      flushEmptyCol();
      col += 1;
      colHasContent = false;
      continue;
    }
    if (ROW_END.test(line)) {
      flushEmptyCol();
      rowId = undefined;
      col = 0;
      widths = undefined;
      colHasContent = false;
      continue;
    }
    out.push({ source: chunk, rowId, col: rowId ? col : undefined, widths: rowId ? widths : undefined });
    colHasContent = true;
  }
  return out;
}

function serializeBlocks(blocks: MarkdownBlock[]): string {
  // No per-source trimming: a block that legitimately ends with spaces must
  // keep serializing identically, otherwise the value-sync effect mistakes our
  // own output for an external edit and resets the editing state mid-stroke.
  if (blocks.every((block) => !block.source.trim() && !block.rowId)) return "";
  const parts: string[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    if (!block.rowId) {
      parts.push(block.source.trim() ? block.source : "<!-- sbw:slot -->");
      index += 1;
      continue;
    }
    const rowId = block.rowId;
    const row: MarkdownBlock[] = [];
    while (index < blocks.length && blocks[index]?.rowId === rowId) {
      row.push(blocks[index]!);
      index += 1;
    }
    const colCount = Math.max(1, ...row.map((item) => (item.col ?? 0) + 1));
    const widths = row[0]?.colWidths ?? equalColWidths(colCount);
    parts.push(`<!-- sbw:row ${rowId} ${widths.join(" ")} -->`);
    for (let col = 0; col < colCount; col += 1) {
      if (col > 0) parts.push("<!-- sbw:col -->");
      const cells = row.filter((entry) => (entry.col ?? 0) === col);
      if (cells.length === 0) parts.push("<!-- sbw:slot -->");
      for (const item of cells) {
        parts.push(item.source.trim() ? item.source : "<!-- sbw:slot -->");
      }
    }
    parts.push("<!-- sbw:row-end -->");
  }
  return parts.join("\n\n");
}

function placeBlockBeside(blocks: MarkdownBlock[], ids: readonly string[], targetId: string, side: "left" | "right"): MarkdownBlock[] {
  const moving = blocks.filter((block) => ids.includes(block.id));
  const rest = blocks.filter((block) => !ids.includes(block.id));
  const target = rest.find((block) => block.id === targetId);
  if (!target || moving.length === 0 || moving.some((block) => block.id === targetId)) return blocks;
  if (!target.rowId) {
    const rowId = newBlockId();
    const widths = equalColWidths(2);
    const targetCol = side === "left" ? 1 : 0;
    const moveCol = side === "left" ? 0 : 1;
    const nextTarget = { ...target, rowId, col: targetCol, colWidths: widths };
    const nextMoving = moving.map((block) => ({ ...block, rowId, col: moveCol, colWidths: widths }));
    return rest.flatMap((block) => {
      if (block.id !== target.id) return [block];
      return side === "left" ? [...nextMoving, nextTarget] : [nextTarget, ...nextMoving];
    });
  }
  const rowBlocks = rest.filter((block) => block.rowId === target.rowId);
  const colCount = Math.max(...rowBlocks.map((block) => (block.col ?? 0) + 1));
  if (colCount >= 4) return blocks;
  const insertCol = side === "left" ? (target.col ?? 0) : (target.col ?? 0) + 1;
  const widths = equalColWidths(colCount + 1);
  const shifted = rest.map((block) => {
    if (block.rowId !== target.rowId) return block;
    const col = block.col ?? 0;
    return { ...block, col: col >= insertCol ? col + 1 : col, colWidths: widths };
  });
  const nextMoving = moving.map((block) => ({ ...block, rowId: target.rowId, col: insertCol, colWidths: widths }));
  const insertAt = shifted.findIndex((block) => block.rowId === target.rowId && (block.col ?? 0) >= insertCol);
  const at = insertAt < 0 ? shifted.length : insertAt;
  return [...shifted.slice(0, at), ...nextMoving, ...shifted.slice(at)];
}

function reindexRow(blocks: MarkdownBlock[], rowId: string): MarkdownBlock[] {
  const cols = [...new Set(blocks.filter((block) => block.rowId === rowId).map((block) => block.col ?? 0))].sort((left, right) => left - right);
  if (cols.length <= 1) {
    return blocks.map((block) => (block.rowId === rowId ? { id: block.id, source: block.source } : block));
  }
  const remap = new Map(cols.map((col, index) => [col, index]));
  const widths = equalColWidths(cols.length);
  return blocks.map((block) => {
    if (block.rowId !== rowId) return block;
    return { ...block, col: remap.get(block.col ?? 0) ?? 0, colWidths: widths };
  });
}

function releaseFromRow(blocks: MarkdownBlock[], ids: readonly string[]): MarkdownBlock[] {
  const rowIds = [...new Set(blocks.flatMap((block) => (ids.includes(block.id) && block.rowId ? [block.rowId] : [])))];
  let next = blocks.map((block) => (ids.includes(block.id) ? { id: block.id, source: block.source } : block));
  for (const rowId of rowIds) next = reindexRow(next, rowId);
  return next;
}

function rowTemplate(widths: number[]): string {
  return widths.flatMap((width, index) => (index === 0 ? [`minmax(0, ${width}fr)`] : ["8px", `minmax(0, ${width}fr)`])).join(" ");
}

function isTaskBlock(source: string): boolean {
  const lines = parseStyledBlock(source).content.split("\n");
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
  source = parseStyledBlock(source).content;
  const lines = source.split("\n");
  const first = lines[0] ?? "";
  if (isTaskBlock(source)) return { kind: "task" };
  if (lines.length === 1 && /^---+$/.test(first.trim())) return { kind: "divider" };
  const trimmed = source.trim();
  if ((trimmed.startsWith("```") && trimmed.endsWith("```") && lines.length > 1)
    || (trimmed.startsWith("~~~") && trimmed.endsWith("~~~") && lines.length > 1)) return { kind: "code" };
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

function moveBlockSelection(items: MarkdownBlock[], selectedIds: readonly string[], targetIndex: number): MarkdownBlock[] {
  const selected = new Set(selectedIds);
  const moving = items.filter((item) => selected.has(item.id));
  if (moving.length === 0) return items;
  const remaining = items.filter((item) => !selected.has(item.id));
  const insertionIndex = items.slice(0, targetIndex).filter((item) => !selected.has(item.id)).length;
  const next = [...remaining.slice(0, insertionIndex), ...moving, ...remaining.slice(insertionIndex)];
  return next.every((item, index) => item.id === items[index]?.id) ? items : next;
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

type SlashAction =
  | { kind: "turn"; value: "text" | "h1" | "h2" | "h3" | "h4" | "todo" | "bullet" | "number" | "quote" | "code" | "divider" }
  | { kind: "color" | "background"; value: BlockColor };

interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  action: SlashAction;
}

function stripBlockPrefix(content: string): string {
  const task = content.match(TASK_LINE);
  if (task) return splitTaskIdentity(task[3] ?? "").visible;
  return content
    .replace(/^\s*(```|~~~)\s*\n?/, "")
    .replace(/\n?\s*(```|~~~)\s*$/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)、]\s+/, "")
    .replace(/^\s*>\s*/, "");
}

/** Strip the line-start marker (`- `, `1. `, `> `, `# ` …) so the row preview
 *  shows just the content. Heading / paragraph blocks are returned as-is. */
function stripBlockPrefixForPreview(line: string, kind: BlockKind): string {
  if (kind === "heading") return line.replace(/^\s*#{1,6}\s+/, "");
  if (kind === "bullet") return line.replace(/^\s*[-*+]\s+/, "");
  if (kind === "ordered") return line.replace(/^\s*\d+[.)、]\s+/, "");
  if (kind === "quote") return line.replace(/^\s*>\s*/, "");
  return line;
}

function trailingSlash(content: string): { start: number; query: string } | null {
  const match = content.match(/(?:^|\s)\/([^/\n]*)$/);
  if (!match || match.index === undefined) return null;
  return { start: match.index + match[0].indexOf("/"), query: (match[1] ?? "").trim().toLowerCase() };
}

interface EditablePresentation {
  value: string;
  sourcePrefix: string;
  marker: string;
}

function editablePresentation(content: string, derived: DerivedBlock): EditablePresentation {
  if (content.includes("\n")) return { value: content, sourcePrefix: "", marker: "" };
  if (derived.kind === "heading") {
    const match = content.match(/^(\s*#{1,6}\s+)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, marker: "" };
  }
  if (derived.kind === "bullet") {
    const match = content.match(/^(\s*[-*+]\s+)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, marker: "•" };
  }
  if (derived.kind === "ordered") {
    const match = content.match(/^(\s*\d+[.)、]\s+)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, marker: match[1]!.trim() };
  }
  if (derived.kind === "quote") {
    const match = content.match(/^(\s*>\s*)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, marker: "" };
  }
  return { value: content, sourcePrefix: "", marker: "" };
}

export function MarkdownBlockEditor({
  value,
  onChange,
  locale = "zh-TW",
  attachmentFolder,
  maxAttachments,
}: {
  value: string;
  onChange: (value: string) => void;
  locale?: MarkdownEditorLocale;
  attachmentFolder?: string;
  maxAttachments?: number;
}) {
  const zh = locale === "zh-TW";
  const attachments = useVaultAttachments();
  const canAttach = Boolean(attachments && attachmentFolder);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [blocks, setBlocks] = useState<MarkdownBlock[]>(() => createBlocks(value));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [marqueeBox, setMarqueeBox] = useState<MarqueeBox | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const [blockMenuId, setBlockMenuId] = useState<string | null>(null);
  const [blockMenuPanel, setBlockMenuPanel] = useState<"root" | "turn" | "color">("root");
  const [blockMenuStyle, setBlockMenuStyle] = useState<CSSProperties>({});
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  // Index of the insertion gap currently highlighted while dragging (0 = before the
  // first block, blocks.length = after the last one).
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropColumn, setDropColumn] = useState<{ id: string; side: "left" | "right" } | null>(null);
  const dragRef = useRef<{ id: string; ids: string[]; startX: number; startY: number; moved: boolean } | null>(null);
  const marqueeOriginRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const suppressHandleClickRef = useRef(false);
  const suppressCanvasClickUntilRef = useRef(0);
  const editorRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  // IME (輸入法) Enter handling, modelled on how Notion-class editors treat
  // it (ProseMirror does the same with its compositionEndedAt timestamp):
  // - While the IME is composing (`isComposing` / keyCode 229) Enter belongs
  //   to the input method: never split the block, and never preventDefault —
  //   cancelling the browser default inside an active composition breaks the
  //   confirm on some IMEs.
  // - Some IMEs (notably 注音) re-dispatch the confirming Enter *immediately
  //   after* compositionend. That echo is identified by its timestamp sitting
  //   within ~100ms of the compositionend event and is cancelled so it
  //   neither splits the block nor inserts a newline. A tight timestamp
  //   window — not a long blanket timeout — keeps the very next real Enter
  //   (the one that creates the following todo) instant: one press, like
  //   Notion. The old 1.5s dark window swallowed 1-2 legitimate Enters and
  //   made line breaks feel like they needed four presses.
  const IME_ECHO_WINDOW_MS = 300;
  const imeCompositionEndedAtRef = useRef(0);
  const imeComposingRef = useRef(false);
  // Composition timing is a DOM-level concern, so compositionstart/end are
  // recorded through native listeners (attached with the textarea ref) instead
  // of React props: the flags are then in place before any following keydown
  // or delayed caret snap, independent of React's event delegation.
  const imeListeners = new WeakMap<HTMLTextAreaElement, { start: () => void; end: (event: CompositionEvent) => void }>();
  const bindImeEndListener = (element: HTMLTextAreaElement) => {
    const previous = imeListeners.get(element);
    if (previous) {
      element.removeEventListener("compositionstart", previous.start);
      element.removeEventListener("compositionend", previous.end);
    }
    const start = () => {
      imeComposingRef.current = true;
    };
    const end = (event: CompositionEvent) => {
      imeComposingRef.current = false;
      imeCompositionEndedAtRef.current = event.timeStamp;
    };
    imeListeners.set(element, { start, end });
    element.addEventListener("compositionstart", start);
    element.addEventListener("compositionend", end);
  };
  const placeCaretAtEndIfIdle = (element: HTMLTextAreaElement) => {
    // Moving the caret during 注音/IME composition commits the composing
    // character (a bopomofo letter) and some IMEs then echo Enter, which
    // splits the block. A second click works because composition is idle.
    if (imeComposingRef.current) return;
    try { element.focus({ preventScroll: true }); } catch { return; }
    if (imeComposingRef.current) return;
    try { element.setSelectionRange(element.value.length, element.value.length); } catch { /* unmounted */ }
  };
  const imeEnterDisposition = (event: ReactKeyboardEvent<HTMLTextAreaElement>): "confirm" | "echo" | false => {
    if (event.key !== "Enter" && event.key !== "Process") return false;
    const native = event.nativeEvent as KeyboardEvent & { keyCode?: number; isComposing?: boolean };
    if (event.key === "Process" || native.isComposing || native.keyCode === 229) return "confirm";
    const endedAt = imeCompositionEndedAtRef.current;
    if (endedAt > 0 && Math.abs(event.timeStamp - endedAt) < IME_ECHO_WINDOW_MS) return "echo";
    return false;
  };
  // Tracks the id of the block whose textarea was last focused so we can place
  // the caret at the end whenever the editor switches into editing mode for a
  // *different* block. Re-entering edit mode on the same block keeps the
  // existing caret (the user clicked back into a specific spot).
  const lastFocusedBlockRef = useRef<string | null>(null);
  /** Auto-size a textarea and place the caret at the end of its current value. */
  const bindTextareaRef = (blockId: string) => (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    bindImeEndListener(element);
    if (lastFocusedBlockRef.current !== blockId) {
      lastFocusedBlockRef.current = blockId;
      // Defer past React's autoFocus commit so the caret lands after focus,
      // not before (Chromium otherwise resets the selection to 0).
      const focus = () => placeCaretAtEndIfIdle(element);
      // Two animation frames are safer than one: the first waits for
      // React to commit, the second waits for Chromium to settle the
      // selection that autoFocus inserted.
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => window.requestAnimationFrame(focus));
      } else {
        window.setTimeout(focus, 0);
      }
    }
  };

  // Whenever the editor switches the active block, re-snap the caret to
  // the end of *that* block's value. React's `autoFocus` only fires on the
  // first render, and on later renders the focused element does not get
  // re-focused — which means the previous selection (or default 0) leaks
  // into the freshly mounted textarea.
  useEffect(() => {
    imeComposingRef.current = false;
    if (!editingId) return;
    const escape = (value: string) =>
      typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
    const placeCaretAtEnd = () => {
      const element = listRef.current?.querySelector<HTMLTextAreaElement>(`[data-markdown-block-id="${escape(editingId)}"] .markdown-block-input`);
      if (!element) return;
      placeCaretAtEndIfIdle(element);
    };
    // Wait a frame for the value to settle (React commit + the value
    // attribute write) before measuring the length, otherwise the caret
    // snaps to the *previous* block's length.
    const raf = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(() => window.requestAnimationFrame(placeCaretAtEnd))
      : window.setTimeout(placeCaretAtEnd, 0);
    return () => {
      if (typeof raf === "number" && typeof window !== "undefined") window.cancelAnimationFrame(raf);
    };
  }, [editingId]);

  const colorNames: Array<[BlockColor, string, string]> = zh
    ? [["default", "預設", "default"], ["gray", "灰色", "gray grey"], ["brown", "棕色", "brown"], ["orange", "橘色", "orange"], ["yellow", "黃色", "yellow"], ["green", "綠色", "green"], ["blue", "藍色", "blue"], ["purple", "紫色", "purple"], ["pink", "粉色", "pink"], ["red", "紅色", "red"]]
    : [["default", "Default", "default"], ["gray", "Gray", "gray grey"], ["brown", "Brown", "brown"], ["orange", "Orange", "orange"], ["yellow", "Yellow", "yellow"], ["green", "Green", "green"], ["blue", "Blue", "blue"], ["purple", "Purple", "purple"], ["pink", "Pink", "pink"], ["red", "Red", "red"]];
  const slashCommands: SlashCommand[] = [
    { id: "text", label: zh ? "文字" : "Text", hint: zh ? "一般文字區塊" : "Plain text block", keywords: "text plain 文字 段落", action: { kind: "turn", value: "text" } },
    { id: "h1", label: zh ? "標題 1" : "Heading 1", hint: zh ? "大型標題" : "Large heading", keywords: "h1 heading title 標題", action: { kind: "turn", value: "h1" } },
    { id: "h2", label: zh ? "標題 2" : "Heading 2", hint: zh ? "中型標題" : "Medium heading", keywords: "h2 heading subtitle 標題", action: { kind: "turn", value: "h2" } },
    { id: "h3", label: zh ? "標題 3" : "Heading 3", hint: zh ? "小型標題" : "Small heading", keywords: "h3 heading 標題", action: { kind: "turn", value: "h3" } },
    { id: "h4", label: zh ? "標題 4" : "Heading 4", hint: zh ? "最小標題" : "Smallest heading", keywords: "h4 heading 標題", action: { kind: "turn", value: "h4" } },
    { id: "todo", label: zh ? "待辦清單" : "To-do list", hint: zh ? "可勾選的工作項目" : "Track a task with a checkbox", keywords: "todo checkbox task 待辦 核取", action: { kind: "turn", value: "todo" } },
    { id: "bullet", label: zh ? "項目符號清單" : "Bulleted list", hint: zh ? "建立簡單清單" : "Create a simple list", keywords: "bullet list 清單 項目", action: { kind: "turn", value: "bullet" } },
    { id: "number", label: zh ? "編號清單" : "Numbered list", hint: zh ? "依序排列項目" : "Create an ordered list", keywords: "number ordered list 編號 清單", action: { kind: "turn", value: "number" } },
    { id: "quote", label: zh ? "引言" : "Quote", hint: zh ? "醒目引用文字" : "Capture a quote", keywords: "quote 引言 引用", action: { kind: "turn", value: "quote" } },
    { id: "code", label: zh ? "程式碼" : "Code", hint: zh ? "等寬程式碼區塊" : "Monospaced code block", keywords: "code fence 程式碼", action: { kind: "turn", value: "code" } },
    { id: "divider", label: zh ? "分隔線" : "Divider", hint: zh ? "分隔內容區段" : "Visually divide blocks", keywords: "divider rule line 分隔線", action: { kind: "turn", value: "divider" } },
    ...colorNames.map(([value, name, keywords]) => ({ id: `color-${value}`, label: zh ? `${name}文字` : `${name} text`, hint: zh ? "設定整個區塊的文字顏色" : "Color this block's text", keywords: `${keywords} color text 顏色 文字`, action: { kind: "color" as const, value } })),
    ...colorNames.map(([value, name, keywords]) => ({ id: `background-${value}`, label: zh ? `${name}底色` : `${name} background`, hint: zh ? "設定整個區塊的背景色" : "Highlight this block", keywords: `${keywords} background highlight 底色 背景`, action: { kind: "background" as const, value } })),
  ];
  const blockCommands = slashCommands.filter((command) => command.action.kind === "turn");

  const filteredCommands = (query: string) => slashCommands.filter((command) => {
    const haystack = `${command.label} ${command.keywords}`.toLowerCase();
    return !query || query.split(/\s+/).every((part) => haystack.includes(part));
  }).slice(0, 12);

  useEffect(() => {
    if (value === serializeBlocks(blocks)) return;
    const next = syncBlocks(blocks, value);
    setBlocks(next);
    setEditingId((current) => {
      if (current && next.some((block) => block.id === current)) return current;
      return value.trim() ? null : next[0]?.id ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const available = new Set(blocks.map((block) => block.id));
    setSelectedBlockIds((selected) => {
      const next = selected.filter((id) => available.has(id));
      return next.length === selected.length ? selected : next;
    });
  }, [blocks]);

  // Listen for delete-selection requests from the global shift marquee: a user
  // who blue-rectangle-selected blocks across panels and pressed Delete expects
  // every block here to vanish in one undoable step.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ ids: string[]; kind: string }>).detail;
      if (!detail || detail.kind !== "markdown-block") return;
      const targets = new Set(detail.ids);
      const survivors = blocks.filter((block) => !targets.has(block.id));
      if (survivors.length === blocks.length) return;
      pushHistory();
      if (survivors.length === 0) {
        const replacement = { id: newBlockId(), source: "" };
        commit([replacement]);
        setEditingId(replacement.id);
      } else {
        commit(survivors);
        if (editingId && targets.has(editingId)) {
          const next = blocks.find((block) => !targets.has(block.id));
          setEditingId(next ? next.id : null);
        }
      }
      setSelectedBlockIds([]);
    };
    window.addEventListener(GLOBAL_SELECTION_DELETE_EVENT, handler as EventListener);
    return () => window.removeEventListener(GLOBAL_SELECTION_DELETE_EVENT, handler as EventListener);
  }, [blocks, editingId]);

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
  // Delete/Backspace with selected blocks removes them in one undoable step.
  const handleHistoryShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selectedBlockIds.length > 0) {
      event.preventDefault();
      setSelectedBlockIds([]);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedBlockIds.length > 0) {
      const target = event.target as HTMLElement;
      // Inside a textarea, only batch-delete when the caret is collapsed;
      // a real text selection there should still delete the selected text.
      if (target.tagName === "TEXTAREA") {
        const textarea = target as HTMLTextAreaElement;
        if (textarea.selectionStart !== textarea.selectionEnd) return;
      } else if (target.tagName === "INPUT") {
        return;
      }
      event.preventDefault();
      const targets = new Set(selectedBlockIds);
      const survivors = blocks.filter((block) => !targets.has(block.id));
      if (survivors.length === blocks.length) return;
      pushHistory();
      if (survivors.length === 0) {
        const replacement = { id: newBlockId(), source: "" };
        commit([replacement]);
        setEditingId(replacement.id);
      } else {
        commit(survivors);
        if (editingId && targets.has(editingId)) {
          const next = blocks.find((block) => !targets.has(block.id));
          setEditingId(next ? next.id : null);
        }
      }
      setSelectedBlockIds([]);
      return;
    }
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
  const updateBlockContent = (block: MarkdownBlock, content: string, style = parseStyledBlock(block.source).style) => {
    updateBlock(block.id, withBlockStyle(content, style));
  };
  const applyBlockStyle = (block: MarkdownBlock, style: BlockStyle) => {
    pushHistory();
    updateBlockContent(block, parseStyledBlock(block.source).content, style);
    setBlockMenuId(null);
  };
  const runSlashCommand = (block: MarkdownBlock, command: SlashCommand) => {
    const styled = parseStyledBlock(block.source);
    const slash = trailingSlash(styled.content);
    const before = (slash ? styled.content.slice(0, slash.start) : styled.content).trimEnd();
    pushHistory();
    if (command.action.kind === "color" || command.action.kind === "background") {
      const style = { ...styled.style, [command.action.kind]: command.action.value };
      updateBlockContent(block, before, style);
      setActiveCommand(0);
      return;
    }
    const plain = stripBlockPrefix(before);
    const next = command.action.value === "text" ? plain
      : command.action.value === "h1" ? `# ${plain}`
      : command.action.value === "h2" ? `## ${plain}`
      : command.action.value === "h3" ? `### ${plain}`
      : command.action.value === "h4" ? `#### ${plain}`
      : command.action.value === "todo" ? `- [ ] ${plain}`
      : command.action.value === "bullet" ? `- ${plain}`
      : command.action.value === "number" ? `1. ${plain}`
      : command.action.value === "quote" ? `> ${plain}`
      : command.action.value === "code" ? `\`\`\`\n${plain}\n\`\`\``
      : "---";
    updateBlockContent(block, next);
    setActiveCommand(0);
    if (command.action.value === "divider") setEditingId(null);
  };
  const updateTypedBlock = (block: MarkdownBlock, source: string) => {
    // Marker-only blocks become their final visual form as soon as the last
    // marker character lands. Heading/list/quote markers already restyle the
    // live textarea on their trailing space through deriveBlockKind().
    if (/^\s*```$/.test(source)) {
      pushHistory();
      updateBlockContent(block, "```\n\n```");
      setEditingId(null);
      return;
    }
    if (/^\s*---$/.test(source)) {
      pushHistory();
      updateBlockContent(block, "---");
      setEditingId(null);
      return;
    }
    // Notion-style: typing `[] ` (bracket + space) on an empty line turns
    // the line into a todo task without the user having to type `-` first.
    if (/^\s*\[\]\s$/.test(source)) {
      const replacement = source.replace(/^(\s*)\[\]\s/, "$1- [ ] ");
      pushHistory();
      updateBlockContent(block, replacement);
      return;
    }
    updateBlockContent(block, source);
  };
  const removeBlock = (id: string) => {
    const target = blocks.find((block) => block.id === id);
    if (!target) return;
    pushHistory();
    const remaining = blocks.filter((block) => block.id !== id);
    commit(target.rowId ? reindexRow(remaining, target.rowId) : remaining);
    if (editingId === id) setEditingId(null);
  };
  const toggleTask = (blockId: string, lineIndex: number, checked: boolean) => {
    const block = blocks.find((item) => item.id === blockId);
    if (!block) return;
    pushHistory();
    const styled = parseStyledBlock(block.source);
    const lines = styled.content.split("\n");
    lines[lineIndex] = lines[lineIndex]!.replace(TASK_LINE, (_line, prefix: string, _checked: string, content: string) => `${prefix}[${checked ? "x" : " "}]${content}`);
    updateBlock(blockId, withBlockStyle(lines.join("\n"), styled.style));
  };
  const moveBlock = (id: string, delta: -1 | 1) => {
    const from = blocks.findIndex((block) => block.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= blocks.length) return;
    pushHistory();
    commit(moveItem(blocks, from, to));
  };
  const duplicateBlock = (id: string) => {
    const index = blocks.findIndex((block) => block.id === id);
    if (index < 0) return;
    pushHistory();
    const copy = { id: newBlockId(), source: blocks[index]!.source };
    const next = [...blocks];
    next.splice(index + 1, 0, copy);
    commit(next);
    setBlockMenuId(null);
    setBlockMenuPanel("root");
  };

  /** Leaves edit mode. Empty blocks stay so they can be dragged into columns. */
  const finishEditing = (id: string) => {
    setEditingId((current) => (current === id ? null : current));
  };

  const addBlock = (afterIndex?: number, source = "") => {
    pushHistory();
    const after = afterIndex === undefined ? undefined : blocks[afterIndex];
    const block = {
      id: newBlockId(),
      source,
      rowId: after?.rowId,
      col: after?.col,
      colWidths: after?.colWidths,
    };
    const next = [...blocks];
    next.splice(afterIndex === undefined ? blocks.length : afterIndex + 1, 0, block);
    commit(next);
    setEditingId(block.id);
  };
  const insertSnippets = (snippets: string[]) => {
    if (snippets.length === 0) return;
    pushHistory();
    const created = snippets.map((source) => ({ id: newBlockId(), source }));
    const empty = blocks.length === 0 || (blocks.length === 1 && !parseStyledBlock(blocks[0]!.source).content.trim());
    commit(empty ? created : [...blocks, ...created]);
  };
  const importFiles = (files: File[]) => {
    if (!attachments || !attachmentFolder) return;
    void snippetsFromFiles(attachments, attachmentFolder, files, value, locale, maxAttachments).then(insertSnippets);
  };
  const onDragOver = (event: ReactDragEvent) => {
    if (!canAttach || !dropHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: ReactDragEvent) => {
    const files = filesFromDrop(event);
    if (!canAttach || files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    importFiles(files);
  };

  /**
   * Notion-style typing helpers inside a block textarea.
   * Returns true when the event was consumed.
   */
  const handleTextKeydown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    block: MarkdownBlock,
    visibleOffset = 0,
  ): boolean => {
    const textarea = event.currentTarget;
    const source = parseStyledBlock(block.source).content;
    // Chinese/Japanese IME confirmations arrive as Enter with isComposing set;
    // they must never be read as structural edits. (The IME gate in the
    // textarea's onKeyDown already routed composing/echo Enters away, so this
    // is only a safety net and never cancels the browser default.)

    const slash = trailingSlash(source);
    const commandOptions = slash ? filteredCommands(slash.query) : [];
    const slashKey = slash ? `${block.id}:${source}` : null;
    if (slash && slashKey !== dismissedSlash && commandOptions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveCommand((current) => (current + delta + commandOptions.length) % commandOptions.length);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        runSlashCommand(block, commandOptions[Math.min(activeCommand, commandOptions.length - 1)]!);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlash(slashKey);
        return true;
      }
    }

    if (event.key === "Backspace" && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      const previousIndex = blocks.findIndex((item) => item.id === block.id) - 1;
      const previousBlock = previousIndex >= 0 ? blocks[previousIndex] : undefined;
      if (visibleOffset > 0 && source.length === visibleOffset) {
        // The line is just its list marker ("- " just typed): clear it.
        event.preventDefault();
        pushHistory();
        updateBlockContent(block, "");
        return true;
      }
      if (!previousBlock) return false;
      // Notion-style merge upward: the previous line's text joins this one at
      // the caret (its own list/todo marker never travels), the previous block
      // disappears, and the caret lands at the junction so further Backspaces
      // keep deleting the previous line's characters.
      event.preventDefault();
      const previousStyled = parseStyledBlock(previousBlock.source);
      const previousBody = previousStyled.content.includes("\n")
        ? previousStyled.content
        : stripBlockPrefix(previousStyled.content);
      const mergedSource = `${source.slice(0, visibleOffset)}${previousBody}${source.slice(visibleOffset)}`;
      pushHistory();
      const remaining = blocks.filter((item) => item.id !== previousBlock.id);
      const next = remaining.map((item) => item.id === block.id
        ? { ...item, source: withBlockStyle(mergedSource, parseStyledBlock(block.source).style) }
        : item);
      commit(next);
      // The textarea shows the content without the block's own marker, so the
      // junction sits at previousBody.length in textarea coordinates.
      const caretInTextarea = previousBody.length;
      requestAnimationFrame(() => {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(caretInTextarea, caretInTextarea);
      });
      return true;
    }

    // Notion-style merge: pressing Delete at the very end of a block (and
    // nothing selected) pulls the next block's content into the current one,
    // mirroring how a single physical paragraph is split across blocks. A
    // todo below donates its text without its `- [ ] ` marker, and an empty
    // todo simply disappears instead of smearing marker junk into the text.
    if (event.key === "Delete" && textarea.selectionStart === textarea.selectionEnd && textarea.selectionEnd + visibleOffset === source.length) {
      const currentIndex = blocks.findIndex((item) => item.id === block.id);
      const nextBlock = currentIndex >= 0 ? blocks[currentIndex + 1] : undefined;
      if (nextBlock) {
        event.preventDefault();
        const nextStyled = parseStyledBlock(nextBlock.source);
        const nextTaskMatch = nextStyled.content.match(TASK_LINE);
        const nextContent = nextTaskMatch ? (nextTaskMatch[3] ?? "").trim() : nextStyled.content;
        pushHistory();
        const caretInMerged = source.length - visibleOffset;
        const merged = nextContent ? source + nextContent : source;
        const remaining = blocks.filter((item) => item.id !== nextBlock.id);
        const next = remaining.map((item) => item.id === block.id
          ? { ...item, source: withBlockStyle(merged, parseStyledBlock(block.source).style) }
          : item);
        commit(next);
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(caretInMerged, caretInMerged);
        });
        return true;
      }
    }

    // Inline wrapping shortcuts.
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i")) {
      event.preventDefault();
      const prefix = event.key.toLowerCase() === "b" ? "**" : "*";
      const start = textarea.selectionStart + visibleOffset;
      const end = textarea.selectionEnd + visibleOffset;
      const selected = source.slice(start, end);
      const placeholder = selected || (prefix === "**" ? (zh ? "粗體文字" : "bold text") : (zh ? "斜體文字" : "italic text"));
      pushHistory();
      updateBlockContent(block, source.slice(0, start) + prefix + placeholder + prefix + source.slice(end));
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(start + prefix.length - visibleOffset, start + prefix.length + placeholder.length - visibleOffset);
      });
      return true;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return false;

    if (event.key !== "Enter" || event.shiftKey) return false;

    const caret = textarea.selectionStart + visibleOffset;
    const lineStart = source.lastIndexOf("\n", caret - 1) + 1;
    const lineEndIndex = source.indexOf("\n", caret);
    const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
    const line = source.slice(lineStart, lineEnd);
    const relCaret = caret - lineStart;

    // Notion-style shortcut: typing `[]` (with optional trailing space) on
    // an otherwise empty line and pressing space turns the line into a todo
    // task, mirroring how `- ` does the same for a bullet.
    if (/^\s*\[\]\s*$/.test(line)) {
      event.preventDefault();
      pushHistory();
      const replacement = `${source.slice(0, lineStart)}- [ ] ${source.slice(lineEnd)}`;
      updateBlockContent(block, replacement);
      requestAnimationFrame(() => {
        textarea.focus();
        const caretAt = lineStart + "- [ ] ".length - visibleOffset;
        textarea.setSelectionRange(caretAt, caretAt);
      });
      return true;
    }

    // ``` + Enter opens a fenced code block.
    if (line.trim() === "```") {
      event.preventDefault();
      pushHistory();
      updateBlockContent(block, `${source.slice(0, lineStart)}\`\`\`\n\n\`\`\``);
      setEditingId(null);
      return true;
    }

    // --- on its own line + Enter becomes a divider.
    if (/^\s*---\s*$/.test(line)) {
      event.preventDefault();
      pushHistory();
      updateBlockContent(block, `${source.slice(0, lineStart)}---`);
      setEditingId(null);
      return true;
    }

    const parsed = parseListPrefix(line);
    if (parsed) {
      event.preventDefault();
      if (parsed.content.trim() === "") {
        // Second Enter on an empty item drops the marker: back to plain text.
        pushHistory();
        const stripped = source.slice(0, lineStart) + parsed.indent + source.slice(lineEnd);
        updateBlockContent(block, stripped);
        requestAnimationFrame(() => {
          textarea.focus();
          const position = Math.max(0, lineStart + parsed.indent.length - visibleOffset);
          textarea.setSelectionRange(position, position);
        });
      } else {
        // Each Notion-style list row remains an independently draggable block.
        pushHistory();
        const before = line.slice(0, relCaret);
        const after = line.slice(relCaret);
        const head = source.slice(0, lineStart) + before;
        const ordered = parsed.marker.match(/^(\d+)([.、][ \t]*)$/);
        const continuationMarker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : parsed.marker;
        const created = {
          id: newBlockId(),
          source: `${parsed.indent}${continuationMarker}${after}${source.slice(lineEnd)}`,
          rowId: block.rowId,
          col: block.col,
          colWidths: block.colWidths,
        };
        const next = blocks.flatMap((item) => item.id === block.id
          ? [{ ...item, source: withBlockStyle(head, parseStyledBlock(block.source).style) }, created]
          : [item]);
        commit(next);
        setEditingId(created.id);
      }
      return true;
    }

    if (line.trim() === "") {
      event.preventDefault();
      pushHistory();
      const created = {
        id: newBlockId(),
        source: "",
        rowId: block.rowId,
        col: block.col,
        colWidths: block.colWidths,
      };
      commit(blocks.flatMap((item) => item.id === block.id ? [item, created] : [item]));
      setEditingId(created.id);
      return true;
    }

    // Plain text: Enter commits the block (revealing its live preview) and
    // opens a fresh block right below for continued writing.
    event.preventDefault();
    pushHistory();
    const head = source.slice(0, lineStart + relCaret);
    const tail = source.slice(lineStart + relCaret);
    const created = {
      id: newBlockId(),
      source: tail,
      rowId: block.rowId,
      col: block.col,
      colWidths: block.colWidths,
    };
    const next = blocks.flatMap((item) => item.id === block.id ? [{ ...item, source: withBlockStyle(head, parseStyledBlock(block.source).style) }, created] : [item]);
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

  const peekColumnDrop = (clientX: number, clientY: number): { id: string; side: "left" | "right" } | null => {
    const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-markdown-block-id]");
    const id = hit?.dataset.markdownBlockId;
    if (!hit || !id || dragRef.current?.ids.includes(id)) return null;
    const rect = hit.getBoundingClientRect();
    if (rect.width <= 40) return null;
    const gutter = Math.min(52, rect.width * 0.3);
    const edge = Math.min(48, rect.width * 0.22);
    if (clientX >= rect.right - edge) return { id, side: "right" };
    if (clientX >= rect.left + gutter && clientX < rect.left + gutter + edge) return { id, side: "left" };
    return null;
  };

  const updateMarqueeSelection = (clientX: number, clientY: number) => {
    const origin = marqueeOriginRef.current;
    const editor = editorRef.current;
    if (!origin || !editor) return;
    const left = Math.min(origin.x, clientX);
    const top = Math.min(origin.y, clientY);
    const right = Math.max(origin.x, clientX);
    const bottom = Math.max(origin.y, clientY);
    setMarqueeBox({ left, top, width: right - left, height: bottom - top });
    const selected = [...editor.querySelectorAll<HTMLElement>("[data-markdown-block-id]")].flatMap((block) => {
      const rect = block.getBoundingClientRect();
      const intersects = rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      return intersects && block.dataset.markdownBlockId ? [block.dataset.markdownBlockId] : [];
    });
    setSelectedBlockIds(selected);
  };

  const beginMarqueeSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setBlockMenuId(null);
    setSelectedBlockIds([]);
    marqueeOriginRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    setMarqueeBox({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture is optional */ }
  };

  const moveMarqueeSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (!marqueeOriginRef.current) return;
    event.preventDefault();
    updateMarqueeSelection(event.clientX, event.clientY);
  };

  const endMarqueeSelection = (event: ReactPointerEvent<HTMLElement>) => {
    const origin = marqueeOriginRef.current;
    if (!origin) return;
    event.preventDefault();
    event.stopPropagation();
    updateMarqueeSelection(event.clientX, event.clientY);
    marqueeOriginRef.current = null;
    setMarqueeBox(null);
    suppressCanvasClickUntilRef.current = performance.now() + 300;
    try { event.currentTarget.releasePointerCapture(origin.pointerId); } catch { /* already released */ }
  };

  const cancelMarqueeSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (!marqueeOriginRef.current) return;
    marqueeOriginRef.current = null;
    setMarqueeBox(null);
    suppressCanvasClickUntilRef.current = performance.now() + 300;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragRef.current = {
      id,
      ids: selectedBlockIds.includes(id) ? selectedBlockIds : [id],
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
      drag.moved = true;
      setDraggingId(drag.id);
    }
    if (!drag.moved) return;
    const column = peekColumnDrop(event.clientX, event.clientY);
    setDropColumn(column);
    setDropIndex(column ? null : computeDropIndex(event.clientX, event.clientY));
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    suppressHandleClickRef.current = Boolean(drag?.moved);
    const column = drag?.moved ? peekColumnDrop(event.clientX, event.clientY) : null;
    const target = drag?.moved && !column ? computeDropIndex(event.clientX, event.clientY) : null;
    dragRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
    setDropColumn(null);
    if (!drag?.moved) return;
    if (column) {
      const next = placeBlockBeside(blocks, drag.ids, column.id, column.side);
      if (next === blocks) return;
      pushHistory();
      commit(next);
      setSelectedBlockIds([]);
      return;
    }
    if (target == null) return;
    const dest = target < blocks.length ? blocks[target] : undefined;
    const sameColumn = Boolean(
      dest?.rowId
      && drag.ids.every((id) => {
        const current = blocks.find((block) => block.id === id);
        return current?.rowId === dest.rowId && current.col === dest.col;
      }),
    );
    const prepared = sameColumn ? blocks : releaseFromRow(blocks, drag.ids);
    const next = moveBlockSelection(prepared, drag.ids, target);
    if (next === blocks) return;
    pushHistory();
    commit(next);
    setSelectedBlockIds([]);
  };
  const cancelDrag = () => {
    dragRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
    setDropColumn(null);
  };

  const renderIndicator = (at: number) =>
    draggingId && dropIndex === at ? (
      <div className="markdown-drop-indicator" aria-hidden="true" />
    ) : null;

  return (
    <section
      ref={editorRef}
      className={`markdown-block-editor ${marqueeBox ? "marquee-selecting" : ""}`}
      aria-label={zh ? "Markdown 內容" : "Markdown content"}
      onKeyDown={handleHistoryShortcut}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDownCapture={beginMarqueeSelection}
      onPointerMove={moveMarqueeSelection}
      onPointerUp={endMarqueeSelection}
      onPointerCancel={cancelMarqueeSelection}
      onClickCapture={(event) => {
        if (performance.now() < suppressCanvasClickUntilRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="markdown-block-list" ref={listRef}>
        {(() => {
          const renderBlock = (block: MarkdownBlock, index: number) => {
          const styled = parseStyledBlock(block.source);
          const attachment = parseStandaloneAttachment(styled.content);
          const derived = deriveBlockKind(styled.content);
          const { kind, level } = derived;
          const presentation = editablePresentation(styled.content, derived);
          const isEditing = editingId === block.id;
          const singleTaskMatch = styled.content.includes("\n") ? null : styled.content.match(TASK_LINE);
          const taskIdentity = singleTaskMatch ? splitTaskIdentity(singleTaskMatch[3] ?? "") : null;
          const kindClass = `kind-${kind}${level ? `-h${level}` : ""}`;
          const currentTurnValue = kind === "heading" ? `h${level}`
            : kind === "task" ? "todo"
            : kind === "ordered" ? "number"
            : kind === "paragraph" ? "text"
            : kind;
          const currentBlockLabel = blockCommands.find((command) => command.action.kind === "turn" && command.action.value === currentTurnValue)?.label
            ?? (zh ? "文字" : "Text");
          const slash = isEditing ? trailingSlash(styled.content) : null;
          const commandOptions = slash ? filteredCommands(slash.query) : [];
          const showSlashMenu = slash && dismissedSlash !== `${block.id}:${styled.content}` && commandOptions.length > 0;
          return (
            <article
              key={block.id}
              data-markdown-block-id={block.id}
              data-global-select-id={block.id}
              data-global-select-kind="markdown-block"
              data-block-kind={kind}
              data-block-color={styled.style.color}
              data-block-background={styled.style.background}
              className={`markdown-block ${kindClass} ${isEditing ? "editing" : ""} ${selectedBlockIds.includes(block.id) ? "selected" : ""} ${draggingId === block.id || (draggingId && selectedBlockIds.includes(block.id)) ? "dragging" : ""} ${dropColumn?.id === block.id ? `drop-column-${dropColumn.side}` : ""}`}
              style={block.rowId ? undefined : { gridColumn: "1 / -1" }}
            >
              <div className="markdown-block-tools">
                <button
                  type="button"
                  className="markdown-block-add-inline"
                  aria-label={zh ? "在下方新增區塊" : "Add a block below"}
                  title={zh ? "新增區塊" : "Add block"}
                  onClick={() => addBlock(index)}
                >
                  <Plus aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="markdown-block-grip"
                  data-markdown-drag-handle
                  aria-label={zh ? `拖曳區塊 ${index + 1}` : `Drag block ${index + 1}`}
                  title={zh ? "拖曳排序；拖到另一塊旁邊可並排" : "Drag to reorder, or beside another block to make columns"}
                  onPointerDown={(event) => beginDrag(event, block.id)}
                  onPointerMove={moveDrag}
                  onPointerUp={finishDrag}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={() => {
                    if (dragRef.current?.id === block.id) cancelDrag();
                  }}
                  onClick={(event) => {
                    if (suppressHandleClickRef.current) {
                      suppressHandleClickRef.current = false;
                      return;
                    }
                    setBlockMenuPanel("root");
                    if (blockMenuId === block.id) {
                      setBlockMenuId(null);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    setBlockMenuStyle(blockMenuPlacement(rect, window.innerWidth, window.innerHeight));
                    setBlockMenuId(block.id);
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
                {isEditing && singleTaskMatch ? (
                  <div className="markdown-task-edit-row">
                    <input
                      type="checkbox"
                      checked={singleTaskMatch[2]!.toLowerCase() === "x"}
                      aria-label={zh ? "切換待辦狀態" : "Toggle task"}
                      onChange={(event) => toggleTask(block.id, 0, event.currentTarget.checked)}
                    />
                    <textarea
                      autoFocus
                      value={taskIdentity?.visible ?? ""}
                      rows={1}
                      className="markdown-block-input markdown-task-input kind-task"
                      aria-label={zh ? "編輯待辦內容" : "Edit task content"}
                      placeholder={zh ? "輸入待辦內容" : "Type task content"}
                      onChange={(event) => {
                        updateBlockContent(block, composeTaskLine(singleTaskMatch[1]!, singleTaskMatch[2]!, singleTaskMatch[3] ?? "", event.target.value));
                      }}
                      onBlur={(event) => {
                        if (event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) return;
                        finishEditing(block.id);
                      }}
                      ref={bindTextareaRef(block.id)}
                      onKeyDown={(event) => {
                        const ime = imeEnterDisposition(event);
                        if (ime !== false) {
                          // "confirm": the IME owns this key — stay out of its
                          // way entirely. "echo": cancel so it neither splits
                          // the block nor drops a literal newline.
                          if (ime === "echo") event.preventDefault();
                          return;
                        }
                        const taskTextarea = event.currentTarget;
                        if (event.key === "Backspace" && taskTextarea.selectionStart === 0 && taskTextarea.selectionEnd === 0) {
                          const previousIndex = blocks.findIndex((item) => item.id === block.id) - 1;
                          const previousBlock = previousIndex >= 0 ? blocks[previousIndex] : undefined;
                          if (previousBlock) {
                            // Notion-style merge upward: the previous line's
                            // text joins this one (its own todo/bullet marker
                            // never travels with it) and the caret lands at
                            // the junction, so further Backspaces keep
                            // deleting the previous line's characters.
                            event.preventDefault();
                            const previousStyled = parseStyledBlock(previousBlock.source);
                            const previousBody = previousStyled.content.includes("\n")
                              ? previousStyled.content
                              : stripBlockPrefix(previousStyled.content);
                            pushHistory();
                            const remaining = blocks.filter((item) => item.id !== previousBlock.id);
                            const merged = composeTaskLine(
                              singleTaskMatch[1]!,
                              singleTaskMatch[2]!,
                              singleTaskMatch[3] ?? "",
                              `${previousBody}${taskIdentity?.visible ?? ""}`,
                            );
                            const next = remaining.map((item) => item.id === block.id
                              ? { ...item, source: withBlockStyle(merged, parseStyledBlock(block.source).style) }
                              : item);
                            commit(next);
                            requestAnimationFrame(() => {
                              if (!taskTextarea.isConnected) return;
                              try {
                                taskTextarea.focus({ preventScroll: true });
                                taskTextarea.setSelectionRange(previousBody.length, previousBody.length);
                              } catch { /* unmounted */ }
                            });
                          } else if (!taskIdentity?.visible.trim() && !taskIdentity?.lead && !taskIdentity?.trail) {
                            // First block on the canvas: drop the marker.
                            event.preventDefault();
                            pushHistory();
                            updateBlockContent(block, "");
                          }
                        } else if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          pushHistory();
                          if (!taskIdentity?.visible.trim() && !taskIdentity?.lead && !taskIdentity?.trail) {
                            updateBlockContent(block, "");
                            return;
                          }
                          const created = {
                            id: newBlockId(),
                            source: "- [ ] ",
                            rowId: block.rowId,
                            col: block.col,
                            colWidths: block.colWidths,
                          };
                          commit(blocks.flatMap((item) => item.id === block.id ? [item, created] : [item]));
                          setEditingId(created.id);
                        } else if (event.key === "Delete" && event.currentTarget.selectionStart === event.currentTarget.selectionEnd && event.currentTarget.selectionEnd === (taskIdentity?.visible.length ?? 0)) {
                          // Notion-style merge: at the end of a task, Delete
                          // folds the next block's TEXT into the current task
                          // line. The next block's own `- [ ] ` marker never
                          // travels with it, and an empty todo below simply
                          // disappears instead of leaving marker debris.
                          const currentIndex = blocks.findIndex((item) => item.id === block.id);
                          const nextBlock = currentIndex >= 0 ? blocks[currentIndex + 1] : undefined;
                          if (nextBlock) {
                            event.preventDefault();
                            const nextStyled = parseStyledBlock(nextBlock.source);
                            const nextTaskMatch = nextStyled.content.match(TASK_LINE);
                            const nextBody = nextTaskMatch
                              ? splitTaskIdentity(nextTaskMatch[3] ?? "").visible
                              : nextStyled.content;
                            pushHistory();
                            const remaining = blocks.filter((item) => item.id !== nextBlock.id);
                            const merged = composeTaskLine(
                              singleTaskMatch[1]!,
                              singleTaskMatch[2]!,
                              singleTaskMatch[3] ?? "",
                              `${taskIdentity?.visible ?? ""}${nextBody}`,
                            );
                            const next = remaining.map((item) => item.id === block.id
                              ? { ...item, source: withBlockStyle(merged, parseStyledBlock(block.source).style) }
                              : item);
                            commit(next);
                            requestAnimationFrame(() => {
                              const ta = event.currentTarget;
                              if (!ta?.isConnected) return;
                              try {
                                ta.focus();
                                ta.setSelectionRange(taskIdentity?.visible.length ?? 0, taskIdentity?.visible.length ?? 0);
                              } catch { /* unmounted */ }
                            });
                          }
                        } else if (event.key === "Escape" || (event.ctrlKey && event.key === "Enter")) {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </div>
                ) : isEditing ? (
                  <div className={`markdown-structural-edit-row ${presentation.marker ? "has-marker" : ""}`}>
                    {presentation.marker && <span aria-hidden="true">{presentation.marker}</span>}
                    <textarea
                      autoFocus
                      value={presentation.value}
                      rows={1}
                      className={`markdown-block-input ${kindClass}`}
                      aria-label={zh ? "編輯 Markdown 區塊" : "Edit Markdown block"}
                      placeholder={zh ? "輸入文字，或輸入 / 使用指令" : "Type text, or press / for commands"}
                      onChange={(event) => {
                        setActiveCommand(0);
                        updateTypedBlock(block, presentation.sourcePrefix + event.target.value);
                      }}
                      onBlur={() => finishEditing(block.id)}
                      ref={bindTextareaRef(block.id)}
                      onKeyDown={(event) => {
                        const ime = imeEnterDisposition(event);
                        if (ime !== false) {
                          if (ime === "echo") event.preventDefault();
                          return;
                        }
                        if (handleTextKeydown(event, block, presentation.sourcePrefix.length)) return;
                        if (event.key === "Escape" || (event.ctrlKey && event.key === "Enter")) {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </div>
                ) : (kind === "bullet" || kind === "ordered" || kind === "quote" || kind === "heading") ? (
                  // Render the same row layout as edit mode so the marker chip
                  // never jumps when the user clicks into the block.
                  <div
                    className="markdown-structural-edit-row"
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a,button,input,textarea")) return;
                      setEditingId(block.id);
                    }}
                  >
                    {presentation.marker && <span aria-hidden="true">{presentation.marker}</span>}
                    <div
                      className={`markdown-block-static ${kindClass}`}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setEditingId(block.id);
                        }
                      }}
                    >
                      {styled.content.split("\n").map((line, index) => (
                        <div key={index} className="markdown-block-static-line">{stripBlockPrefixForPreview(line, kind)}</div>
                      ))}
                    </div>
                  </div>
                ) : kind === "task" ? (
                  <div
                    className="markdown-task-block"
                    onClick={(event) => {
                      // Clicking the text portion enters edit mode; clicking
                      // the checkbox toggles completion. Putting the checkbox
                      // outside the <label> keeps the focus on editing instead
                      // of toggling completion by accident.
                      if (!(event.target as HTMLElement).closest("input[type=checkbox]")) {
                        setEditingId(block.id);
                      }
                    }}
                  >
                    {styled.content.split("\n").map((line, lineIndex) => {
                      const match = line.match(TASK_LINE)!;
                      return (
                        <div key={`${block.id}:${lineIndex}`} className="markdown-task-block-row">
                          <input
                            type="checkbox"
                            checked={match[2]!.toLowerCase() === "x"}
                            onChange={(event) => toggleTask(block.id, lineIndex, event.currentTarget.checked)}
                            onClick={(event) => event.stopPropagation()}
                            aria-label={match[2]!.toLowerCase() === "x" ? (zh ? "重新開啟" : "Reopen") : (zh ? "標記完成" : "Mark complete")}
                          />
                          <button type="button" onClick={(event) => { event.stopPropagation(); setEditingId(block.id); }}>
                            {splitTaskIdentity(match[3] ?? "").visible || (zh ? "輸入待辦內容" : "Type task content")}
                          </button>
                        </div>
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
                ) : attachment ? (
                  <div
                    className="markdown-block-attachment"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <VaultAttachmentView
                      href={attachment.relativePath}
                      alt={attachment.name}
                      width={attachment.width}
                      onResize={attachment.image ? (nextWidth) => {
                        pushHistory();
                        updateBlockContent(block, withAttachmentImageWidth(block.source, nextWidth));
                      } : undefined}
                    />
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
                    {styled.content.trim()
                      ? <MarkdownPreview value={styled.content} locale={locale} />
                      : <span className="markdown-block-preview-empty">{zh ? "輸入文字，或輸入 / 使用指令" : "Type text, or press / for commands"}</span>}
                  </div>
                )}
                {showSlashMenu && (
                  <div className="markdown-slash-menu" role="listbox" aria-label={zh ? "區塊指令" : "Block commands"}>
                    <header>{zh ? "基本區塊與色彩" : "Blocks and colors"}<kbd>↑↓ Enter</kbd></header>
                    {commandOptions.map((command, commandIndex) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={commandIndex === activeCommand}
                        className={commandIndex === activeCommand ? "active" : ""}
                        key={command.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => runSlashCommand(block, command)}
                      >
                        <span className={`markdown-command-swatch command-${command.action.kind}-${command.action.value}`} aria-hidden="true">A</span>
                        <span><strong>{command.label}</strong><small>{command.hint}</small></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {blockMenuId === block.id && (
                <div
                  className="markdown-block-menu"
                  style={blockMenuStyle}
                  role="menu"
                  aria-label={zh ? "區塊操作" : "Block actions"}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
                      event.preventDefault();
                      duplicateBlock(block.id);
                    } else if (event.key === "Delete") {
                      event.preventDefault();
                      removeBlock(block.id);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      if (blockMenuPanel === "root") setBlockMenuId(null);
                      else setBlockMenuPanel("root");
                    }
                  }}
                >
                  {blockMenuPanel === "root" && <>
                    <button type="button" role="menuitem" className="markdown-block-menu-row" onClick={() => setBlockMenuPanel("turn")}>
                      <Repeat2 aria-hidden="true" /><span><strong>{zh ? "轉換成" : "Turn into"}</strong><small>{currentBlockLabel}</small></span><ChevronRight aria-hidden="true" />
                    </button>
                    <button type="button" role="menuitem" className="markdown-block-menu-row" onClick={() => setBlockMenuPanel("color")}>
                      <Palette aria-hidden="true" /><span><strong>{zh ? "顏色" : "Color"}</strong><small>{zh ? "文字與背景" : "Text and background"}</small></span><ChevronRight aria-hidden="true" />
                    </button>
                    <div className="markdown-block-menu-separator" />
                    <button type="button" role="menuitem" className="markdown-block-menu-row" onClick={() => duplicateBlock(block.id)}>
                      <Copy aria-hidden="true" /><span><strong>{zh ? "建立複本" : "Duplicate"}</strong><small>Ctrl+D</small></span>
                    </button>
                    <button type="button" role="menuitem" className="markdown-block-menu-row danger" onClick={() => removeBlock(block.id)}>
                      <Trash2 aria-hidden="true" /><span><strong>{zh ? "刪除" : "Delete"}</strong><small>Del</small></span>
                    </button>
                  </>}
                  {blockMenuPanel === "turn" && <>
                    <button type="button" className="markdown-block-menu-back" onClick={() => setBlockMenuPanel("root")}><ChevronLeft aria-hidden="true" />{zh ? "轉換成" : "Turn into"}</button>
                    <div className="markdown-block-menu-list">
                      {blockCommands.map((command) => {
                        if (command.action.kind !== "turn") return null;
                        const active = command.action.value === currentTurnValue;
                        return <button type="button" role="menuitemradio" aria-checked={active} className="markdown-block-menu-row" key={command.id} onClick={() => { runSlashCommand(block, command); setBlockMenuId(null); }}>
                          {command.action.value === "code" ? <Code2 aria-hidden="true" /> : <span className="markdown-block-type-icon" aria-hidden="true">{command.action.value.startsWith("h") ? command.action.value.toUpperCase() : command.label.slice(0, 1)}</span>}
                          <span><strong>{command.label}</strong><small>{command.hint}</small></span>{active && <Check aria-hidden="true" />}
                        </button>;
                      })}
                    </div>
                  </>}
                  {blockMenuPanel === "color" && <>
                    <button type="button" className="markdown-block-menu-back" onClick={() => setBlockMenuPanel("root")}><ChevronLeft aria-hidden="true" />{zh ? "顏色" : "Color"}</button>
                    <strong>{zh ? "文字顏色" : "Text color"}</strong>
                    <div className="markdown-color-grid">
                      {colorNames.map(([color, name]) => <button type="button" role="menuitemradio" aria-checked={styled.style.color === color} className={styled.style.color === color ? "active" : ""} data-color={color} aria-label={zh ? `${name}文字` : `${name} text`} title={name} key={`text-${color}`} onClick={() => applyBlockStyle(block, { ...styled.style, color })} />)}
                    </div>
                    <strong>{zh ? "底色" : "Background"}</strong>
                    <div className="markdown-color-grid background-grid">
                      {colorNames.map(([background, name]) => <button type="button" role="menuitemradio" aria-checked={styled.style.background === background} className={styled.style.background === background ? "active" : ""} data-color={background} aria-label={zh ? `${name}底色` : `${name} background`} title={name} key={`background-${background}`} onClick={() => applyBlockStyle(block, { ...styled.style, background })} />)}
                    </div>
                  </>}
                </div>
              )}
            </article>
          );
          };
          const nodes: React.ReactNode[] = [];
          let cursor = 0;
          while (cursor < blocks.length) {
            const current = blocks[cursor]!;
            if (!current.rowId) {
              nodes.push(
                <React.Fragment key={current.id}>
                  {renderIndicator(cursor)}
                  {renderBlock(current, cursor)}
                </React.Fragment>,
              );
              cursor += 1;
              continue;
            }
            const rowId = current.rowId;
            const start = cursor;
            const row: MarkdownBlock[] = [];
            while (cursor < blocks.length && blocks[cursor]?.rowId === rowId) {
              row.push(blocks[cursor]!);
              cursor += 1;
            }
            const colCount = Math.max(1, ...row.map((item) => (item.col ?? 0) + 1));
            const widths = row[0]?.colWidths ?? equalColWidths(colCount);
            nodes.push(
              <div
                key={rowId}
                className="markdown-row"
                data-markdown-row={rowId}
                style={{ gridColumn: "1 / -1", gridTemplateColumns: rowTemplate(widths) }}
              >
                {renderIndicator(start)}
                {Array.from({ length: colCount }, (_, col) => (
                  <React.Fragment key={`${rowId}-${col}`}>
                    {col > 0 && (
                      <div
                        className="markdown-col-resizer"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={zh ? "調整欄寬" : "Resize column"}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const rowEl = event.currentTarget.parentElement;
                          if (!rowEl) return;
                          const originX = event.clientX;
                          const origin = [...widths];
                          const gutters = 8 * (colCount - 1);
                          const usable = Math.max(1, rowEl.getBoundingClientRect().width - gutters);
                          const handle = event.currentTarget;
                          handle.setPointerCapture(event.pointerId);
                          const left = col - 1;
                          const move = (next: PointerEvent) => {
                            const delta = ((next.clientX - originX) / usable) * 100;
                            const nextWidths = [...origin];
                            nextWidths[left] = origin[left]! + delta;
                            nextWidths[col] = origin[col]! - delta;
                            if (nextWidths[left]! < 18 || nextWidths[col]! < 18) return;
                            rowEl.style.gridTemplateColumns = rowTemplate(nextWidths);
                            (handle as HTMLElement & { dataset: { widths?: string } }).dataset.widths = nextWidths.join(" ");
                          };
                          const stop = (next: PointerEvent) => {
                            handle.releasePointerCapture(next.pointerId);
                            handle.removeEventListener("pointermove", move);
                            handle.removeEventListener("pointerup", stop);
                            const raw = handle.dataset.widths;
                            const finalWidths = raw ? raw.split(" ").map(Number) : origin;
                            pushHistory();
                            commit(blocks.map((block) => (block.rowId === rowId ? { ...block, colWidths: finalWidths } : block)));
                          };
                          handle.addEventListener("pointermove", move);
                          handle.addEventListener("pointerup", stop);
                        }}
                      />
                    )}
                    <div className="markdown-col">
                      {row.filter((item) => (item.col ?? 0) === col).map((item) => renderBlock(item, blocks.indexOf(item)))}
                    </div>
                  </React.Fragment>
                ))}
              </div>,
            );
          }
          nodes.push(renderIndicator(blocks.length));
          return nodes;
        })()}
      </div>
      {marqueeBox && (
        <div
          className="markdown-block-selection-marquee"
          data-markdown-selection-marquee
          style={{ left: marqueeBox.left, top: marqueeBox.top, width: marqueeBox.width, height: marqueeBox.height }}
          aria-hidden="true"
        />
      )}
      <div className="markdown-block-footer">
        {canAttach && (
          <>
            <input ref={fileInputRef} type="file" hidden accept={ATTACHMENT_ACCEPT} multiple={maxAttachments !== 1} onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; importFiles(files); }} />
            <button type="button" className="markdown-block-add" onClick={() => fileInputRef.current?.click()}><Paperclip aria-hidden="true" />{zh ? "加入檔案" : "Add file"}</button>
          </>
        )}
        {blocks.some((block) => parseStyledBlock(block.source).content.trim()) && <button type="button" className="markdown-block-add" onClick={() => addBlock()}><Plus aria-hidden="true" />{zh ? "新增區塊" : "Add block"}</button>}
      </div>
    </section>
  );
}
