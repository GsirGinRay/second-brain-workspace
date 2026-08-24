import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, GripVertical, Trash2 } from "lucide-react";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  durationFromResize,
  formatMinutesAsTime,
  layoutTimedBlocks,
  MIN_BLOCK_HEIGHT,
  minutesFromOffset,
  parseTimeToMinutes,
  PX_PER_HOUR,
  snapMinutes,
  taipeiMinutesOfDay,
  timeFromSlotDrop,
} from "./day-schedule";
import { PriorityControl } from "./priority-control";
import type { UiLanguage } from "./ui-preferences";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

type DragKind = "timed" | "loose" | "resize";

export interface DayScheduleLabels {
  unscheduled: string;
  dropToSchedule: string;
  addAtTime: (time: string) => string;
  empty: string;
  editTitle: string;
  editPriority: string;
  complete: string;
  reopen: string;
  delete: string;
  resize: string;
}

export function DaySchedule({
  date,
  timedTasks,
  trayTasks = [],
  allDayTasks = [],
  showTray = true,
  now,
  labels,
  onSchedule,
  onClearTime,
  onCreateAt,
  onOpenTask,
  onPriority,
  onDelete,
  onComplete,
  onResize,
  locale = "zh-TW",
}: {
  date: string;
  timedTasks: BrainTaskSnapshot[];
  trayTasks?: BrainTaskSnapshot[];
  allDayTasks?: BrainTaskSnapshot[];
  showTray?: boolean;
  now?: Date;
  labels: DayScheduleLabels;
  onSchedule: (taskId: string, startTime: string) => void;
  onClearTime?: (taskId: string) => void;
  onCreateAt: (title: string, startTime: string) => void;
  onOpenTask?: (taskId: string) => void;
  onPriority?: (taskId: string, priority: BrainTaskSnapshot["priority"]) => void;
  onDelete?: (task: BrainTaskSnapshot) => void;
  onComplete?: (task: BrainTaskSnapshot) => void;
  onResize?: (taskId: string, durationMinutes: number) => void;
  locale?: UiLanguage;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [composer, setComposer] = useState<{ time: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [previewTop, setPreviewTop] = useState<number | null>(null);
  const [previewHeight, setPreviewHeight] = useState<number | null>(null);
  const [previewTime, setPreviewTime] = useState<string | null>(null);
  const dragOrigin = useRef<{
    id: string;
    kind: DragKind;
    startMinutes: number;
    duration: number;
    grabOffsetMinutes: number;
    startScrollTop: number;
    startClientX: number;
    startClientY: number;
  } | null>(null);
  const autoScrollRef = useRef<number | null>(null);
  const moved = useRef(false);
  const suppressClickUntil = useRef(0);
  const layouts = useMemo(
    () =>
      layoutTimedBlocks(
        timedTasks.flatMap((task) =>
          task.id && task.startTime
            ? [{ id: task.id, startTime: task.startTime, durationMinutes: task.durationMinutes ?? null }]
            : [],
        ),
      ),
    [timedTasks],
  );
  const layoutById = useMemo(
    () => new Map(layouts.map((item) => [item.id, item])),
    [layouts],
  );
  const nowMinutes = now ? taipeiMinutesOfDay(now) : null;
  const isToday = Boolean(now);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const currentMinutes = now ? taipeiMinutesOfDay(now) : null;
    const target = currentMinutes != null
      ? Math.max(0, (currentMinutes / 60) * PX_PER_HOUR - PX_PER_HOUR * 2)
      : PX_PER_HOUR * 7;
    grid.scrollTop = target;
  }, [date, now]);

  const stopAutoScroll = () => {
    if (autoScrollRef.current != null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(autoScrollRef.current);
      } else if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(autoScrollRef.current);
      }
      autoScrollRef.current = null;
    }
  };

  const checkAutoScroll = (clientY: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : null;
    if (!raf) return;

    const rect = grid.getBoundingClientRect();
    const topEdge = rect.top + 40;
    const bottomEdge = rect.bottom - 40;

    stopAutoScroll();

    if (clientY < topEdge && grid.scrollTop > 0) {
      const intensity = Math.min(1, Math.max(0.1, (topEdge - clientY) / 40));
      const step = () => {
        if (!gridRef.current) return;
        gridRef.current.scrollTop -= Math.round(10 * intensity);
        if (gridRef.current.scrollTop > 0) {
          autoScrollRef.current = raf(step);
        }
      };
      autoScrollRef.current = raf(step);
    } else if (clientY > bottomEdge && grid.scrollTop < grid.scrollHeight - grid.clientHeight) {
      const intensity = Math.min(1, Math.max(0.1, (clientY - bottomEdge) / 40));
      const step = () => {
        if (!gridRef.current) return;
        gridRef.current.scrollTop += Math.round(10 * intensity);
        if (gridRef.current.scrollTop < gridRef.current.scrollHeight - gridRef.current.clientHeight) {
          autoScrollRef.current = raf(step);
        }
      };
      autoScrollRef.current = raf(step);
    }
  };

  const timeAtPoint = (clientY: number, target: HTMLElement | null) => {
    const slot = target?.closest<HTMLElement>("[data-schedule-minutes]");
    if (slot) {
      const rect = slot.getBoundingClientRect();
      if (rect.height > 0) {
        return timeFromSlotDrop(
          Number(slot.dataset.scheduleMinutes),
          clientY,
          rect.top,
          rect.height,
        );
      }
      return formatMinutesAsTime(snapMinutes(Number(slot.dataset.scheduleMinutes)));
    }
    const grid = target?.closest<HTMLElement>("[data-day-schedule-grid]") ?? gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    return formatMinutesAsTime(minutesFromOffset(clientY - rect.top + grid.scrollTop));
  };

  const resetDrag = () => {
    stopAutoScroll();
    moved.current = false;
    dragOrigin.current = null;
    setDragId(null);
    setPreviewTop(null);
    setPreviewHeight(null);
    setPreviewTime(null);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, taskId: string | null) => {
    if (!taskId) return;
    const origin = dragOrigin.current;
    if (!origin) return;
    const clientX = event.clientX;
    const clientY = event.clientY;

    try {
      if (event.currentTarget && typeof event.currentTarget.releasePointerCapture === "function") {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // ignore
    }

    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const releasedOnSelf = Boolean(target && event.currentTarget.contains(target));
    const isDragMove = moved.current || !releasedOnSelf || Math.hypot(clientX - origin.startClientX, clientY - origin.startClientY) > 3;
    // The browser follows a pointer press and release with a click on the element that
    // contains both, so finishing a drag also fires the card's select handler. Use a
    // self-expiring window so a missing stray click cannot swallow a later real one.
    if (isDragMove) suppressClickUntil.current = performance.now() + 300;
    resetDrag();
    if (!isDragMove) return;

    if (origin.kind === "resize") {
      const grid = gridRef.current;
      const scrollDelta = grid ? grid.scrollTop - origin.startScrollTop : 0;
      const deltaY = (clientY - origin.startClientY) + scrollDelta;
      onResize?.(taskId, durationFromResize(origin.startMinutes, origin.duration, deltaY));
      return;
    }
    if (target?.closest("[data-unscheduled-tray], [data-schedule-all-day]")) {
      onClearTime?.(taskId);
      return;
    }
    const grid = gridRef.current;
    let isInsideGrid = Boolean(target?.closest("[data-day-schedule-grid], [data-schedule-minutes]"));
    if (!isInsideGrid && grid) {
      const rect = grid.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        isInsideGrid = true;
      }
    }
    if (!isInsideGrid) {
      if (showTray && grid) {
        const rect = grid.getBoundingClientRect();
        if (clientX < rect.left) {
          onClearTime?.(taskId);
          return;
        }
      }
      return;
    }
    if (origin.kind === "timed") {
      if (grid) {
        const gridRect = grid.getBoundingClientRect();
        const canvasY = clientY - gridRect.top + grid.scrollTop;
        const currentMinutes = (canvasY / PX_PER_HOUR) * 60;
        const targetMinutes = snapMinutes(currentMinutes - origin.grabOffsetMinutes);
        const maxStart = 24 * 60 - Math.min(60, origin.duration);
        const clampedMinutes = Math.max(0, Math.min(maxStart, targetMinutes));
        onSchedule(taskId, formatMinutesAsTime(clampedMinutes));
      } else {
        const deltaHours = (clientY - origin.startClientY) / PX_PER_HOUR;
        onSchedule(
          taskId,
          formatMinutesAsTime(minutesFromOffset((origin.startMinutes / 60 + deltaHours) * PX_PER_HOUR)),
        );
      }
      return;
    }
    const slot = target?.closest<HTMLElement>("[data-schedule-minutes]");
    if (slot) {
      const rect = slot.getBoundingClientRect();
      if (rect.height > 0) {
        onSchedule(
          taskId,
          timeFromSlotDrop(
            Number(slot.dataset.scheduleMinutes),
            clientY,
            rect.top,
            rect.height,
          ),
        );
        return;
      }
      onSchedule(taskId, formatMinutesAsTime(snapMinutes(Number(slot.dataset.scheduleMinutes))));
      return;
    }
    if (grid) {
      const gridRect = grid.getBoundingClientRect();
      const canvasY = clientY - gridRect.top + grid.scrollTop;
      const targetMinutes = snapMinutes((canvasY / PX_PER_HOUR) * 60);
      const clampedMinutes = Math.max(0, Math.min(24 * 60 - 15, targetMinutes));
      onSchedule(taskId, formatMinutesAsTime(clampedMinutes));
      return;
    }
    const time = timeAtPoint(clientY, target);
    if (time) onSchedule(taskId, time);
  };

  const beginTimedDrag = (event: ReactPointerEvent<HTMLElement>, task: BrainTaskSnapshot) => {
    if (event.button !== 0 || !task.id || !task.startTime) return;
    if ((event.target as HTMLElement).closest("button, input, [data-resize-handle]")) return;
    const startMinutes = parseTimeToMinutes(task.startTime);
    if (startMinutes == null) return;
    moved.current = false;
    const grid = gridRef.current;
    const gridRect = grid?.getBoundingClientRect();
    const canvasY = grid && gridRect ? (event.clientY - gridRect.top + grid.scrollTop) : (startMinutes / 60) * PX_PER_HOUR;
    const clickMinutes = (canvasY / PX_PER_HOUR) * 60;
    const duration = task.durationMinutes ?? 30;
    const grabOffsetMinutes = Math.max(0, Math.min(duration, clickMinutes - startMinutes));
    dragOrigin.current = {
      id: task.id,
      kind: "timed",
      startMinutes,
      duration,
      grabOffsetMinutes,
      startScrollTop: grid?.scrollTop ?? 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    setPreviewTime(task.startTime);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginResize = (event: ReactPointerEvent<HTMLElement>, task: BrainTaskSnapshot) => {
    if (event.button !== 0 || !task.id || !task.startTime) return;
    const startMinutes = parseTimeToMinutes(task.startTime);
    if (startMinutes == null) return;
    event.stopPropagation();
    moved.current = false;
    const grid = gridRef.current;
    dragOrigin.current = {
      id: task.id,
      kind: "resize",
      startMinutes,
      duration: task.durationMinutes ?? 30,
      grabOffsetMinutes: 0,
      startScrollTop: grid?.scrollTop ?? 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveTimedDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragOrigin.current || !gridRef.current) return;
    if (Math.hypot(event.clientX - dragOrigin.current.startClientX, event.clientY - dragOrigin.current.startClientY) > 4) {
      moved.current = true;
      setDragId(dragOrigin.current.id);
    }
    checkAutoScroll(event.clientY);
    if (dragOrigin.current.kind === "resize") {
      const grid = gridRef.current;
      const scrollDelta = grid.scrollTop - dragOrigin.current.startScrollTop;
      const deltaY = (event.clientY - dragOrigin.current.startClientY) + scrollDelta;
      const next = durationFromResize(
        dragOrigin.current.startMinutes,
        dragOrigin.current.duration,
        deltaY,
      );
      setPreviewHeight(Math.max(MIN_BLOCK_HEIGHT, (next / 60) * PX_PER_HOUR));
      return;
    }
    const grid = gridRef.current;
    const gridRect = grid.getBoundingClientRect();
    const canvasY = event.clientY - gridRect.top + grid.scrollTop;
    const currentMinutes = (canvasY / PX_PER_HOUR) * 60;
    const targetMinutes = snapMinutes(currentMinutes - dragOrigin.current.grabOffsetMinutes);
    const maxStart = 24 * 60 - Math.min(60, dragOrigin.current.duration);
    const clampedMinutes = Math.max(0, Math.min(maxStart, targetMinutes));
    setPreviewTop((clampedMinutes / 60) * PX_PER_HOUR);
    setPreviewTime(formatMinutesAsTime(clampedMinutes));
  };

  const moveLooseDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragOrigin.current || !gridRef.current) return;
    if (Math.hypot(event.clientX - dragOrigin.current.startClientX, event.clientY - dragOrigin.current.startClientY) > 4) {
      moved.current = true;
      setDragId(dragOrigin.current.id);
    }
    const grid = gridRef.current;
    const rect = grid.getBoundingClientRect();
    if (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    ) {
      checkAutoScroll(event.clientY);
      const canvasY = event.clientY - rect.top + grid.scrollTop;
      const targetMinutes = snapMinutes((canvasY / PX_PER_HOUR) * 60);
      const clampedMinutes = Math.max(0, Math.min(24 * 60 - 15, targetMinutes));
      setPreviewTop((clampedMinutes / 60) * PX_PER_HOUR);
      setPreviewHeight(Math.max(MIN_BLOCK_HEIGHT, ((dragOrigin.current.duration ?? 30) / 60) * PX_PER_HOUR));
      setPreviewTime(formatMinutesAsTime(clampedMinutes));
    } else {
      stopAutoScroll();
      setPreviewTop(null);
      setPreviewHeight(null);
      setPreviewTime(null);
    }
  };

  return (
    <div className={`day-schedule ${showTray ? "has-tray" : ""}`}>
      {showTray && (
        <aside className="day-schedule-tray" data-unscheduled-tray>
          <header>
            <h3>{labels.unscheduled}</h3>
            <small>{labels.dropToSchedule}</small>
          </header>
          {trayTasks.length === 0 ? (
            <p className="schedule-empty">{labels.empty}</p>
          ) : (
            <div className="schedule-tray-list">
              {trayTasks.map((task) => (
                <article
                  key={task.id ?? task.title}
                  className={`schedule-tray-card ${dragId === task.id ? "dragging" : ""} ${task.priority === "highest" ? "most-important" : ""}`}
                  tabIndex={0}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || !task.id || (event.target as HTMLElement).closest("button,input,select,textarea,a")) return;
                    moved.current = false;
                    const grid = gridRef.current;
                    dragOrigin.current = {
                      id: task.id,
                      kind: "loose",
                      startMinutes: 0,
                      duration: task.durationMinutes ?? 30,
                      grabOffsetMinutes: 0,
                      startScrollTop: grid?.scrollTop ?? 0,
                      startClientX: event.clientX,
                      startClientY: event.clientY,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={moveLooseDrag}
                  onPointerUp={(event) => finishDrag(event, task.id)}
                  onPointerCancel={resetDrag}
                  onLostPointerCapture={() => {
                    if (dragOrigin.current?.id === task.id) resetDrag();
                  }}
                  onClick={() => {
                    if (performance.now() < suppressClickUntil.current) {
                      return;
                    }
                    if (task.id) onOpenTask?.(task.id);
                  }}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && task.id) {
                      event.preventDefault();
                      onOpenTask?.(task.id);
                    }
                  }}
                >
                  <GripVertical aria-hidden="true" />
                  <div className="schedule-tray-body">
                    {onPriority && task.id ? <PriorityControl priority={task.priority} compact onChange={(priority) => onPriority(task.id!, priority)} locale={locale} /> : null}
                    <strong className="inline-title-button">{task.title}</strong>
                    {task.taskDate && task.taskDate < date ? <small>{task.taskDate}</small> : null}
                  </div>
                  {(onComplete || onDelete) && (
                    <div className="schedule-tray-actions">
                      {onComplete && <button type="button" aria-label={task.status === "done" ? labels.reopen : labels.complete} title={task.status === "done" ? labels.reopen : labels.complete} onClick={(event) => { event.stopPropagation(); onComplete(task); }}><Check aria-hidden="true" /></button>}
                      {onDelete && <button type="button" className="danger" aria-label={labels.delete} title={labels.delete} onClick={(event) => { event.stopPropagation(); onDelete(task); }}><Trash2 aria-hidden="true" /></button>}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </aside>
      )}
      <div className="day-schedule-main">
        {allDayTasks.length > 0 && (
          <div className="all-day-row" data-schedule-all-day>
            {allDayTasks.map((task) => (
              <button
                type="button"
                key={task.id ?? task.title}
                className={`all-day-chip ${dragId === task.id ? "dragging" : ""}`}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !task.id) return;
                  moved.current = false;
                  const grid = gridRef.current;
                  dragOrigin.current = {
                    id: task.id,
                    kind: "loose",
                    startMinutes: 0,
                    duration: task.durationMinutes ?? 30,
                    grabOffsetMinutes: 0,
                    startScrollTop: grid?.scrollTop ?? 0,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={moveLooseDrag}
                onPointerUp={(event) => finishDrag(event, task.id)}
                onPointerCancel={resetDrag}
                onLostPointerCapture={() => {
                  if (dragOrigin.current?.id === task.id) resetDrag();
                }}
                onClick={() => {
                  if (performance.now() < suppressClickUntil.current) return;
                  if (task.id) onOpenTask?.(task.id);
                }}
              >
                {task.title}
              </button>
            ))}
          </div>
        )}
        <div
          className="day-schedule-grid"
          data-day-schedule-grid
          data-schedule-date={date}
          ref={gridRef}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest(".timed-block, .day-schedule-composer, button, input")) return;
            const time = timeAtPoint(event.clientY, event.target as HTMLElement);
            if (time) setComposer({ time });
          }}
        >
          <div className="day-schedule-canvas" style={{ height: 24 * PX_PER_HOUR }}>
          <div className="hour-rail">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="hour-slot"
                data-schedule-minutes={hour * 60}
                style={{ height: PX_PER_HOUR }}
              >
                <time>{`${String(hour).padStart(2, "0")}:00`}</time>
              </div>
            ))}
          </div>
          {isToday && nowMinutes != null && (
            <div className="now-indicator" style={{ top: (nowMinutes / 60) * PX_PER_HOUR }}>
              <span />
            </div>
          )}
          {dragId && previewTop != null && dragOrigin.current?.kind === "loose" && (
            <div
              className="timed-block drag-ghost"
              style={{
                top: previewTop,
                height: previewHeight ?? MIN_BLOCK_HEIGHT,
                left: "58px",
                width: "calc(100% - 68px)",
                pointerEvents: "none",
              }}
            >
              <div className="timed-block-head">
                <strong>{previewTime ?? formatMinutesAsTime(Math.round((previewTop / PX_PER_HOUR) * 60))}</strong>
              </div>
            </div>
          )}
          {timedTasks.map((task) => {
            if (!task.id) return null;
            const layout = layoutById.get(task.id);
            if (!layout) return null;
            const top = dragId === task.id && previewTop != null ? previewTop : layout.top;
            const height = dragId === task.id && previewHeight != null ? previewHeight : layout.height;
            const width = `calc((100% - 58px) / ${layout.columns})`;
            const left = `calc(58px + ((100% - 58px) / ${layout.columns}) * ${layout.column})`;
            return (
              <article
                key={task.id}
                className={`timed-block ${dragId === task.id ? "dragging" : ""} ${task.priority === "highest" ? "most-important" : ""}`}
                style={{ top, height, left, width }}
                tabIndex={0}
                onPointerDown={(event) => beginTimedDrag(event, task)}
                onPointerMove={moveTimedDrag}
                onPointerUp={(event) => finishDrag(event, task.id)}
                onPointerCancel={resetDrag}
                onLostPointerCapture={() => {
                  if (dragOrigin.current?.id === task.id) resetDrag();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (performance.now() < suppressClickUntil.current) return;
                  onOpenTask?.(task.id!);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenTask?.(task.id!);
                  }
                }}
              >
                <div className="timed-block-head">
                  {onPriority ? <PriorityControl priority={task.priority} compact onChange={(priority) => onPriority(task.id!, priority)} locale={locale} /> : null}
                  <strong className="timed-block-title">{task.title}</strong>
                </div>
                <small>
                  {dragId === task.id && previewTime ? previewTime : task.startTime}
                  {task.durationMinutes ? ` · ${task.durationMinutes}m` : ""}
                </small>
                {(onComplete || onDelete) && (
                  <div className="timed-block-actions">
                    {onComplete && (
                      <button
                        type="button"
                        className="timed-block-action"
                        aria-label={task.status === "done" ? labels.reopen : labels.complete}
                        title={task.status === "done" ? labels.reopen : labels.complete}
                        onClick={(event) => {
                          event.stopPropagation();
                          onComplete(task);
                        }}
                      >
                        <Check aria-hidden="true" />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        className="timed-block-action danger"
                        aria-label={labels.delete}
                        title={labels.delete}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(task);
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
                {onResize && (
                  <div
                    className="timed-block-resize"
                    data-resize-handle
                    title={labels.resize}
                    aria-label={labels.resize}
                    onPointerDown={(event) => beginResize(event, task)}
                    onPointerMove={moveTimedDrag}
                    onPointerUp={(event) => finishDrag(event, task.id)}
                    onPointerCancel={resetDrag}
                    onLostPointerCapture={() => {
                      if (dragOrigin.current?.id === task.id) resetDrag();
                    }}
                  />
                )}
              </article>
            );
          })}
          {composer && (
            <form
              className="day-schedule-composer"
              style={{ top: (parseTimeToMinutes(composer.time) ?? 0) / 60 * PX_PER_HOUR }}
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                const input = event.currentTarget.querySelector("input[name='title']") as { value?: string } | null;
                const title = (input?.value ?? "").trim();
                if (!title) return;
                onCreateAt(title, composer.time);
                setComposer(null);
              }}
            >
              <label>
                <span className="visually-hidden">{labels.addAtTime(composer.time)}</span>
                <input
                  autoFocus
                  name="title"
                  placeholder={labels.addAtTime(composer.time)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setComposer(null);
                  }}
                />
              </label>
            </form>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
