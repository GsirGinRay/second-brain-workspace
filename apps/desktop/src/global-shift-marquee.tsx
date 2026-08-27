import { useEffect, useState } from "react";

type MarqueeBox = { left: number; top: number; width: number; height: number };

const SELECTABLE = "[data-global-select-id]";
const SELECTED_CLASS = "global-shift-selected";

export function clearGlobalSelection() {
  document.querySelectorAll(`${SELECTABLE}.${SELECTED_CLASS}`).forEach((element) => element.classList.remove(SELECTED_CLASS));
}

function intersects(box: MarqueeBox, rect: DOMRect): boolean {
  return box.left <= rect.right
    && box.left + box.width >= rect.left
    && box.top <= rect.bottom
    && box.top + box.height >= rect.top;
}

export function getGlobalSelectedIds(fallbackId: string, kind = "task"): string[] {
  const selected = [...document.querySelectorAll<HTMLElement>(`${SELECTABLE}.${SELECTED_CLASS}`)]
    .filter((element) => (element.dataset.globalSelectKind ?? "task") === kind)
    .flatMap((element) => element.dataset.globalSelectId ? [element.dataset.globalSelectId] : []);
  return selected.includes(fallbackId) ? [...new Set(selected)] : [fallbackId];
}

export function GlobalShiftMarquee() {
  const [box, setBox] = useState<MarqueeBox | null>(null);

  useEffect(() => {
    let origin: { x: number; y: number; pointerId: number } | null = null;
    let moved = false;

    const update = (next: MarqueeBox) => {
      document.querySelectorAll<HTMLElement>(SELECTABLE).forEach((element) => {
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        element.classList.toggle(SELECTED_CLASS, visible && intersects(next, rect));
      });
    };
    const pointerDown = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!event.shiftKey || event.button !== 0 || target?.closest(".day-schedule,.markdown-block-editor")) {
        if (!event.shiftKey && !target?.closest(`${SELECTABLE}.${SELECTED_CLASS}`)) clearGlobalSelection();
        return;
      }
      origin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      moved = false;
      clearGlobalSelection();
      setBox({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
      event.preventDefault();
      event.stopPropagation();
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
      setBox(next);
      update(next);
      event.preventDefault();
    };
    const pointerUp = (event: PointerEvent) => {
      if (!origin || event.pointerId !== origin.pointerId) return;
      origin = null;
      setBox(null);
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearGlobalSelection();
    };
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerUp, true);
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerUp, true);
      window.removeEventListener("keydown", keyDown);
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
