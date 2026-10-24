import {
  projectColor,
  rankForIndex,
  visibleTaskTitle,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "@second-brain/brain-core";
import {
  getCalendarTaskEntries as buildCalendarTaskEntries,
  taipeiDateKey as dateKeyForTaipei,
} from "@second-brain/brain-ui";
import {
  CalendarDays,
  Eye,
  Pencil,
  Star,
} from "lucide-react";
import { createContext, useContext, useRef, type CSSProperties } from "react";
import { DangerConfirmButton } from "./danger-confirm";
import { PriorityControl } from "./priority-control";
import { ProjectPicker } from "./project-picker";
import {
  type BoardLane,
} from "./task-actions";
import { TaskBadges } from "./task-badges";
import { TaskCompleteButton } from "./task-complete-button";
import {
  DEFAULT_UI_PREFERENCES,
  translate,
  type UiPreferences,
} from "./ui-preferences";

export type View = "today" | "calendar" | "board" | "projects" | "collections" | "sync";

export type DetailTarget = { key: string; kind: "task" | "project"; id: string };

// Native (Rust) errors arrive over IPC as plain strings (e.g. "Io", "UnsafePath"),
// never as Error instances, so surface whatever we actually received instead of a
// generic fallback code that hides the real cause.
export function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  if (cause != null) {
    try {
      const text = JSON.stringify(cause);
      if (text && text !== "{}" && text !== "null") return text;
    } catch {
      // fall through to the fallback code below
    }
  }
  return fallback;
}

export const VIEW_KEYS: Record<View, string> = {
  today: "view.today",
  calendar: "view.calendar",
  board: "view.board",
  projects: "view.projects",
  collections: "view.collections",
  sync: "view.sync",
};

export const VIEW_TITLE_KEYS: Record<View, string> = {
  today: "view.today.title",
  calendar: "view.calendar.title",
  board: "view.board.title",
  projects: "view.projects.title",
  collections: "view.collections.title",
  sync: "view.sync.title",
};

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export const UiPreferencesContext = createContext<{
  preferences: UiPreferences;
  setPreferences: React.Dispatch<React.SetStateAction<UiPreferences>>;
  t: Translate;
}>({
  preferences: DEFAULT_UI_PREFERENCES,
  setPreferences: () => undefined,
  t: (key, values) => translate(DEFAULT_UI_PREFERENCES.language, key, values),
});

export function useUiPreferences() {
  return useContext(UiPreferencesContext);
}

export const taipeiDateKey = () => dateKeyForTaipei(new Date());

export const getCalendarTaskEntries = (tasks: BrainTaskSnapshot[], today: string) =>
  buildCalendarTaskEntries(
    tasks.filter(
      (task): task is BrainTaskSnapshot & { id: string } => task.id !== null,
    ).map((task) => ({
      ...task,
      taskDate: task.taskDate ?? task.plannedDate ?? task.dueDate ?? null,
    })),
    today,
  );

export function taskLabel(task: Pick<BrainTaskSnapshot, "title">): string {
  return visibleTaskTitle(task.title);
}

export function taskProjectStyle(task: BrainTaskSnapshot): CSSProperties {
  const color = projectColor(task.projectId ?? task.projectName);
  return {
    "--project-accent": color.accent,
    "--project-soft": color.soft,
    "--project-text": color.text,
  } as CSSProperties;
}

