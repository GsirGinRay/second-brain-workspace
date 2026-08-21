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
  taipeiMinutesOfDay,
  timeFromSlotDrop,
} from "./day-schedule";
import { InlineTitle } from "./inline-title";
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
  onSelect,
  onRename,
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
  onSelect?: (taskId: string) => void;
  onRename?: (taskId: string, title: string) => void;
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
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const dragOrigin = useRef<{ id: string; startY: number; startMinutes: number; kind: DragKind; duration: number } | null>(null);
  const moved = useRef(false);
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

  const timeAtPoint = (clientY: number, target: HTMLElement | null) => {
    const slot = target?.closest<HTMLElement>("[data-schedule-minutes]");
    if (slot) {
      const rect = slot.getBoundingClientRect();
      return timeFromSlotDrop(
        Number(slot.dataset.scheduleMinutes),
        clientY,
        rect.top,
        rect.height,
      );
    }
    const grid = target?.closest<HTMLElement>("[data-day-schedule-grid]") ?? gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    return formatMinutesAsTime(minutesFromOffset(clientY - rect.top + grid.scrollTop));
  };

  const resetDrag = () => {
    moved.current = false;
    dragOrigin.current = null;
    setDragId(null);
    setPreviewTop(null);
    setPreviewHeight(null);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, taskId: string | null) => {
    if (!taskId) return;
    const origin = dragOrigin.current;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const releasedOnSelf = Boolean(target && event.currentTarget.contains(target));
    const didMove = moved.current || !releasedOnSelf;
    const clientY = event.clientY;
    resetDrag();
    if (origin?.kind === "resize") {
      if (!didMove) return;
      onResize?.(taskId, durationFromResize(origin.startMinutes, origin.duration, clientY - origin.startY));
      return;
    }
    if (!didMove) return;
    if (target?.closest("[data-unscheduled-tray], [data-schedule-all-day]")) {
      onClearTime?.(taskId);
      return;
    }
    const grid = target?.closest("[data-day-schedule-grid]");
    if (!grid) return;
    if (origin?.kind === "timed") {
      const deltaHours = (clientY - origin.startY) / PX_PER_HOUR;
      onSchedule(
        taskId,
        formatMinutesAsTime(minutesFromOffset((origin.startMinutes / 60 + deltaHours) * PX_PER_HOUR)),
      );
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
    dragOrigin.current = {
      id: task.id,
      startY: event.clientY,
      startMinutes,
      kind: "timed",
      duration: task.durationMinutes ?? 30,
    };
    setDragId(task.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginResize = (event: ReactPointerEvent<HTMLElement>, task: BrainTaskSnapshot) => {
    if (event.button !== 0 || !task.id || !task.startTime) return;
    const startMinutes = parseTimeToMinutes(task.startTime);
    if (startMinutes == null) return;
    event.stopPropagation();
    moved.current = false;
    dragOrigin.current = {
      id: task.id,
      startY: event.clientY,
      startMinutes,
      kind: "resize",
      duration: task.durationMinutes ?? 30,
    };
    setDragId(task.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveTimedDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragOrigin.current || !gridRef.current) return;
    if (Math.abs(event.clientY - dragOrigin.current.startY) > 4) moved.current = true;
    if (dragOrigin.current.kind === "resize") {
      const next = durationFromResize(
        dragOrigin.current.startMinutes,
        dragOrigin.current.duration,
        event.clientY - dragOrigin.current.startY,
      );
      setPreviewHeight(Math.max(MIN_BLOCK_HEIGHT, (next / 60) * PX_PER_HOUR));
      return;
    }
    const deltaHours = (event.clientY - dragOrigin.current.startY) / PX_PER_HOUR;
    const next = minutesFromOffset((dragOrigin.current.startMinutes / 60 + deltaHours) * PX_PER_HOUR);
    setPreviewTop((next / 60) * PX_PER_HOUR);
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
                    if (event.button !== 0 || !task.id || (event.target as HTMLElement).closest("button")) return;
                    moved.current = false;
                    dragOrigin.current = { id: task.id, startY: event.clientY, startMinutes: 0, kind: "loose", duration: 30 };
                    setDragId(task.id);
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (!dragId || !dragOrigin.current) return;
                    if (Math.abs(event.clientY - dragOrigin.current.startY) > 4) moved.current = true;
                  }}
                  onPointerUp={(event) => finishDrag(event, task.id)}
                  onPointerCancel={resetDrag}
                  onClick={() => task.id && onSelect?.(task.id)}
                  onKeyDown={(event) => {
                    if (event.key === "F2" && task.id) {
                      event.preventDefault();
                      setEditingTitleId(task.id);
                      return;
                    }
                    if ((event.key === "Enter" || event.key === " ") && task.id) {
                      event.preventDefault();
                      onSelect?.(task.id);
                    }
                  }}
                >
                  <GripVertical aria-hidden="true" />
                  <div className="schedule-tray-body">
                    {onPriority && task.id ? <PriorityControl priority={task.priority} onChange={(priority) => onPriority(task.id!, priority)} locale={locale} /> : null}
                    {onRename && task.id ? (
                      <InlineTitle
                        value={task.title}
                        onSave={(title) => onRename(task.id!, title)}
                        editing={editingTitleId === task.id}
                        onEditingChange={(next) => setEditingTitleId(next ? task.id! : null)}
                        ariaLabel={labels.editTitle}
                        hint={labels.editTitle}
                      />
                    ) : <strong>{task.title}</strong>}
                    {task.taskDate && task.taskDate < date ? <small>{task.taskDate}</small> : null}
                  </div>
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
                  dragOrigin.current = { id: task.id, startY: event.clientY, startMinutes: 0, kind: "loose", duration: 30 };
                  setDragId(task.id);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerUp={(event) => finishDrag(event, task.id)}
                onPointerCancel={resetDrag}
                onClick={() => task.id && onSelect?.(task.id)}
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
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect?.(task.id!);
                }}
                onKeyDown={(event) => {
                  if (event.key === "F2") {
                    event.preventDefault();
                    setEditingTitleId(task.id!);
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect?.(task.id!);
                  }
                }}
              >
                <div className="timed-block-head">
                  {onPriority ? <PriorityControl priority={task.priority} onChange={(priority) => onPriority(task.id!, priority)} locale={locale} /> : null}
                  {onRename ? (
                    <InlineTitle
                      value={task.title}
                      onSave={(title) => onRename(task.id!, title)}
                      editing={editingTitleId === task.id}
                      onEditingChange={(next) => setEditingTitleId(next ? task.id! : null)}
                      className="timed-block-title"
                      ariaLabel={labels.editTitle}
                      hint={labels.editTitle}
                    />
                  ) : <strong>{task.title}</strong>}
                </div>
                <small>
                  {task.startTime}
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
