import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Code2, Copy, GripVertical, Palette, Paperclip, Plus, Repeat2, Trash2 } from "lucide-react";
import { ATTACHMENT_ACCEPT, parseStandaloneAttachment, withAttachmentImageWidth } from "@second-brain/brain-core";
import { MarkdownPreview, VaultAttachmentView, type MarkdownEditorLocale } from "./markdown-editor";
import { dropHasFiles, filesFromDrop, snippetsFromFiles, useVaultAttachments } from "./attachment-context";
import { getSelectedIdsOfKind, GLOBAL_SELECTION_DELETE_EVENT } from "./global-shift-marquee";

interface MarkdownBlock {
  id: string;
  source: string;
  rowId?: string;
  col?: number;
  colWidths?: number[];
}

interface EditorSnapshot {
  blocks: MarkdownBlock[];
  editingId: string | null;
  start: number;
  end: number;
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
  let rest = afterCheckbox.replace(/^[ \t]/, "");
  const leadMatch = rest.match(/^#task\b[ \t]*/);
  const lead = leadMatch ? leadMatch[0] : "";
  if (leadMatch) rest = rest.slice(lead.length);
  const trailMatch = rest.match(TASK_IDENTITY_COMMENT);
  const trail = trailMatch ? ` ${trailMatch[0].trim()}` : "";
  const visible = trailMatch ? rest.slice(0, trailMatch.index).trimEnd() : rest;
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
 * its trailing space so continuations preserve marker spelling and indentation.
 */
const LIST_PREFIX = /^([ \t]*)([-*+][ \t]+\[[ xX]\][ \t]?|[-*+][ \t]+|>[ \t]?|[0-9]+[.)、][ \t]*)(.*)$/;

/** Text and structural changes share the same bounded undo history. */
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
  for (const line of value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n")) {
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
      if (BLOCK_STYLE_MARKER.test(line) && buffer.length === 0 && out.length > 0) {
        out[out.length - 1] += `\n${line}`;
      } else if (isStandaloneBlockLine(line)) {
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

function renumberFollowing(blocks: MarkdownBlock[], from: number): MarkdownBlock[] {
  const first = blocks[from];
  if (!first || deriveBlockKind(first.source).kind !== "ordered") return blocks;
  const prefix = parseListPrefix(parseStyledBlock(first.source).content)!;
  let number = Number(prefix.marker.match(/^\d+/)![0]);
  let active = true;
  return blocks.map((block, index) => {
    if (index <= from || !active) return block;
    const styled = parseStyledBlock(block.source);
    const next = parseListPrefix(styled.content);
    if (block.rowId !== first.rowId || block.col !== first.col || !next || next.indent.length < prefix.indent.length) {
      active = false;
      return block;
    }
    if (next.indent.length > prefix.indent.length) return block;
    if (!/^\d+[.)、]/.test(next.marker)) { active = false; return block; }
    const marker = next.marker.replace(/^\d+/, String(++number));
    return { ...block, source: withBlockStyle(next.indent + marker + next.content, styled.style) };
  });
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
  sourceSuffix: string;
  marker: string;
}

function splitFencedCode(content: string): { inner: string; prefix: string; suffix: string } | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const closed = normalized.match(/^(```|~~~)([^\n]*)\n([\s\S]*?)\n?(```|~~~)\s*$/);
  if (closed) {
    return {
      inner: closed[3] ?? "",
      prefix: `${closed[1]}${closed[2]}\n`,
      suffix: `\n${closed[4]}`,
    };
  }
  const open = normalized.match(/^(```|~~~)([^\n]*)$/);
  if (!open) return null;
  return {
    inner: "",
    prefix: `${open[1]}${open[2]}\n`,
    suffix: `\n${open[1]}`,
  };
}

function editablePresentation(content: string, derived: DerivedBlock): EditablePresentation {
  if (derived.kind === "code") {
    const fenced = splitFencedCode(content);
    if (fenced) return { value: fenced.inner, sourcePrefix: fenced.prefix, sourceSuffix: fenced.suffix, marker: "" };
  }
  if (content.includes("\n")) return { value: content, sourcePrefix: "", sourceSuffix: "", marker: "" };
  if (derived.kind === "heading") {
    const match = content.match(/^(\s*#{1,6}\s+)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, sourceSuffix: "", marker: "" };
  }
  if (derived.kind === "bullet") {
    const match = content.match(/^(\s*[-*+]\s+)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, sourceSuffix: "", marker: "•" };
  }
  if (derived.kind === "ordered") {
    const match = content.match(/^(\s*\d+[.)、]\s+)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, sourceSuffix: "", marker: match[1]!.trim() };
  }
  if (derived.kind === "quote") {
    const match = content.match(/^(\s*>\s*)(.*)$/);
    if (match) return { value: match[2] ?? "", sourcePrefix: match[1]!, sourceSuffix: "", marker: "" };
  }
  return { value: content, sourcePrefix: "", sourceSuffix: "", marker: "" };
}

// Inline HTML breaks keep a soft line break inside one Markdown list item.
// They are decoded only for editing; no arbitrary HTML is executed.
function visibleBlockText(source: string): string {
  const content = parseStyledBlock(source).content;
  const task = content.match(TASK_LINE);
  const presentation = editablePresentation(content, deriveBlockKind(content));
  const text = task ? splitTaskIdentity(task[3] ?? "").visible : presentation.value;
  return deriveBlockKind(content).kind === "code" ? text : text.replace(/<br\s*\/?\s*>/gi, "\n");
}

function withVisibleBlockText(source: string, text: string): string {
  const { content, style } = parseStyledBlock(source);
  const task = content.match(TASK_LINE);
  const derived = deriveBlockKind(content);
  const presentation = editablePresentation(content, derived);
  const encoded = derived.kind !== "paragraph" && derived.kind !== "code" ? text.replace(/\n/g, "<br>") : text;
  const next = task ? composeTaskLine(task[1]!, task[2]!, task[3] ?? "", encoded)
    : presentation.sourcePrefix + encoded + presentation.sourceSuffix;
  return withBlockStyle(next, style);
}

function hasTaskIdentity(source: string): boolean {
  const match = parseStyledBlock(source).content.match(TASK_LINE);
  if (!match) return false;
  const identity = splitTaskIdentity(match[3] ?? "");
  return Boolean(identity.lead || identity.trail);
}

function selectedTextBlockIds(editor: HTMLElement | null): string[] {
  const selection = editor?.ownerDocument.getSelection();
  if (!editor || !selection || selection.isCollapsed || !selection.rangeCount
    || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return [];
  const range = selection.getRangeAt(0);
  return [...editor.querySelectorAll<HTMLElement>(".markdown-block-content")].flatMap((content) => {
    if (!range.intersectsNode(content)) return [];
    const id = content.closest<HTMLElement>("[data-markdown-block-id]")?.dataset.markdownBlockId;
    if (!id) return [];
    // Inspect text only: controls and an untouched boundary block must not
    // join the batch merely because their elements intersect the range.
    const walker = editor.ownerDocument.createTreeWalker(content);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : node.textContent?.length ?? 0;
      if (end > start) return [id];
    }
    return [];
  });
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
  const selectionAnchorRef = useRef<string | null>(null);
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
  const nativeTextSelectionRef = useRef(false);
  const syncTextSelection = useCallback(() => {
    const ids = selectedTextBlockIds(editorRef.current);
    if (ids.length > 1) {
      nativeTextSelectionRef.current = true;
      setSelectedBlockIds((current) => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids);
    } else if (nativeTextSelectionRef.current) {
      nativeTextSelectionRef.current = false;
      setSelectedBlockIds([]);
    }
    return ids;
  }, []);
  const releaseTextSelection = () => {
    nativeTextSelectionRef.current = false;
    const selection = document.getSelection();
    if (selection && editorRef.current?.contains(selection.anchorNode)) selection.removeAllRanges();
  };
  useEffect(() => {
    document.addEventListener("selectionchange", syncTextSelection);
    return () => document.removeEventListener("selectionchange", syncTextSelection);
  }, [syncTextSelection]);
  useEffect(() => {
    if (!blockMenuId) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const editor = editorRef.current;
      if (editor?.querySelector(".markdown-block-menu")?.contains(target)) return;
      const element = target instanceof HTMLElement ? target : target.parentElement;
      if (editor?.contains(target) && element?.closest("[data-markdown-drag-handle]")) return;
      setBlockMenuId(null);
      setBlockMenuPanel("root");
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [blockMenuId]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<{ past: EditorSnapshot[]; future: EditorSnapshot[] }>({ past: [], future: [] });
  const typingGroupRef = useRef<{ id: string; at: number } | null>(null);
  const documentFormatRef = useRef({ bom: value.startsWith("\uFEFF"), crlf: value.includes("\r\n") });
  const emittedValueRef = useRef(value);
  const serializeDocument = (items: MarkdownBlock[]) => {
    const source = serializeBlocks(items);
    return (documentFormatRef.current.bom ? "\uFEFF" : "") + (documentFormatRef.current.crlf ? source.replace(/\n/g, "\r\n") : source);
  };
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
  const IME_ECHO_WINDOW_MS = 80;
  const imeCompositionEndedAtRef = useRef(0);
  const imeComposingRef = useRef(false);
  // Composition timing is a DOM-level concern, so compositionstart/end are
  // recorded through native listeners (attached with the textarea ref) instead
  // of React props: the flags are then in place before any following keydown
  // or delayed caret snap, independent of React's event delegation.
  const imeListeners = useRef(new WeakMap<HTMLTextAreaElement, { start: () => void; end: (event: CompositionEvent) => void }>()).current;
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
  const imeEnterDisposition = (event: ReactKeyboardEvent<HTMLTextAreaElement>): "confirm" | "echo" | false => {
    if (event.key !== "Enter" && event.key !== "Process") return false;
    const native = event.nativeEvent as KeyboardEvent & { keyCode?: number; isComposing?: boolean };
    if (event.key === "Process" || imeComposingRef.current || native.isComposing || native.keyCode === 229) return "confirm";
    const endedAt = imeCompositionEndedAtRef.current;
    if (endedAt > 0 && event.timeStamp >= endedAt && event.timeStamp - endedAt < IME_ECHO_WINDOW_MS) {
      imeCompositionEndedAtRef.current = 0;
      return "echo";
    }
    return false;
  };
  const pendingSelectionRef = useRef<{ id: string; start: number; end: number } | null>(null);
  const focusedTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusBlock = (id: string, start: number, end = start) => {
    pendingSelectionRef.current = { id, start, end };
    setEditingId(id);
  };
  const beginPointerEdit = (event: React.MouseEvent, block: MarkdownBlock) => {
    if (editingId === block.id || event.detail === 0) return;
    const target = event.target as HTMLElement;
    const surface = target.closest<HTMLElement>(".markdown-task-block button,.markdown-block-static,.markdown-block-preview");
    if (!surface || target.closest("a,input,.markdown-code-copy")) return;
    const caretDocument = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
    const position = range ? { offsetNode: range.startContainer, offset: range.startOffset }
      : caretDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (!position || !surface.contains(position.offsetNode)) return;
    // Plain text and structural previews map exactly to textarea offsets.
    // Formatted Markdown may hide delimiters; don't guess offsets for it.
    if (surface.textContent !== visibleBlockText(block.source)) return;
    const before = document.createRange();
    before.selectNodeContents(surface);
    before.setEnd(position.offsetNode, position.offset);
    focusBlock(block.id, before.toString().length);
  };
  const bindTextareaRef = (_blockId: string) => (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    bindImeEndListener(element);
  };
  // Apply explicit selections once, during commit. No delayed callback can
  // steal the caret after the user starts selecting or composing text.
  useLayoutEffect(() => {
    const element = listRef.current?.querySelector<HTMLTextAreaElement>(".markdown-block-input");
    if (!element) { focusedTextareaRef.current = null; return; }
    const pending = pendingSelectionRef.current;
    if (imeComposingRef.current) return;
    if (pending?.id === editingId || focusedTextareaRef.current !== element) {
      element.focus({ preventScroll: true });
      const start = pending?.id === editingId ? pending.start : element.value.length;
      const end = pending?.id === editingId ? pending.end : start;
      element.setSelectionRange(start, end);
      pendingSelectionRef.current = null;
    }
    focusedTextareaRef.current = element;
  });

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
    if (value === emittedValueRef.current) return;
    emittedValueRef.current = value;
    documentFormatRef.current = { bom: value.startsWith("\uFEFF"), crlf: value.includes("\r\n") };
    historyRef.current = { past: [], future: [] };
    typingGroupRef.current = null;
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
    const source = serializeDocument(next);
    emittedValueRef.current = source;
    onChange(source);
  };
  const snapshot = (): EditorSnapshot => {
    const textarea = listRef.current?.querySelector<HTMLTextAreaElement>(".markdown-block-input");
    return { blocks, editingId, start: textarea?.selectionStart ?? 0, end: textarea?.selectionEnd ?? 0 };
  };
  const pushHistory = (typingId?: string) => {
    const now = Date.now();
    const group = typingGroupRef.current;
    if (!typingId || group?.id !== typingId || now - group.at > 750) {
      historyRef.current.past.push(snapshot());
      while (historyRef.current.past.length > EDITOR_HISTORY_LIMIT) historyRef.current.past.shift();
    }
    typingGroupRef.current = typingId ? { id: typingId, at: now } : null;
    historyRef.current.future = [];
  };
  const restoreSnapshot = (entry: EditorSnapshot) => {
    typingGroupRef.current = null;
    setSelectedBlockIds([]);
    setBlockMenuId(null);
    if (entry.editingId) focusBlock(entry.editingId, entry.start, entry.end);
    else setEditingId(null);
    commit(entry.blocks);
  };
  const undoBlocks = () => {
    const previous = historyRef.current.past.pop();
    if (previous === undefined) return;
    historyRef.current.future.push(snapshot());
    restoreSnapshot(previous);
  };
  const redoBlocks = () => {
    const next = historyRef.current.future.pop();
    if (next === undefined) return;
    historyRef.current.past.push(snapshot());
    restoreSnapshot(next);
  };

  // Ctrl+Z / Ctrl+Shift+Z inside the canvas restores the previous arrangement.
  // Text and structure share one history, including edits across block boundaries.
  // Delete/Backspace with selected blocks removes them in one undoable step.
  const handleHistoryShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selectedBlockIds.length > 0) {
      event.preventDefault();
      releaseTextSelection();
      setSelectedBlockIds([]);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedBlockIds.length > 0) {
      const target = event.target as HTMLElement;
      if (target.closest("textarea,input,select")) return;
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
  const actionTargets = (block: MarkdownBlock) => selectedBlockIds.includes(block.id) ? selectedBlockIds : [block.id];
  const selectionForHandle = (id: string) => {
    const globalSelection = new Set(getSelectedIdsOfKind("markdown-block"));
    // Adopt a canvas marquee before opening a menu: clicking the menu clears
    // the global selection, so batch actions must retain their own snapshot.
    return globalSelection.has(id)
      ? blocks.filter((block) => globalSelection.has(block.id)).map((block) => block.id)
      : selectedBlockIds.includes(id) ? selectedBlockIds : [id];
  };
  const applyBlockStyle = (block: MarkdownBlock, style: Partial<BlockStyle>) => {
    const targets = new Set(actionTargets(block));
    releaseTextSelection();
    pushHistory();
    commit(blocks.map((item) => {
      if (!targets.has(item.id)) return item;
      const current = parseStyledBlock(item.source);
      return { ...item, source: withBlockStyle(current.content, { ...current.style, ...style }) };
    }));
    setBlockMenuId(null);
  };
  const canRunCommand = (block: MarkdownBlock, command: SlashCommand) => {
    const action = command.action;
    return action.kind !== "turn" || action.value === "todo"
      || !blocks.some((item) => actionTargets(block).includes(item.id) && hasTaskIdentity(item.source));
  };
  const runSlashCommand = (block: MarkdownBlock, command: SlashCommand, fromSlash = false) => {
    if (!canRunCommand(block, command)) return;
    releaseTextSelection();
    const targets = new Set(fromSlash ? [block.id] : actionTargets(block));
    const action = command.action;
    let number = 0;
    const convertedIds: string[] = [];
    pushHistory();
    const next = blocks.flatMap((item): MarkdownBlock[] => {
      if (!targets.has(item.id)) return [item];
      const styled = parseStyledBlock(item.source);
      const slash = fromSlash ? trailingSlash(styled.content) : null;
      const content = slash ? styled.content.slice(0, slash.start).trimEnd() : styled.content;
      if (action.kind === "color" || action.kind === "background") {
        return [{ ...item, source: withBlockStyle(content, { ...styled.style, [action.kind]: action.value }) }];
      }
      if (action.value === "todo" && deriveBlockKind(content).kind === "task") {
        return [{ ...item, source: withBlockStyle(content, styled.style) }];
      }
      const plain = visibleBlockText(content);
      const kind = deriveBlockKind(content).kind;
      const lines = action.value === "code" || action.value === "text" || action.value === "divider" ? [plain]
        : kind === "paragraph" || kind === "code" ? plain.split("\n") : [plain.replace(/\n/g, "<br>")];
      return lines.map((line, index) => {
        const converted = action.value === "text" ? line
          : action.value.startsWith("h") ? `${"#".repeat(Number(action.value.slice(1)))} ${line}`
          : action.value === "todo" ? `- [ ] ${line}`
          : action.value === "bullet" ? `- ${line}`
          : action.value === "number" ? `${++number}. ${line}`
          : action.value === "quote" ? `> ${line}`
          : action.value === "code" ? `\`\`\`\n${line}\n\`\`\`` : "---";
        const id = index === 0 ? item.id : newBlockId();
        convertedIds.push(id);
        return { ...item, id, source: withBlockStyle(converted, styled.style) };
      });
    });
    if (editingId && targets.has(editingId)) {
      const edited = next.find((item) => item.id === editingId);
      if (edited) focusBlock(edited.id, visibleBlockText(edited.source).length);
    }
    commit(next);
    if (!fromSlash && selectedBlockIds.length > 0 && convertedIds.length > 0) {
      setSelectedBlockIds(next.filter((item) => targets.has(item.id) || convertedIds.includes(item.id)).map((item) => item.id));
    }
    setActiveCommand(0);
    if (action.kind === "turn" && action.value === "divider") setEditingId(null);
  };
  const updateTypedBlock = (block: MarkdownBlock, source: string) => {
    // Marker-only blocks become their final visual form as soon as the last
    // marker character lands. Heading/list/quote markers already restyle the
    // live textarea on their trailing space through deriveBlockKind().
    if (/^\s*```$/.test(source)) {
      pushHistory();
      updateBlockContent(block, "```\n\n```");
      focusBlock(block.id, 0);
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
    pushHistory(block.id);
    updateBlockContent(block, source);
  };
  const removeBlock = (id: string) => {
    const target = blocks.find((block) => block.id === id);
    if (!target) return;
    const targets = new Set(actionTargets(target));
    pushHistory();
    let remaining = blocks.filter((block) => !targets.has(block.id));
    for (const rowId of new Set(blocks.filter((block) => targets.has(block.id)).map((block) => block.rowId))) {
      if (rowId) remaining = reindexRow(remaining, rowId);
    }
    commit(remaining.length > 0 ? remaining : [{ id: newBlockId(), source: "" }]);
    if (editingId && targets.has(editingId)) setEditingId(null);
    setSelectedBlockIds([]);
    setBlockMenuId(null);
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
    const original = blocks.find((item) => item.id === id);
    if (!original) return;
    const targets = new Set(actionTargets(original));
    const copies = blocks.filter((item) => targets.has(item.id)).map((item) => {
      const styled = parseStyledBlock(item.source);
      const content = hasTaskIdentity(item.source) ? styled.content.replace(TASK_IDENTITY_COMMENT, "") : styled.content;
      return { ...item, id: newBlockId(), source: withBlockStyle(content, styled.style) };
    });
    pushHistory();
    const index = blocks.reduce((last, item, position) => targets.has(item.id) ? position : last, -1);
    commit([...blocks.slice(0, index + 1), ...copies, ...blocks.slice(index + 1)]);
    setSelectedBlockIds(copies.map((item) => item.id));
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

  const handleTextKeydown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    block: MarkdownBlock,
  ): boolean => {
    const textarea = event.currentTarget;
    const styled = parseStyledBlock(block.source);
    const kind = deriveBlockKind(styled.content).kind;
    const text = textarea.value;
    const start = Math.min(text.length, textarea.selectionStart);
    const end = Math.min(text.length, textarea.selectionEnd);
    const index = blocks.findIndex((item) => item.id === block.id);
    const modifier = event.ctrlKey || event.metaKey;
    if (imeComposingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;

    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redoBlocks(); else undoBlocks();
      return true;
    }
    if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault(); event.stopPropagation(); redoBlocks(); return true;
    }
    if (event.key === "Escape" || (modifier && event.key === "Enter")) {
      event.preventDefault(); event.stopPropagation();
      if (modifier && kind === "task") toggleTask(block.id, 0, !/^\s*[-*+]\s+\[[xX]\]/.test(styled.content));
      else textarea.blur();
      return true;
    }
    const slash = kind === "code" ? null : trailingSlash(styled.content);
    const commandOptions = slash ? filteredCommands(slash.query) : [];
    const slashKey = slash ? `${block.id}:${styled.content}` : null;
    if (slash && slashKey !== dismissedSlash && commandOptions.length > 0 && start === end && end === text.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveCommand((current) => (current + delta + commandOptions.length) % commandOptions.length);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey && !modifier) {
        event.preventDefault();
        runSlashCommand(block, commandOptions[Math.min(activeCommand, commandOptions.length - 1)]!, true);
        return true;
      }
    }
    if (modifier && !event.altKey && ["b", "i", "e"].includes(event.key.toLowerCase()) && kind !== "code") {
      event.preventDefault(); event.stopPropagation();
      const marker = event.key.toLowerCase() === "b" ? "**" : event.key.toLowerCase() === "i" ? "*" : "`";
      const wrapped = start >= marker.length && text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker;
      const next = wrapped ? text.slice(0, start - marker.length) + text.slice(start, end) + text.slice(end + marker.length)
        : text.slice(0, start) + marker + text.slice(start, end) + marker + text.slice(end);
      pushHistory();
      focusBlock(block.id, start + (wrapped ? -marker.length : marker.length), end + (wrapped ? -marker.length : marker.length));
      updateBlock(block.id, withVisibleBlockText(block.source, next));
      return true;
    }
    if (modifier || event.altKey) return false;

    // Native deletion and Shift+arrow selection stay inside the text field.
    // Only collapsed selections at a block boundary can merge blocks.
    if ((event.key === "Backspace" && start === 0 && end === 0)
      || (event.key === "Delete" && start === text.length && end === start)) {
      const backward = event.key === "Backspace";
      const left = backward ? blocks[index - 1] : block;
      const right = backward ? block : blocks[index + 1];
      if (!left || !right) {
        if (backward && kind !== "paragraph" && kind !== "code" && !hasTaskIdentity(block.source)) {
          event.preventDefault(); pushHistory(); focusBlock(block.id, 0);
          updateBlockContent(block, text);
          return true;
        }
        return false;
      }
      const leftKind = deriveBlockKind(left.source).kind;
      const rightKind = deriveBlockKind(right.source).kind;
      // Never consume an attachment, fenced code, another column or a managed
      // task's identity through a text-boundary delete.
      if (left.rowId !== right.rowId || left.col !== right.col
        || [leftKind, rightKind].some((entry) => entry === "code" || entry === "divider")
        || parseStandaloneAttachment(parseStyledBlock(left.source).content)
        || parseStandaloneAttachment(parseStyledBlock(right.source).content)
        || hasTaskIdentity(right.source)) return false;
      event.preventDefault(); event.stopPropagation(); pushHistory();
      const leftText = visibleBlockText(left.source);
      focusBlock(left.id, leftText.length);
      const merged = blocks.filter((item) => item.id !== right.id).map((item) => item.id === left.id
        ? { ...item, source: withVisibleBlockText(left.source, leftText + visibleBlockText(right.source)) } : item);
      commit(renumberFollowing(merged, merged.findIndex((item) => item.id === left.id)));
      return true;
    }
    if (event.key === "Tab" && ["task", "bullet", "ordered"].includes(kind)) {
      event.preventDefault(); pushHistory();
      const content = event.shiftKey ? styled.content.replace(/^(?: {1,2}|\t)/, "") : `  ${styled.content}`;
      focusBlock(block.id, start, end); updateBlockContent(block, content); return true;
    }
    if ((event.key === "ArrowUp" && start === 0) || (event.key === "ArrowDown" && end === text.length)) {
      if (event.shiftKey || start !== end) return false;
      const adjacent = blocks[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (!adjacent || adjacent.rowId !== block.rowId || adjacent.col !== block.col
        || parseStandaloneAttachment(parseStyledBlock(adjacent.source).content)) return false;
      event.preventDefault(); focusBlock(adjacent.id, event.key === "ArrowUp" ? visibleBlockText(adjacent.source).length : 0);
      return true;
    }
    if (event.key !== "Enter") return false;
    event.preventDefault(); event.stopPropagation();
    if (kind === "code" && !styled.content.includes("\n")) {
      pushHistory(); focusBlock(block.id, 0);
      updateBlockContent(block, styled.content + "\n\n" + styled.content.slice(0, 3)); return true;
    }
    if (kind === "code" || event.shiftKey) {
      pushHistory(); focusBlock(block.id, start + 1);
      updateBlock(block.id, withVisibleBlockText(block.source, text.slice(0, start) + "\n" + text.slice(end)));
      return true;
    }
    if (/^\s*\[\]\s*$/.test(text) && kind === "paragraph") {
      pushHistory(); focusBlock(block.id, 0); updateBlockContent(block, "- [ ] "); return true;
    }
    if (kind === "divider") { addBlock(index); return true; }
    const list = parseListPrefix(styled.content);
    if (list && !text.trim() && !hasTaskIdentity(block.source)) {
      pushHistory(); focusBlock(block.id, 0);
      updateBlockContent(block, list.indent ? styled.content.replace(/^(?: {1,2}|\t)/, "") : "");
      return true;
    }
    pushHistory();
    let prefix = "";
    if (list) {
      const ordered = list.marker.match(/^(\d+)([.)、][ \t]*)$/);
      const marker = kind === "task" ? list.marker.replace(/\[[xX]\]/, "[ ]")
        : ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : list.marker;
      prefix = list.indent + marker;
    }
    const created = { ...block, id: newBlockId(), source: withBlockStyle(prefix + text.slice(end).replace(/\n/g, prefix ? "<br>" : "\n"), styled.style) };
    focusBlock(created.id, 0);
    const split = blocks.flatMap((item) => item.id === block.id
      ? [{ ...item, source: withVisibleBlockText(block.source, text.slice(0, start)) }, created] : [item]);
    commit(renumberFollowing(split, index));
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
    if ((event.target as HTMLElement).closest("input,textarea,select,button,a,[contenteditable=true],.markdown-selection-toolbar,.markdown-block-menu")) return;
    event.preventDefault();
    event.stopPropagation();
    releaseTextSelection();
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
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.stopPropagation();
    const selected = selectionForHandle(id);
    setSelectedBlockIds(selected);
    dragRef.current = {
      id,
      ids: selected,
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
        return current?.rowId === dest.rowId && current?.col === dest.col;
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
      onPointerDownCapture={(event) => {
        if ((event.target as HTMLElement).closest(".markdown-block-tools,.markdown-block-menu,.markdown-selection-toolbar")) {
          syncTextSelection();
          // Controls may collapse the native range on focus. Keep the batch
          // snapshot until the user finishes the command or clears selection.
          nativeTextSelectionRef.current = false;
        }
        beginMarqueeSelection(event);
      }}
      onPointerMove={moveMarqueeSelection}
      onPointerUp={endMarqueeSelection}
      onPointerCancel={cancelMarqueeSelection}
      onClickCapture={(event) => {
        if (performance.now() < suppressCanvasClickUntilRef.current
          || ((event.target as HTMLElement).closest(".markdown-block-content") && selectedTextBlockIds(editorRef.current).length > 1)) {
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
          const kindClass = `kind-${kind}${level ? `-h${level}` : ""}`;
          const currentTurnValue = kind === "heading" ? `h${level}`
            : kind === "task" ? "todo"
            : kind === "ordered" ? "number"
            : kind === "paragraph" ? "text"
            : kind;
          const currentBlockLabel = blockCommands.find((command) => command.action.kind === "turn" && command.action.value === currentTurnValue)?.label
            ?? (zh ? "文字" : "Text");
          const slash = isEditing && kind !== "code" ? trailingSlash(styled.content) : null;
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
              style={{
                ...(block.rowId ? {} : { gridColumn: "1 / -1" }),
                paddingLeft: ["task", "bullet", "ordered", "quote"].includes(kind)
                  ? (styled.content.match(/^[ \t]+/)?.[0].replace(/\t/g, "  ").length ?? 0) * 10 : undefined,
              }}
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
                  title={zh ? "拖曳排序；Shift 點選連選，Ctrl 點選多選" : "Drag to reorder; Shift-click a range, Ctrl-click to select"}
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
                    if (event.shiftKey || event.ctrlKey || event.metaKey) {
                      const anchor = blocks.findIndex((item) => item.id === selectionAnchorRef.current);
                      setSelectedBlockIds((selected) => event.shiftKey && anchor >= 0
                        ? blocks.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((item) => item.id)
                        : selected.includes(block.id) ? selected.filter((id) => id !== block.id) : [...selected, block.id]);
                      if (!event.shiftKey || anchor < 0) selectionAnchorRef.current = block.id;
                      setBlockMenuId(null);
                      setEditingId(null);
                      return;
                    }
                    selectionAnchorRef.current = block.id;
                    setSelectedBlockIds(selectionForHandle(block.id));
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
              <div className="markdown-block-content" onClickCapture={(event) => beginPointerEdit(event, block)}>
                {isEditing && singleTaskMatch ? (
                  <div className="markdown-task-edit-row">
                    <input
                      type="checkbox"
                      checked={singleTaskMatch[2]!.toLowerCase() === "x"}
                      aria-label={zh ? "切換待辦狀態" : "Toggle task"}
                      onChange={(event) => toggleTask(block.id, 0, event.currentTarget.checked)}
                    />
                    <textarea
                      value={visibleBlockText(block.source)}
                      rows={1}
                      onFocus={() => { setSelectedBlockIds([]); typingGroupRef.current = null; }}
                      className="markdown-block-input markdown-task-input kind-task"
                      aria-label={zh ? "編輯待辦內容" : "Edit task content"}
                      placeholder={zh ? "輸入待辦內容" : "Type task content"}
                      onChange={(event) => {
                        updateTypedBlock(block, parseStyledBlock(withVisibleBlockText(block.source, event.target.value)).content);
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
                        handleTextKeydown(event, block);
                      }}
                    />
                  </div>
                ) : isEditing ? (
                  <div className={`markdown-structural-edit-row ${presentation.marker ? "has-marker" : ""}`}>
                    {presentation.marker && <span aria-hidden="true">{presentation.marker}</span>}
                    <textarea
                      value={visibleBlockText(block.source)}
                      rows={1}
                      onFocus={() => { setSelectedBlockIds([]); typingGroupRef.current = null; }}
                      className={`markdown-block-input ${kindClass}`}
                      aria-label={zh ? "編輯 Markdown 區塊" : "Edit Markdown block"}
                      placeholder={zh ? "輸入文字，或輸入 / 使用指令" : "Type text, or press / for commands"}
                      onChange={(event) => {
                        setActiveCommand(0);
                        updateTypedBlock(block, parseStyledBlock(withVisibleBlockText(block.source, event.target.value)).content);
                      }}
                      onBlur={() => finishEditing(block.id)}
                      ref={bindTextareaRef(block.id)}
                      onKeyDown={(event) => {
                        const ime = imeEnterDisposition(event);
                        if (ime !== false) {
                          if (ime === "echo") event.preventDefault();
                          return;
                        }
                        handleTextKeydown(event, block);
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
                        <div key={index} className="markdown-block-static-line">{stripBlockPrefixForPreview(line, kind).replace(/<br\s*\/?\s*>/gi, "\n")}</div>
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
                            {splitTaskIdentity(match[3] ?? "").visible.replace(/<br\s*\/?\s*>/gi, "\n") || (zh ? "輸入待辦內容" : "Type task content")}
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
                        disabled={!canRunCommand(block, command)}
                        onClick={() => runSlashCommand(block, command, true)}
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
                        return <button type="button" role="menuitemradio" aria-checked={active} disabled={!canRunCommand(block, command)} title={!canRunCommand(block, command) ? (zh ? "追蹤中的任務需保留待辦格式" : "Tracked tasks must keep their checkbox") : undefined} className="markdown-block-menu-row" key={command.id} onClick={() => { runSlashCommand(block, command); setBlockMenuId(null); }}>
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
                      {colorNames.map(([color, name]) => <button type="button" role="menuitemradio" aria-checked={styled.style.color === color} className={styled.style.color === color ? "active" : ""} data-color={color} aria-label={zh ? `${name}文字` : `${name} text`} title={name} key={`text-${color}`} onClick={() => applyBlockStyle(block, { color })} />)}
                    </div>
                    <strong>{zh ? "底色" : "Background"}</strong>
                    <div className="markdown-color-grid background-grid">
                      {colorNames.map(([background, name]) => <button type="button" role="menuitemradio" aria-checked={styled.style.background === background} className={styled.style.background === background ? "active" : ""} data-color={background} aria-label={zh ? `${name}底色` : `${name} background`} title={name} key={`background-${background}`} onClick={() => applyBlockStyle(block, { background })} />)}
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
      {selectedBlockIds.length > 0 && <div className="markdown-selection-toolbar" role="toolbar" aria-label={zh ? "已選區塊操作" : "Selected block actions"}>
        <span>{zh ? `已選 ${selectedBlockIds.length} 個區塊` : `${selectedBlockIds.length} blocks selected`}</span>
        <select aria-label={zh ? "批次轉換成" : "Turn selected blocks into"} value="" onChange={(event) => {
          const command = blockCommands.find((item) => item.id === event.target.value);
          const first = blocks.find((item) => selectedBlockIds.includes(item.id));
          if (command && first) runSlashCommand(first, command);
        }}>
          <option value="" disabled>{zh ? "轉換成…" : "Turn into…"}</option>
          {blockCommands.map((command) => <option key={command.id} value={command.id}
            disabled={!canRunCommand(blocks.find((item) => selectedBlockIds.includes(item.id)) ?? blocks[0]!, command)}>{command.label}</option>)}
        </select>
        <select aria-label={zh ? "批次文字顏色" : "Selected text color"} value="" onChange={(event) => {
          const first = blocks.find((item) => selectedBlockIds.includes(item.id));
          if (first) applyBlockStyle(first, { color: event.target.value as BlockColor });
        }}>
          <option value="" disabled>{zh ? "文字顏色…" : "Text color…"}</option>
          {colorNames.map(([color, name]) => <option key={color} value={color}>{name}</option>)}
        </select>
        <button type="button" onClick={() => { releaseTextSelection(); setSelectedBlockIds([]); setBlockMenuId(null); }}>{zh ? "取消選取" : "Clear selection"}</button>
      </div>}
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
