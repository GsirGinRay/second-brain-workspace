import {
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "@second-brain/brain-core";
import {
  addDateDays,
  buildMonthCells,
  buildWeekDates,
} from "@second-brain/brain-ui";
import {
  CalendarDays,
  Clock,
  Columns3,
  GripVertical,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CompletedVisibilityButton, Empty, TaskActionBar, TaskDateInput, getCalendarTaskEntries, newTask, taipeiDateKey, taskLabel, taskProjectStyle, useUiPreferences } from "./app-shared";
import { DangerConfirmButton } from "./danger-confirm";
import { formatMinutesAsTime, minutesFromOffset, snapMinutes, timeFromSlotDrop } from "./day-schedule";
import { DaySchedule } from "./day-schedule-view";
import { GLOBAL_SELECTION_DELETE_EVENT, consumeGlobalMarqueeClick, getGlobalSelectedIds, getSelectedIdsOfKind } from "./global-shift-marquee";
import { PriorityControl } from "./priority-control";
import { QuickAddModal } from "./quick-add-modal";
import {
  applyTaskPriority,
  archiveTask,
  boardLane,
  filterCompletedTasks,
  markMostImportant,
  scheduleTask,
  scheduleTaskBatch,
} from "./task-actions";
import { TaskCompleteButton } from "./task-complete-button";
import {
  reorderDisplayed,
  withReassignedRanks,
} from "./task-reorder";

export function Calendar({
  tasks,
  projects,
  showCompleted,
  onShowCompletedChange,
  onSave,
  onDelete,
  onOpenTask,
  onCreateProject,
  onPromote,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  onDelete: (task: BrainTaskSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  onCreateProject?: (name: string) => Promise<{ id: string; name: string } | null>;
  onPromote: (task: BrainTaskSnapshot) => void;
}) {
  const { preferences, t } = useUiPreferences();
  const today = taipeiDateKey();
  const [mode, setMode] = useState<"month" | "week" | "schedule">("month");
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [sideOpen, setSideOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOriginDate, setDragOriginDate] = useState<string | null>(null);
  const [dropTargetDate, setDropTargetDate] = useState<string | null>(null);
  // Ids travelling with an active calendar drag, so every selected chip lifts
  // together instead of only the grabbed one.
  const [dragBatchIds, setDragBatchIds] = useState<string[]>([]);
  // Live pointer position while a calendar drag is active, so a floating
  // stack of the selected tasks can follow the cursor (Notion-style).
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number } | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [ideasExpanded, setIdeasExpanded] = useState(false);
  const [ideaContextMenu, setIdeaContextMenu] = useState<{
    task: BrainTaskSnapshot;
    x: number;
    y: number;
  } | null>(null);
  const calendarDragMoved = useRef(false);
  const calendarDragOrigin = useRef<{ x: number; y: number } | null>(null);
  const calendarDragCandidate = useRef<{ id: string; ids: string[]; originDate: string | null } | null>(null);
  const suppressCalendarClick = useRef(false);
  const [ideaDropHint, setIdeaDropHint] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clock = useMemo(() => new Date(), [today]);
  const flashNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(
      () => setNotice((current) => (current === message ? null : current)),
      5000,
    );
  };
  const month = anchor.slice(0, 7);
  const cells = buildMonthCells(month);
  const weekDates = buildWeekDates(anchor);
  const visibleTasks = filterCompletedTasks(tasks, showCompleted);
  const entries = getCalendarTaskEntries(visibleTasks, today);
  const byDate = new Map<string, typeof entries>();
  for (const entry of entries)
    byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  const selectedTasks = byDate.get(selected) ?? [];
  const ideas = visibleTasks
    .filter((task) => boardLane(task) === "idea")
    .sort((a, b) => a.rank.localeCompare(b.rank));
  const visibleIdeas = ideasExpanded ? ideas : ideas.slice(0, 8);
  // Every time the calendar tree re-renders, React wipes the
  // `global-shift-selected` class that the marquee painted onto each
  // chip. Reapply it after every render so the class stays in sync with
  // the (module-level) selection state.
  useEffect(() => {
    const ids = getSelectedIdsOfKind("task");
    if (ids.length === 0) return;
    const selected = new Set(ids);
    const escape = (value: string) =>
      typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value;
    const apply = () => {
      for (const id of selected) {
        const elements = document.querySelectorAll<HTMLElement>(`[data-global-select-id="${escape(id)}"]`);
        for (const element of elements) {
          if (element.closest(".calendar-task-title, .week-task-list article, [data-idea-card-id]")) {
            element.classList.add("global-shift-selected");
          }
        }
      }
    };
    apply();
  });
  useEffect(() => {
    if (!ideaContextMenu) return;
    const close = () => setIdeaContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [ideaContextMenu]);
  const beginDrag = (id: string | null, originDate: string | null, x: number, y: number) => {
    calendarDragMoved.current = false;
    calendarDragOrigin.current = { x, y };
    calendarDragCandidate.current = id ? { id, ids: getGlobalSelectedIds(id), originDate } : null;
    setDragTaskId(null);
    setDragOriginDate(null);
    setDropTargetDate(null);
    setActiveTaskId(id);
  };
  const resetDrag = () => {
    calendarDragOrigin.current = null;
    calendarDragCandidate.current = null;
    calendarDragMoved.current = false;
    setDragTaskId(null);
    setDragOriginDate(null);
    setDropTargetDate(null);
    setDragBatchIds([]);
    setDragPointer(null);
    setIdeaDropHint(null);
  };
  const openTask = (id: string | null) => {
    if (!id) return;
    if (suppressCalendarClick.current) {
      suppressCalendarClick.current = false;
      return;
    }
    setActiveTaskId(id);
    onOpenTask(id);
  };
  const trackCalendarDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const origin = calendarDragOrigin.current;
    if (origin && !calendarDragMoved.current && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) {
      calendarDragMoved.current = true;
      setDragTaskId(calendarDragCandidate.current?.id ?? null);
      setDragOriginDate(calendarDragCandidate.current?.originDate ?? null);
      // Every id travelling with the drag lifts together for the batch visual.
      setDragBatchIds(calendarDragCandidate.current?.ids ?? []);
    }
    if (calendarDragMoved.current) {
      // The floating stack of selected tasks chases the cursor.
      setDragPointer({ x: event.clientX, y: event.clientY });
    }
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const date = target?.closest<HTMLElement>("[data-calendar-date]")?.dataset.calendarDate;
    setDropTargetDate(date ?? null);
    // While an idea is dragged over its siblings, show where it will land.
    if (calendarDragMoved.current && calendarDragCandidate.current?.originDate == null && dragTaskId) {
      const card = target?.closest<HTMLElement>("[data-idea-card-id]");
      const hintId = card?.dataset.ideaCardId;
      if (hintId && hintId !== dragTaskId) {
        const rect = card!.getBoundingClientRect();
        setIdeaDropHint({ id: hintId, place: event.clientY <= rect.top + rect.height / 2 ? "before" : "after" });
      } else {
        setIdeaDropHint(null);
      }
    }
  };
  function shift(delta: number) {
    if (mode === "week") {
      const next = addDateDays(anchor, delta * 7);
      setAnchor(next);
      setSelected(next);
      return;
    }
    if (mode === "schedule") {
      const next = addDateDays(selected, delta);
      setAnchor(next);
      setSelected(next);
      return;
    }
    const [y, m] = month.split("-").map(Number);
    const date = new Date(y!, m! - 1 + delta, 1);
    const next = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
    setAnchor(next);
    setSelected(next);
  }
  const openSchedule = (date: string) => {
    setAnchor(date);
    setSelected(date);
    setMode("schedule");
    setSideOpen(false);
  };
  const schedule = (id: string | null, date: string, startTime?: string | null) => {
    if (!id) return;
    const target = tasks.find((task) => task.id === id);
    flashNotice(target
      ? (startTime ? `「${target.title}」已排到 ${date} ${startTime}` : `「${target.title}」已排到 ${date}`)
      : `任務已排到 ${date}`);
    void onSave(
      tasks.map((task) => (task.id === id ? scheduleTask(task, date, startTime) : task)),
    );
  };
  const scheduleSelection = (ids: readonly string[], date: string, startTime?: string | null) => {
    const selectedIds = new Set(ids);
    void onSave(tasks.map((task) => task.id && selectedIds.has(task.id) ? scheduleTask(task, date, startTime) : task));
  };
  const unscheduleSelection = (ids: readonly string[]) => {
    const selectedIds = new Set(ids);
    void onSave(tasks.map((task) => task.id && selectedIds.has(task.id)
      ? { ...task, status: "todo", taskDate: null, completedAt: null, startTime: null, durationMinutes: null }
      : task));
  };
  const complete = (id: string | null) =>
    onSave(
      tasks.map((task) =>
        task.id === id
          ? task.status === "done"
            ? { ...task, status: "todo", completedAt: null }
            : archiveTask(task, today)
          : task,
      ),
    );
  const remove = onDelete;
  // Delete every selected calendar task in one go (Shift+marquee picks up
  // the group, Delete/Backspace on a calendar chip removes them together).
  const removeSelection = (ids: readonly string[]) => {
    const targets = new Set(ids);
    if (targets.size === 0) return;
    flashNotice(preferences.language === "zh-TW" ? `已刪除 ${targets.size} 項任務` : `Removed ${targets.size} tasks`);
    void onSave(tasks.filter((task) => task.id ? !targets.has(task.id) : true));
  };
  // Window-level Delete/Backspace: after a Shift/plain marquee the keyboard
  // focus usually sits on <body>, outside the React tree, so the keydown the
  // marquee dispatches is the only reliable way to delete the selection.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ ids: string[]; kind: string }>).detail;
      if (!detail || detail.kind !== "task") return;
      removeSelection(detail.ids);
    };
    window.addEventListener(GLOBAL_SELECTION_DELETE_EVENT, handler as EventListener);
    return () => window.removeEventListener(GLOBAL_SELECTION_DELETE_EVENT, handler as EventListener);
  });
  const handleCalendarKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    // Skip when the user is typing in an input/textarea (e.g. the agenda
    // date input or the quick-add composer) — those keep their native
    // delete behaviour.
    if (target.closest("input, textarea, [contenteditable=\"true\"]")) return;
    const selectedIds = getSelectedIdsOfKind("task");
    if (selectedIds.length === 0) return;
    event.preventDefault();
    removeSelection(selectedIds);
  };
  const finishPointerDrag = (event: ReactPointerEvent<HTMLElement>, taskId: string | null) => {
    if (!taskId) return;
    const draggedIds = calendarDragCandidate.current?.ids ?? [taskId];
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const releasedOnSelf = Boolean(target && event.currentTarget.contains(target));
    const didMove = calendarDragMoved.current || !releasedOnSelf;
    suppressCalendarClick.current = didMove;
    if (didMove) window.setTimeout(() => { suppressCalendarClick.current = false; }, 0);
    if (!didMove) {
      resetDrag();
      return;
    }
    const slot = target?.closest<HTMLElement>("[data-schedule-minutes]");
    const grid = target?.closest<HTMLElement>("[data-day-schedule-grid]");
    const date = target?.closest<HTMLElement>("[data-calendar-date]")?.dataset.calendarDate
      ?? grid?.dataset.scheduleDate;
    if (target?.closest("[data-schedule-all-day], [data-unscheduled-tray]")) {
      scheduleSelection(draggedIds, date ?? selected, null);
    } else if (slot) {
      const rect = slot.getBoundingClientRect();
      const time = rect.height > 0
        ? timeFromSlotDrop(
            Number(slot.dataset.scheduleMinutes),
            event.clientY,
            rect.top,
            rect.height,
          )
        : formatMinutesAsTime(snapMinutes(Number(slot.dataset.scheduleMinutes)));
      scheduleSelection(draggedIds, date ?? selected, time);
    } else if (grid) {
      const rect = grid.getBoundingClientRect();
      scheduleSelection(
        draggedIds,
        date ?? selected,
        formatMinutesAsTime(minutesFromOffset(event.clientY - rect.top + grid.scrollTop)),
      );
    } else if (date) scheduleSelection(draggedIds, date);
    else if (target?.closest("[data-idea-drawer]")) {
      // An idea released onto a sibling idea reorders the inbox instead of unscheduling.
      const cameFromDrawer = calendarDragCandidate.current?.originDate == null;
      const card = target.closest<HTMLElement>("[data-idea-card-id]");
      const targetIdeaId = card?.dataset.ideaCardId ?? null;
      if (cameFromDrawer && targetIdeaId && targetIdeaId !== taskId) {
        const rect = card!.getBoundingClientRect();
        const place = event.clientY <= rect.top + rect.height / 2 ? "before" : "after";
        const ordered = reorderDisplayed(ideas, taskId, targetIdeaId, place);
        if (ordered) {
          flashNotice(preferences.language === "zh-TW" ? "想法順序已更新" : "Idea order updated");
          void onSave(withReassignedRanks(tasks, ordered.map((task) => task.id)));
        }
      } else {
        unscheduleSelection(draggedIds);
      }
    }
    resetDrag();
  };
  const dateLabel = (date: string) =>
    new Intl.DateTimeFormat(preferences.language, {
      month: "numeric",
      day: "numeric",
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
  return (
    <div
      className={`calendar-layout ${sideOpen ? "" : "side-closed"} ${fullscreen ? "fullscreen" : ""}`}
      data-global-marquee-scope="calendar"
      onKeyDown={handleCalendarKeyDown}
    >
      <section className="calendar-card">
        <header className="calendar-toolbar">
          <div>
            <button onClick={() => shift(-1)} aria-label={t("calendar.previous")} title={t("calendar.previous")}>‹</button>
            <button
              className="today-button"
              onClick={() => {
                setAnchor(today);
                setSelected(today);
              }}
            >
              {t("calendar.today")}
            </button>
            <button onClick={() => shift(1)} aria-label={t("calendar.next")} title={t("calendar.next")}>›</button>
          </div>
          <h2>
            {mode === "month"
              ? new Intl.DateTimeFormat(preferences.language, { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`))
              : mode === "schedule"
                ? dateLabel(selected)
                : `${dateLabel(weekDates[0]!)}－${dateLabel(weekDates[6]!)}`}
          </h2>
          <div>
            <div className="view-switch">
              <button
                className={mode === "month" ? "active" : ""}
                onClick={() => setMode("month")}
              >
                {t("calendar.month")}
              </button>
              <button
                className={mode === "week" ? "active" : ""}
                onClick={() => setMode("week")}
              >
                {t("calendar.week")}
              </button>
              <button
                className={mode === "schedule" ? "active" : ""}
                onClick={() => openSchedule(selected)}
              >
                {t("calendar.schedule")}
              </button>
            </div>
            <CompletedVisibilityButton showCompleted={showCompleted} onChange={onShowCompletedChange} />
            <button
              className="icon-action"
              aria-label={t("calendar.sidebar")}
              title={t("calendar.sidebar")}
              onClick={() => setSideOpen((value) => !value)}
            >
              <Columns3 aria-hidden="true" />
            </button>
            <button
              className="icon-action"
              aria-label={t(fullscreen ? "calendar.exitFullscreen" : "calendar.fullscreen")}
              title={t(fullscreen ? "calendar.exitFullscreen" : "calendar.fullscreen")}
              onClick={() => setFullscreen((value) => !value)}
            >
              {fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
          </div>
        </header>
        {notice && (
          <div className="calendar-notice" role="status">
            {notice}
            <button onClick={() => setNotice(null)} aria-label="關閉提示">×</button>
          </div>
        )}
        <div className="calendar-stage" data-plain-marquee-scope>
        {mode === "schedule" ? (
          <DaySchedule
            date={selected}
            timedTasks={selectedTasks.filter(({ task }) => task.startTime).map(({ task }) => task)}
            allDayTasks={selectedTasks.filter(({ task }) => !task.startTime).map(({ task }) => task)}
            showTray={false}
            now={selected === today ? clock : undefined}
            labels={{
              unscheduled: t("today.unscheduled"),
              dropToSchedule: t("today.dropToSchedule"),
              addAtTime: (time) => t("today.addAtTime", { time }),
              empty: t("today.empty"),
              editTitle: t("task.hint.editTitle"),
              editPriority: t("task.hint.editPriority"),
              complete: t("task.action.complete"),
              reopen: t("task.action.reopen"),
              delete: t("task.action.delete"),
              resize: t("today.resizeDuration"),
            }}
            locale={preferences.language}
            onSchedule={(taskId, startTime) => schedule(taskId, selected, startTime)}
            onScheduleBatch={(taskIds, startTime) => void onSave(scheduleTaskBatch(tasks, taskIds, selected, startTime))}
            onClearTime={(taskId) => schedule(taskId, selected, null)}
            onClearTimeBatch={(taskIds) => void onSave(tasks.map((item) => item.id && taskIds.includes(item.id) ? scheduleTask(item, selected, null) : item))}
            onCreateAt={(title, startTime) => void onSave([...tasks, newTask(title, { taskDate: selected, startTime, durationMinutes: 30 })])}
            onOpenTask={openTask}
            onPriority={(taskId, priority) => void onSave(applyTaskPriority(tasks, taskId, priority, selected))}
            onDelete={remove}
            onDeleteBatch={(selectedTasks) => removeSelection(selectedTasks.flatMap((task) => task.id ? [task.id] : []))}
            onComplete={(task) => complete(task.id)}
            onResize={(taskId, durationMinutes) => void onSave(tasks.map((item) => item.id === taskId ? { ...item, durationMinutes } : item))}
          />
        ) : mode === "month" ? (
          <>
            <div className="weekdays">
              {Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(preferences.language, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 2 + day)))).map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="month-grid">
              {cells.map((cell) => {
                const dayEntries = byDate.get(cell.date) ?? [];
                return (
                  <section
                    key={cell.date}
                    className={`calendar-day ${cell.currentMonth ? "" : "muted"} ${selected === cell.date ? "selected" : ""} ${cell.date === today ? "today" : ""} ${dragTaskId && dragOriginDate === cell.date ? "drag-origin" : ""} ${dragTaskId && dropTargetDate === cell.date && dragOriginDate !== cell.date ? "drop-target" : ""}`}
                    data-calendar-date={cell.date}
                    onClick={() => {
                      // The click the browser synthesizes after a plain
                      // box-drag must not select the cell under the release
                      // point.
                      if (consumeGlobalMarqueeClick()) return;
                      setSelected(cell.date);
                      setSideOpen(true);
                    }}
                    onDoubleClick={() => openSchedule(cell.date)}
                  >
                    <span className="day-number">
                      {Number(cell.date.slice(8))}
                    </span>
                    <button
                      type="button"
                      className="calendar-day-add"
                      aria-label={`${t("app.quickAdd")} · ${cell.date}`}
                      title={`${t("app.quickAdd")} · ${cell.date}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelected(cell.date);
                        setQuickAddOpen(true);
                      }}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <div className="calendar-task-list">
                      {dayEntries.slice(0, 4).map((entry) => (
                        <span
                          data-global-select-id={entry.task.id ?? undefined}
                          onPointerDown={(event) => {
                            if (event.button === 0 && entry.task.id && !(event.target as HTMLElement).closest("button,input")) {
                              beginDrag(entry.task.id, entry.date, event.clientX, event.clientY);
                              event.currentTarget.setPointerCapture(event.pointerId);
                            }
                          }}
                          onPointerMove={(event) => {
                            trackCalendarDrag(event);
                          }}
                          onPointerUp={(event) => finishPointerDrag(event, entry.task.id)}
                          onPointerCancel={resetDrag}
                          onLostPointerCapture={() => {
                            if (calendarDragCandidate.current?.id === entry.task.id || dragTaskId === entry.task.id) resetDrag();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            openTask(entry.task.id);
                          }}
                          style={taskProjectStyle(entry.task)}
                          key={`${entry.task.id}:${entry.date}`}
                          className={`calendar-task-title ${activeTaskId === entry.task.id ? "selected-task" : ""} ${dragBatchIds.includes(entry.task.id ?? "") ? "dragging" : ""} ${entry.task.priority === "highest" ? "most-important" : ""} ${entry.task.status === "done" ? "completed-task" : ""}`}
                        >
                          <button
                            type="button"
                            className="calendar-task-drag-handle"
                            data-drag-handle
                            aria-label={`拖曳 ${entry.task.title}`}
                            title="拖曳到其他日期（已選取時會一次拖全部）"
                            onPointerDown={(event) => {
                              if (event.button !== 0 || !entry.task.id) return;
                              event.stopPropagation();
                              beginDrag(entry.task.id, entry.date, event.clientX, event.clientY);
                              event.currentTarget.setPointerCapture(event.pointerId);
                            }}
                            onPointerMove={(event) => trackCalendarDrag(event)}
                            onPointerUp={(event) => finishPointerDrag(event, entry.task.id)}
                            onPointerCancel={resetDrag}
                            onLostPointerCapture={() => {
                              if (calendarDragCandidate.current?.id === entry.task.id || dragTaskId === entry.task.id) resetDrag();
                            }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <GripVertical aria-hidden="true" />
                          </button>
                          <TaskCompleteButton size="sm" className="calendar-quick-check" done={entry.task.status === "done"} label={entry.task.status === "done" ? t("task.action.reopen") : t("task.action.complete")} onClick={() => complete(entry.task.id)} />
                          <span className="calendar-task-text">{taskLabel(entry.task)}</span>
                          {dragTaskId === entry.task.id && dragBatchIds.length > 1 && <span className="calendar-drag-count" aria-hidden="true">{dragBatchIds.length}</span>}
                        </span>
                      ))}
                      {dayEntries.length > 4 && (
                        <small>＋{dayEntries.length - 4} 項</small>
                      )}
                    </div>
                    {dragTaskId && <i className="drop-hint">拖到這一天排程</i>}
                  </section>
                );
              })}
            </div>
          </>
        ) : (
          <div className="week-grid">
            {weekDates.map((date) => {
              const dayEntries = byDate.get(date) ?? [];
              return (
                <section
                  key={date}
                  data-calendar-date={date}
                  className={`week-day ${date === today ? "today" : ""} ${date === selected ? "selected" : ""} ${dragTaskId && dragOriginDate === date ? "drag-origin" : ""} ${dragTaskId && dropTargetDate === date && dragOriginDate !== date ? "drop-target" : ""}`}
                >
                  <div className="week-date">
                    <button
                      onClick={() => {
                        setSelected(date);
                        setSideOpen(true);
                      }}
                    >
                      <span>{dateLabel(date)}</span>
                      <small>
                        {
                          dayEntries.filter(
                            (entry) => entry.task.status !== "done",
                          ).length
                        }{" "}
                        項待辦
                      </small>
                    </button>
                    <button
                      type="button"
                      className="week-day-add"
                      aria-label={`${t("app.quickAdd")} · ${date}`}
                      title={`${t("app.quickAdd")} · ${date}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelected(date);
                        setQuickAddOpen(true);
                      }}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="week-plan-button"
                      aria-label={t("calendar.planTimes")}
                      title={t("calendar.planTimes")}
                      onClick={() => openSchedule(date)}
                    >
                      <Clock aria-hidden="true" />
                    </button>
                  </div>
                  <div className="week-task-list">
                    {dayEntries.map((entry) => (
                      <article
                        data-global-select-id={entry.task.id ?? undefined}
                        onPointerDown={(event) => {
                          if (event.button === 0 && entry.task.id && !(event.target as HTMLElement).closest("button,input,select")) {
                            beginDrag(entry.task.id, entry.date, event.clientX, event.clientY);
                            event.currentTarget.setPointerCapture(event.pointerId);
                          }
                        }}
                        onPointerMove={(event) => {
                          trackCalendarDrag(event);
                        }}
                        onPointerUp={(event) => finishPointerDrag(event, entry.task.id)}
                        onPointerCancel={resetDrag}
                        onLostPointerCapture={() => {
                          if (calendarDragCandidate.current?.id === entry.task.id || dragTaskId === entry.task.id) resetDrag();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                           openTask(entry.task.id);
                        }}
                        style={taskProjectStyle(entry.task)}
                        className={`${activeTaskId === entry.task.id ? "selected-task" : ""} ${dragBatchIds.includes(entry.task.id ?? "") ? "dragging" : ""} ${entry.task.priority === "highest" ? "most-important" : ""} ${entry.task.status === "done" ? "completed-task" : ""}`}
                        key={`${entry.task.id}:${entry.date}`}
                      >
                        <div className="task-title-row">
                          <button
                            type="button"
                            className="calendar-task-drag-handle"
                            data-drag-handle
                            aria-label={`拖曳 ${entry.task.title}`}
                            title="拖曳到其他日期（已選取時會一次拖全部）"
                            onPointerDown={(event) => {
                              if (event.button !== 0 || !entry.task.id) return;
                              event.stopPropagation();
                              beginDrag(entry.task.id, entry.date, event.clientX, event.clientY);
                              event.currentTarget.setPointerCapture(event.pointerId);
                            }}
                            onPointerMove={(event) => trackCalendarDrag(event)}
                            onPointerUp={(event) => finishPointerDrag(event, entry.task.id)}
                            onPointerCancel={resetDrag}
                            onLostPointerCapture={() => {
                              if (calendarDragCandidate.current?.id === entry.task.id || dragTaskId === entry.task.id) resetDrag();
                            }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <GripVertical aria-hidden="true" />
                          </button>
                          <TaskCompleteButton
                            size="sm"
                            done={entry.task.status === "done"}
                            label={entry.task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}
                            onClick={() => complete(entry.task.id)}
                          />
                          <strong>{taskLabel(entry.task)}</strong>
                        </div>
                        <small>
                          {entry.task.projectName ?? "無專案"}
                        </small>
                        <div className="week-task-actions"><DangerConfirmButton armLabel={t("task.action.delete")} confirmLabel={t("confirm.deleteAgain")} onConfirm={() => remove(entry.task)} /></div>
                      </article>
                    ))}
                  </div>
                  {dragTaskId && (
                    <div className="week-drop">拖到這一天排程</div>
                  )}
                </section>
              );
            })}
          </div>
        )}
        </div>
        <section
          className={`idea-drawer ${dragTaskId ? "drag-active" : ""}`}
          data-idea-drawer
        >
          <header>
            <div>
              <h3>{t("calendar.ideaTitle")}</h3>
              <p>{t("calendar.ideaHelp")}</p>
            </div>
            <button
              type="button"
              className="idea-count-button"
              onClick={() => setIdeasExpanded((value) => !value)}
              aria-expanded={ideasExpanded}
            >
              {ideasExpanded ? t("calendar.collapse") : t("calendar.items", { count: ideas.length })}
            </button>
          </header>
          <div className="idea-grid">
            {ideas.length === 0 ? (
              <small>{t("calendar.noIdeas")}</small>
            ) : (
              visibleIdeas.map((task) => (
                <article
                  data-global-select-id={task.id ?? undefined}
                  onClick={() => openTask(task.id)}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && task.id) {
                      event.preventDefault();
                      openTask(task.id);
                    }
                  }}
                  tabIndex={0}
                  data-idea-card-id={task.id ?? undefined}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveTaskId(task.id);
                    setIdeaContextMenu({
                      task,
                      x: Math.min(event.clientX, window.innerWidth - 220),
                      y: Math.min(event.clientY, window.innerHeight - 200),
                    });
                  }}
                  style={taskProjectStyle(task)}
                  className={`${activeTaskId === task.id ? "selected-task" : ""} ${dragTaskId === task.id ? "dragging" : ""} ${ideaDropHint?.id === task.id ? (ideaDropHint.place === "before" ? "drop-before" : "drop-after") : ""}`}
                  key={task.id ?? task.title}
                >
                  <button
                    type="button"
                    className="idea-drag-handle"
                    data-drag-handle
                    aria-label={`拖曳 ${task.title}`}
                    title="拖曳到日期"
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !task.id) return;
                      beginDrag(task.id, null, event.clientX, event.clientY);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      trackCalendarDrag(event);
                    }}
                    onPointerUp={(event) => finishPointerDrag(event, task.id)}
                    onPointerCancel={resetDrag}
                    onLostPointerCapture={() => {
                      if (calendarDragCandidate.current?.id === task.id || dragTaskId === task.id) resetDrag();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      suppressCalendarClick.current = false;
                    }}
                  >
                    <GripVertical className="calendar-task-drag-handle" aria-hidden="true" />
                  </button>
                  <div className="idea-card-body">
                    <strong>{taskLabel(task)}</strong>
                    <span>
                      <PriorityControl
                        priority={task.priority}
                        compact
                        locale={preferences.language}
                        onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, today))}
                      />
                      <small>{task.projectName ?? t("app.unassigned")}</small>
                    </span>
                    <button
                      type="button"
                      className="idea-promote-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onPromote(task);
                      }}
                    >
                      {t("task.action.promote")}
                    </button>
                  </div>
                  <DangerConfirmButton
                    className="idea-delete-button"
                    armLabel={`永久刪除想法「${task.title}」`}
                    confirmLabel={t("confirm.deleteAgain")}
                    onConfirm={() => remove(task)}
                  />
                </article>
              ))
            )}
          </div>
          {ideas.length > 8 && (
            <button
              type="button"
              className="idea-expand-button"
              onClick={() => setIdeasExpanded((value) => !value)}
            >
              {ideasExpanded ? "收合想法" : `顯示其餘 ${ideas.length - 8} 項想法`}
            </button>
          )}
        </section>
        {ideaContextMenu && (
          <div
            className="idea-context-menu"
            role="menu"
            aria-label={`${ideaContextMenu.task.title}的操作`}
            style={{ left: ideaContextMenu.x, top: ideaContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                    if (task.id) openTask(task.id);
              }}
            >
              <Pencil aria-hidden="true" />
              {t("task.action.rename")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                if (task.id) void onSave(applyTaskPriority(tasks, task.id, "highest", today));
              }}
            >
              <Star aria-hidden="true" />
              {t("task.action.important")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                if (task.id) schedule(task.id, today);
              }}
            >
              <CalendarDays aria-hidden="true" />
              {t("task.action.scheduleToday")}
            </button>
            <DangerConfirmButton
              className="danger has-label"
              armLabel={preferences.language === "zh-TW" ? `永久刪除想法「${ideaContextMenu.task.title}」` : `Delete idea “${ideaContextMenu.task.title}” permanently`}
              confirmLabel={t("confirm.deleteAgain")}
              onConfirm={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                void remove(task);
              }}
            >{preferences.language === "zh-TW" ? "永久刪除想法" : t("task.action.delete")}</DangerConfirmButton>
          </div>
        )}
      </section>
      {dragTaskId && dragPointer && dragBatchIds.length > 0 && (
        (() => {
          const stackTasks = dragBatchIds
            .map((id) => tasks.find((item) => item.id === id))
            .filter((item): item is BrainTaskSnapshot => Boolean(item));
          if (stackTasks.length === 0) return null;
          return (
            <div
              className="calendar-drag-stack"
              data-calendar-drag-stack
              style={{ left: dragPointer.x + 16, top: dragPointer.y + 12 }}
              aria-hidden="true"
            >
              {stackTasks.slice(0, 4).map((task, index) => (
                <span
                  key={task.id ?? index}
                  className="calendar-drag-chip"
                  data-calendar-drag-chip
                  style={{ ...taskProjectStyle(task), transform: `translate(${index * 8}px, ${index * 4}px)`, zIndex: 40 - index }}
                >
                  {taskLabel(task)}
                </span>
              ))}
              {stackTasks.length > 4 && (
                <span className="calendar-drag-chip calendar-drag-chip-more" data-calendar-drag-chip style={{ transform: `translate(32px, 16px)` }}>
                  +{stackTasks.length - 4}
                </span>
              )}
              {stackTasks.length > 1 && (
                <span className="calendar-drag-stack-count">
                  {preferences.language === "zh-TW" ? `${stackTasks.length} 項一起移動` : `${stackTasks.length} moving together`}
                </span>
              )}
            </div>
          );
        })()
      )}
      {sideOpen && (
        <aside className="agenda">
          <div className="agenda-header">
            <div>
              <span className="eyebrow">{t("calendar.dayPlan")}</span>
              <h3>{selected}</h3>
              <small>
                {
                  selectedTasks.filter(({ task }) => task.status !== "done")
                    .length
                }{" "}
                項待完成
              </small>
            </div>
            <div>
              <button
                className="secondary-button action-with-icon"
                onClick={() => openSchedule(selected)}
              >
                <Clock aria-hidden="true" />
                {t("calendar.planTimes")}
              </button>
              <button className="icon-button" onClick={() => setSideOpen(false)} aria-label="關閉側面板">
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          {selectedTasks.length === 0 ? (
            <Empty text={t("calendar.emptyDay")} actionLabel={t("calendar.emptyDayAction")} onAction={() => setQuickAddOpen(true)} />
          ) : (
            selectedTasks.map(({ task, date }) => (
              <article
                data-global-select-id={task.id ?? undefined}
                style={taskProjectStyle(task)}
                className={`${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`}
                key={`${task.id}:${date}`}
              >
                <button
                  className="agenda-drag-handle"
                  aria-label={`拖曳 ${task.title}`}
                  title="拖曳到其他日期"
                  onPointerDown={(event) => {
                    if (event.button === 0) {
                      beginDrag(task.id, date, event.clientX, event.clientY);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }
                  }}
                  onPointerMove={trackCalendarDrag}
                  onPointerUp={(event) => finishPointerDrag(event, task.id)}
                  onPointerCancel={resetDrag}
                  onLostPointerCapture={() => {
                    if (dragTaskId === task.id) resetDrag();
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <GripVertical aria-hidden="true" />
                </button>
                <div>
                  <div className="task-title-row">
                    <TaskCompleteButton
                      done={task.status === "done"}
                      label={task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}
                      onClick={() => complete(task.id)}
                    />
                    <PriorityControl
                      priority={task.priority}
                      compact
                      locale={preferences.language}
                      onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, selected))}
                    />
                    <button type="button" className="agenda-task-title" onClick={() => openTask(task.id)}>{taskLabel(task)}</button>
                  </div>
                  <select
                    className="agenda-project-select"
                    aria-label={`${task.title} 所屬專案`}
                    value={task.projectId ?? ""}
                    onChange={(event) => {
                      const project = projects.find((item) => item.id === event.target.value);
                      void onSave(tasks.map((item) => item.id === task.id ? { ...item, projectId: project?.id ?? null, projectName: project?.name ?? null } : item));
                    }}
                  >
                    <option value="">無專案</option>
                    {projects.map((project) => <option key={project.id ?? project.name} value={project.id ?? ""}>{project.name}</option>)}
                  </select>
                </div>
                <TaskDateInput
                  ariaLabel={`${task.title}規劃日`}
                  value={task.taskDate ?? null}
                  onCommit={(nextDate) => {
                    if (nextDate) {
                      setSelected(nextDate);
                      flashNotice(`「${task.title}」已排到 ${nextDate}`);
                    } else {
                      flashNotice(`「${task.title}」已移回想法匣`);
                    }
                    void onSave(
                      tasks.map((item) =>
                        item.id === task.id
                          ? { ...item, taskDate: nextDate }
                          : item,
                      ),
                    );
                  }}
                />
                <div className="agenda-actions">
                  <TaskActionBar
                    task={task}
                    important={task.priority === "highest"}
                    onImportant={() => task.id && onSave(markMostImportant(tasks, task.id, selected))}
                    onComplete={() => complete(task.id)}
                    onEdit={() => task.id && openTask(task.id)}
                    onDelete={remove}
                    showComplete={false}
                  />
                </div>
              </article>
            ))
          )}
        </aside>
      )}
      {quickAddOpen && (
        <QuickAddModal
          tasks={tasks}
          projects={projects}
          initialDate={selected}
          forceDate
          onCreateProject={onCreateProject}
          onClose={() => setQuickAddOpen(false)}
          onSave={(next) => {
            setQuickAddOpen(false);
            onSave(next);
          }}
        />
      )}
    </div>
  );
}
