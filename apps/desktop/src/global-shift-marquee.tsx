import { useEffect, useState } from "react";

type MarqueeBox = { left: number; top: number; width: number; height: number };

const SELECTABLE = "[data-global-select-id]";
const SELECTED_CLASS = "global-shift-selected";
const MARQUEE_DELETE_EVENT = "second-brain:global-selection-delete";
/** Floating panels a Shift marquee must never start from. */
const OVERLAY_SELECTOR =
  ".modal,.modal-backdrop,.detail-dialog,.detail-dialog-panel,.day-schedule-composer,.project-picker-menu,.markdown-block-menu,.markdown-slash-menu,.detail-task-composer,.detail-task-list";
/** Elements a plain (no Shift) box-selection must never start from: any
 *  control, any already-selectable chip, and the surfaces that run their
 *  own marquee. */
const PLAIN_BLOCK_SELECTOR =
  `button, input, textarea, select, a, [contenteditable="true"], [data-global-select-id], .day-schedule, .markdown-block-editor, ${OVERLAY_SELECTOR}`;

/**
 * Module-level selection mirror. The DOM `classList` is the *display* of
 * the selection, but React replaces `className` on every re-render which
 * silently drops that class. We keep the source of truth here so calls
 * like `getGlobalSelectedIds` keep working mid-drag even after the
 * surrounding component re-renders.
 */
const selectedIds = new Set<string>();
const selectedKinds = new Map<string, string>();

const setSelected = (id: string, kind: string) => {
  selectedIds.add(id);
  selectedKinds.set(id, kind);
};
const unsetSelected = (id: string) => {
  selectedIds.delete(id);
  selectedKinds.delete(id);
};
const resetSelection = () => {
  selectedIds.clear();
  selectedKinds.clear();
};

/** Timestamp until which the click following a plain box-drag is swallowed. */
let marqueeClickSuppressedUntil = 0;

const cssEscape = (value: string): string => {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  // Minimal CSS.escape polyfill for happy-dom (which does not expose CSS).
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
};
const applyClass = (id: string, on: boolean) => {
  const element = document.querySelector<HTMLElement>(`${SELECTABLE}[data-global-select-id="${cssEscape(id)}"]`);
  if (element) element.classList.toggle(SELECTED_CLASS, on);
};

/** Removes the global selection class from every selected element. */
export function clearGlobalSelection() {
  for (const id of [...selectedIds]) {
    applyClass(id, false);
    unsetSelected(id);
  }
}

/**
 * Adds an id to the module-level selection mirror. Useful for surfaces
 * (e.g. day-schedule-view's tests) that want to mark elements as selected
 * without going through the marquee, so `getGlobalSelectedIds` returns
 * them. Also paints the visible class onto the DOM element.
 */
export function addToSelection(id: string, kind: string): void {
  setSelected(id, kind);
  applyClass(id, true);
}

/**
 * Replaces the mirrored selection of one kind without touching the DOM.
 * Surfaces that paint their own selected state (the day schedule uses its
 * internal `selected` class) mirror their id list here so window-level
 * shortcuts such as Delete see the same selection. Other kinds survive.
 */
export function setSelectionOfKind(kind: string, ids: readonly string[]): void {
  const keep = new Set(ids);
  for (const id of [...selectedIds]) {
    if ((selectedKinds.get(id) ?? "task") === kind && !keep.has(id)) unsetSelected(id);
  }
  for (const id of keep) setSelected(id, kind);
}

/** Returns the ids of currently selected elements of `kind`. */
export function getSelectedIdsOfKind(kind: string): string[] {
  return [...selectedIds].filter((id) => (selectedKinds.get(id) ?? "task") === kind);
}

/**
 * True once after a plain (no Shift) box-drag finished, so surfaces can
 * swallow the trailing click the browser synthesizes on the element under
 * the release point (a month cell would otherwise treat the marquee as a
 * "select this date" click). Consuming resets it, keeping the suppression
 * strictly one-shot.
 */
export function consumeGlobalMarqueeClick(): boolean {
  if (performance.now() >= marqueeClickSuppressedUntil) return false;
  marqueeClickSuppressedUntil = 0;
  return true;
}

function intersects(box: MarqueeBox, rect: DOMRect): boolean {
  return box.left <= rect.right
    && box.left + box.width >= rect.left
    && box.top <= rect.bottom
    && box.top + box.height >= rect.top;
}

export function getGlobalSelectedIds(fallbackId: string, kind = "task"): string[] {
  const selected = getSelectedIdsOfKind(kind);
  return selected.includes(fallbackId) ? [...new Set(selected)] : [fallbackId];
}