export function CompletedVisibilityButton({
  showCompleted,
  onChange,
}: {
  showCompleted: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useUiPreferences();
  return (
    <button
      type="button"
      className={`icon-action ${showCompleted ? "active" : ""}`}
      aria-pressed={showCompleted}
      aria-label={t(showCompleted ? "app.hideCompleted" : "app.showCompleted")}
      title={t(showCompleted ? "app.hideCompleted" : "app.showCompleted")}
      onClick={() => onChange(!showCompleted)}
    >
      <Eye aria-hidden="true" />
    </button>
  );
}

export function TaskActionBar({
  task,
  important,
  onImportant,
  onComplete,
  onEdit,
  onDelete,
  showEdit = true,
  showComplete = true,
}: {
  task: BrainTaskSnapshot;
  important: boolean;
  onImportant: () => void;
  onComplete: () => void;
  onEdit?: () => void;
  onDelete: (task: BrainTaskSnapshot) => void;
  showEdit?: boolean;
  showComplete?: boolean;
}) {
  const { t } = useUiPreferences();
  const done = task.status === "done";
  return (
    <div className="task-action-bar" aria-label={`${task.title} actions`}>
      <button className={`task-action-button ${important ? "active" : ""}`} aria-label={t("task.action.important")} title={t("task.action.important")} onClick={onImportant}>
        <Star aria-hidden="true" fill={important ? "currentColor" : "none"} />
      </button>
      {showComplete && (
        <TaskCompleteButton
          size="lg"
          done={done}
          label={done ? t("task.action.reopen") : t("task.action.complete")}
          onClick={onComplete}
        />
      )}
      {showEdit && <button className="task-action-button" aria-label={t("task.action.edit")} title={t("task.action.edit")} onClick={onEdit}>
        <Pencil aria-hidden="true" />
      </button>}
      <DangerConfirmButton
        className="task-action-button"
        armLabel={t("task.action.delete")}
        confirmLabel={t("confirm.deleteAgain")}
        onConfirm={() => onDelete(task)}
      />
    </div>
  );
}

export function InlineTaskCard({ task, today, projects, onOpen, onPatch, onComplete, onDelete, onPickProject, onCreateProject }: { task: BrainTaskSnapshot; today: string; projects?: BrainProjectSnapshot[]; onOpen: (taskId: string) => void; onPatch: (task: BrainTaskSnapshot, patch: Partial<BrainTaskSnapshot>) => void; onComplete: (task: BrainTaskSnapshot) => void; onDelete: (task: BrainTaskSnapshot) => void; onPickProject?: (taskId: string, project: { id: string | null; name: string } | null) => void; onCreateProject?: (name: string) => Promise<{ id: string; name: string } | null> }) {
  const { t, preferences } = useUiPreferences();
  const overdueDays = task.status !== "done" && task.taskDate && task.taskDate < today ? Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${task.taskDate}T00:00:00Z`)) / 86400000)) : 0;
  const important = task.priority === "highest";
  return <article className={`inline-task-card ${important ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`} tabIndex={0} onClick={() => task.id && onOpen(task.id)} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && task.id) { event.preventDefault(); onOpen(task.id); } }}><TaskCompleteButton done={task.status === "done"} label={task.status === "done" ? `${task.title}重新開啟` : `${task.title}標記完成`} title={task.status === "done" ? "重新開啟" : "完成"} onClick={() => onComplete(task)} /><div className="inline-task-main"><div className="inline-title-row"><PriorityControl priority={task.priority} compact locale={preferences.language} onChange={(priority) => onPatch(task, priority === "highest" ? { priority, taskDate: today } : { priority })} /><strong className="inline-task-title" title={taskLabel(task)}>{taskLabel(task)}</strong><button type="button" className={`row-star ${important ? "active" : ""}`} aria-pressed={important} aria-label={t("task.action.important")} title={t("task.action.important")} onClick={(event) => { event.stopPropagation(); if (task.id) onPatch(task, { priority: important ? "high" : "highest", ...(important ? {} : { taskDate: today }) }); }}><Star aria-hidden="true" fill={important ? "currentColor" : "none"} /></button></div><div className="inline-task-meta"><span className="inline-project-inline">{projects && onPickProject && task.id ? <ProjectPicker variant="compact" projects={projects} valueId={task.projectId} onSelect={(project) => onPickProject(task.id!, project ? { id: project.id, name: project.name } : null)} onCreateProject={onCreateProject} locale={preferences.language} ariaLabel={`${task.title} 專案`} /> : (task.projectName ?? t("app.unassigned"))}{task.startTime ? ` · ${task.startTime}` : ""}</span><TaskBadges task={task} locale={preferences.language} /></div>{overdueDays > 0 && <small className="overdue-label">逾期 {overdueDays} 天 · 原日期 {task.taskDate}</small>}</div><div className="inline-task-actions">{overdueDays > 0 && <button aria-label="移到今天" title="移到今天" onClick={(event) => { event.stopPropagation(); onPatch(task, { taskDate: today }); }}><CalendarDays /></button>}<DangerConfirmButton armLabel="永久刪除" confirmLabel={t("confirm.deleteAgain")} onConfirm={() => onDelete(task)} /></div></article>;
}

export function TaskDateInput({
  value,
  ariaLabel,
  className,
  onCommit,
}: {
  value: string | null;
  ariaLabel: string;
  className?: string;
  onCommit: (next: string | null) => void;
}) {
  const { t } = useUiPreferences();
  const inputRef = useRef<HTMLInputElement>(null);
  const openPicker = (event: { stopPropagation: () => void; currentTarget?: EventTarget | null }) => {
    event.stopPropagation();
    const input = inputRef.current ?? (event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null);
    if (!input) return;
    try {
      (input as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      input.focus();
    }
  };
  return (
    <div
      className={["task-date-field", className].filter(Boolean).join(" ")}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={openPicker}
    >
      <input
        ref={inputRef}
        className="task-date-text"
        aria-label={ariaLabel}
        title={t("task.date.pick")}
        type="date"
        value={value ?? ""}
        onClick={openPicker}
        onChange={(event) => {
          const next = event.target.value || null;
          if (next !== (value ?? null)) onCommit(next);
        }}
      />
    </div>
  );
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function newTask(
  title: string,
  options: {
    taskDate?: string | null;
    startTime?: string | null;
    durationMinutes?: number | null;
    project?: BrainProjectSnapshot;
  } = {},
): BrainTaskSnapshot {
  return {
    schemaVersion: 5,
    id: crypto.randomUUID(),
    title: title.trim(),
    status: "todo",
    taskDate:
      options.taskDate === undefined ? taipeiDateKey() : options.taskDate,
    priority: "normal",
    projectId: options.project?.id ?? null,
    projectName: options.project?.name ?? null,
    rank: rankForIndex(Date.now() % 100000),
    sourcePath: null,
    sourceHeading: null,
    completedAt: null,
    startTime: options.startTime ?? null,
    durationMinutes: options.startTime ? (options.durationMinutes ?? 30) : (options.durationMinutes ?? null),
    timeZone: "Asia/Taipei",
  };
}

export const BOARD_LANE_ORDER: Record<BoardLane, number> = { idea: 0, todo: 1, doing: 2, waiting: 3, done: 4 };

export const BOARD_PRIORITY_ORDER: Record<BrainTaskSnapshot["priority"], number> = {
  highest: 0,
  high: 1,
  medium: 2,
  normal: 3,
  low: 4,
};

export function Empty({ text, hint, actionLabel, onAction }: { text: string; hint?: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="empty">
      <span>{text}</span>
      {hint && <small className="empty-hint">{hint}</small>}
      {actionLabel && onAction && (
        <button className="secondary-button empty-action" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}
