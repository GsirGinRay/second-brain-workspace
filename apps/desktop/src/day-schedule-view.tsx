import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical } from "lucide-react";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  formatMinutesAsTime,
  layoutTimedBlocks,
  minutesFromOffset,
  parseTimeToMinutes,
  PX_PER_HOUR,
  taipeiMinutesOfDay,
  timeFromSlotDrop,
} from "./day-schedule";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export interface DayScheduleLabels {
  unscheduled: string;
  dropToSchedule: string;
  addAtTime: (time: string) => string;
  empty: string;
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
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [composer, setComposer] = useState<{ time: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [previewTop, setPreviewTop] = useState<number | null>(null);
  const dragOrigin = useRef<{ id: string; startY: number; startMinutes: number; kind: "timed" | "loose" } | null>(null);
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
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, taskId: string | null) => {
    if (!taskId) return;
    const origin = dragOrigin.current;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const releasedOnSelf = Boolean(target && event.currentTarget.contains(target));
    const didMove = moved.current || !releasedOnSelf;
    resetDrag();
    if (!didMove) return;
    if (target?.closest("[data-unscheduled-tray], [data-schedule-all-day]")) {
      onClearTime?.(taskId);
      return;
    }
    const grid = target?.closest("[data-day-schedule-grid]");
    if (!grid) return;
    if (origin?.kind === "timed") {
      const deltaHours = (event.clientY - origin.startY) / PX_PER_HOUR;
      onSchedule(
        taskId,
        formatMinutesAsTime(minutesFromOffset((origin.startMinutes / 60 + deltaHours) * PX_PER_HOUR)),
      );
      return;
    }
    const time = timeAtPoint(event.clientY, target);
    if (time) onSchedule(taskId, time);
  };

  const beginTimedDrag = (event: ReactPointerEvent<HTMLElement>, task: BrainTaskSnapshot) => {
    if (event.button !== 0 || !task.id || !task.startTime) return;
    const startMinutes = parseTimeToMinutes(task.startTime);
    if (startMinutes == null) return;
    moved.current = false;
    dragOrigin.current = { id: task.id, startY: event.clientY, startMinutes, kind: "timed" };
    setDragId(task.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveTimedDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragOrigin.current || !gridRef.current) return;
    if (Math.abs(event.clientY - dragOrigin.current.startY) > 4) moved.current = true;
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
                    dragOrigin.current = { id: task.id, startY: event.clientY, startMinutes: 0, kind: "loose" };
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
                    if ((event.key === "Enter" || event.key === " ") && task.id) {
                      event.preventDefault();
                      onSelect?.(task.id);
                    }
                  }}
                >
                  <GripVertical aria-hidden="true" />
                  <strong>{task.title}</strong>
                  {task.taskDate && task.taskDate < date ? <small>{task.taskDate}</small> : null}
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
                  dragOrigin.current = { id: task.id, startY: event.clientY, startMinutes: 0, kind: "loose" };
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
            const width = `calc((100% - 58px) / ${layout.columns})`;
            const left = `calc(58px + ((100% - 58px) / ${layout.columns}) * ${layout.column})`;
            return (
              <article
                key={task.id}
                className={`timed-block ${dragId === task.id ? "dragging" : ""} ${task.priority === "highest" ? "most-important" : ""}`}
                style={{ top, height: layout.height, left, width }}
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
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect?.(task.id!);
                  }
                }}
              >
                <strong>{task.title}</strong>
                <small>
                  {task.startTime}
                  {task.durationMinutes ? ` · ${task.durationMinutes}m` : ""}
                </small>
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