export function GlobalShiftMarquee() {
  const [box, setBox] = useState<MarqueeBox | null>(null);

  useEffect(() => {
    // `mode` distinguishes the classic Shift+drag (starts anywhere, engages
    // immediately) from the Notion-style plain drag, which only arms on the
    // background of an opt-in `[data-plain-marquee-scope]` area and must
    // stay invisible until the pointer actually moves, so an ordinary click
    // keeps its normal behaviour.
    let origin: { x: number; y: number; pointerId: number; mode: "shift" | "plain" } | null = null;
    let moved = false;
    let engaged = false;

    const update = (next: MarqueeBox) => {
      // Walk every selectable element once: clear the previous selection,
      // then mark whatever is inside the marquee. We reapply the class
      // afterwards so React re-renders that drop the class silently get
      // it back on the next tick.
      const elements = [...document.querySelectorAll<HTMLElement>(SELECTABLE)];
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        const id = element.dataset.globalSelectId;
        const kind = element.dataset.globalSelectKind ?? "task";
        if (!id) continue;
        const inside = rect.width > 0 && rect.height > 0 && intersects(next, rect);
        if (inside) {
          setSelected(id, kind);
          element.classList.add(SELECTED_CLASS);
        } else {
          unsetSelected(id);
          element.classList.remove(SELECTED_CLASS);
        }
      }
    };
    const pointerDown = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      // A marquee that starts inside a modal or floating detail panel would
      // otherwise sweep the whole document and steal the selection from the
      // panel that sits behind it. The panel that *does* own the pointerdown
      // runs its own block-level marquee, so we stay out of the way here.
      const insideOverlay = Boolean(target?.closest(OVERLAY_SELECTOR));
      if (
        event.shiftKey
        && event.button === 0
        && !target?.closest(".day-schedule,.markdown-block-editor")
        && !insideOverlay
      ) {
        origin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, mode: "shift" };
        moved = false;
        engaged = true;
        clearGlobalSelection();
        setBox({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Notion-style: dragging empty canvas box-selects without Shift. Only
      // inside opt-in scopes and only from the background — a plain press on
      // a chip or control keeps its normal behaviour (open, toggle, clear…).
      if (
        event.button === 0
        && target
        && target.closest("[data-plain-marquee-scope]")
        && !target.closest(PLAIN_BLOCK_SELECTOR)
      ) {
        origin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, mode: "plain" };
        moved = false;
        engaged = false;
        return;
      }
      if (!event.shiftKey && !target?.closest(`${SELECTABLE}.${SELECTED_CLASS}`)) clearGlobalSelection();
    };
    const pointerMove = (event: PointerEvent) => {
      if (!origin || event.pointerId !== origin.pointerId) return;
      const next = {
        left: Math.min(origin.x, event.clientX),
        top: Math.min(origin.y, event.clientY),
        width: Math.abs(event.clientX - origin.x),
        height: Math.abs(event.clientY - origin.y),
      };
      moved ||= next.width > 3 || next.height > 3;
      if (origin.mode === "plain" && !engaged) {
        // Below the drag threshold this is still a click — do nothing at all.
        if (!moved) return;
        engaged = true;
        clearGlobalSelection();
      }
      setBox(next);
      update(next);
      event.preventDefault();
    };
    const pointerUp = (event: PointerEvent) => {
      if (!origin || event.pointerId !== origin.pointerId) return;
      const mode = origin.mode;
      const dragMoved = moved;
      origin = null;
      engaged = false;
      setBox(null);
      if (dragMoved) {
        event.preventDefault();
        event.stopPropagation();
        if (mode === "plain") marqueeClickSuppressedUntil = performance.now() + 350;
        return;
      }
      // Notion semantics: a plain click on the canvas (no drag) deselects,
      // exactly like the old non-shift fall-through did before we started
      // arming the plain marquee on pointerdown.
      if (mode === "plain") clearGlobalSelection();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearGlobalSelection();
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Typing surfaces keep their native delete behaviour.
      if (target?.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
      // Group the mirrored selection by kind so each surface deletes its own
      // things in one step: blocks go to the block editor, tasks to the
      // calendar/today listeners.
      const byKind = new Map<string, string[]>();
      for (const id of selectedIds) {
        const kind = selectedKinds.get(id) ?? "task";
        byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
      }
      if (byKind.size === 0) return;
      event.preventDefault();
      event.stopPropagation();
      for (const [kind, ids] of byKind) dispatchGlobalSelectionDelete({ ids, kind });
      clearGlobalSelection();
    };
    // Capture phase: after a marquee the focus usually sits on <body>,
    // outside the React tree, and React's synthetic key handlers never see
    // the event. Window capture catches Delete/Backspace no matter where
    // focus is, then stops propagation so per-view handlers cannot double-fire.
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerUp, true);
    window.addEventListener("keydown", keyDown, true);
    return () => {
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerUp, true);
      window.removeEventListener("keydown", keyDown, true);
      clearGlobalSelection();
    };
  }, []);

  return box ? (
    <div
      className="global-selection-marquee"
      data-global-selection-marquee
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      aria-hidden="true"
    />
  ) : null;
}

/**
 * Fires when the user presses Delete (or Backspace) while the global marquee has
 * something selected. Each surface decides how to handle its own selection —
 * markdown block editor deletes blocks, calendar / board reschedule tasks, etc.
 * The event's detail carries the selected ids and the originating kind so
 * listeners can decide whether they own the selection.
 */
export interface GlobalSelectionDeleteDetail {
  ids: string[];
  kind: string;
}
export function dispatchGlobalSelectionDelete(detail: GlobalSelectionDeleteDetail): void {
  window.dispatchEvent(new CustomEvent(MARQUEE_DELETE_EVENT, { detail }));
}
export const GLOBAL_SELECTION_DELETE_EVENT = MARQUEE_DELETE_EVENT;
